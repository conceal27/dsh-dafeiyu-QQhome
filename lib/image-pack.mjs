/**
 * lib/image-pack.mjs — 把多条图片拼成一张网格图，省视觉 token
 * ============================================================================
 * 为什么：模型看图按「一张图」算钱（800×450 约 233 token）。一次来 3 张
 * 就是 3 份钱；拼成一张 800×600 的九宫格只花 1 份。
 *
 * 长截图例外：长图（高/宽 > 2.2）拼进格子会糊成一片，所以**不拼**，
 * 由调用方单独发原图；短图（表情包/照片/普通截图）才拼。
 *
 * 实现：只依赖 ffmpeg（旧机 / 多数 Linux 自带），不依赖 sharp。
 *   没有 ffmpeg 或拼图失败 → 返回 null，调用方逐张发，功能不受影响。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** ffmpeg 可用性缓存（避免每次拼图都探测） */
let ffmpegOk = null
export async function hasFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 })
    ffmpegOk = true
  } catch {
    ffmpegOk = false
  }
  return ffmpegOk
}

/**
 * 纯 JS 读图片宽高（不 spawn 进程）。支持 PNG / JPEG / GIF / WebP。
 * @param {Buffer|Uint8Array} input
 * @returns {{width:number,height:number}|null}
 */
export function imageSize(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (!b || b.length < 12) return null
  // PNG: IHDR 在 16..24
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  // GIF: 逻辑屏幕描述符
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  // JPEG: 扫描 SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      }
      if (len < 2) break
      i += 2 + len
    }
    return null
  }
  // WebP
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = b.toString('ascii', 12, 16)
    if (fmt === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
    if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (fmt === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

/**
 * 这张图适不适合拼进格子：
 *   - 读不出尺寸 → 保守起见先当可拼（ffmpeg 会按比例装）
 *   - 高/宽 > 2.2（长截图）或 < 0.35（超宽图）→ 不拼，单独发
 *   - 单边超过 4096 → 不拼（太大，拼图会糊）
 */
export function isPackable(input) {
  const sz = imageSize(input)
  if (!sz || !sz.width || !sz.height) return true
  const ratio = sz.height / sz.width
  if (ratio > 2.2 || ratio < 0.35) return false
  if (sz.width > 4096 || sz.height > 4096) return false
  return true
}

function extOf(mediaType) {
  const m = String(mediaType || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.jpg'
}

/**
 * 把多张图拼成一张网格图（内部会跳过不适合拼的长图，调用方也可先自行筛选）。
 * @param {Array<{data:Buffer|Uint8Array, mediaType?:string}>} items
 * @param {{cellW?:number, cellH?:number, timeoutMs?:number}} [options]
 * @returns {Promise<{data:Uint8Array, mediaType:'image/png', meta:object}|null>}
 */
export async function packImagesToSheet(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.data && x.data.byteLength)
  if (list.length < 2) return null
  if (!(await hasFfmpeg())) return null

  const cellW = Math.max(160, Math.round(options.cellW || 400))
  const cellH = Math.max(120, Math.round(options.cellH || 300))
  const cols = list.length <= 2 ? list.length : Math.ceil(Math.sqrt(list.length))
  const rows = Math.ceil(list.length / cols)
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'fish-pack-'))
    const files = list.map((it, i) => {
      const p = join(dir, 'in' + i + extOf(it.mediaType))
      writeFileSync(p, Buffer.from(it.data))
      return p
    })
    const out = join(dir, 'sheet.png')
    const args = []
    for (const f of files) args.push('-i', f)
    const filters = []
    files.forEach((_, i) => {
      filters.push(
        '[' + i + ':v]scale=' + cellW + ':' + cellH + ':force_original_aspect_ratio=decrease,' +
        'pad=' + cellW + ':' + cellH + ':(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,' +
        'format=rgba[v' + i + ']',
      )
    })
    const layout = files.map((_, i) => (i % cols) * cellW + '_' + Math.floor(i / cols) * cellH)
    filters.push(
      files.map((_, i) => '[v' + i + ']').join('') +
      'xstack=inputs=' + files.length + ':layout=' + layout.join('|') + ':fill=white[out]',
    )
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-y', out)
    await execFileAsync('ffmpeg', args, { timeout: Math.max(8000, Number(options.timeoutMs) || 25000) })
    const buf = readFileSync(out)
    if (!buf || !buf.length) return null
    return {
      data: new Uint8Array(buf),
      mediaType: 'image/png',
      meta: { count: list.length, cols, rows, cellW, cellH, bytes: buf.length },
    }
  } catch {
    return null
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}
