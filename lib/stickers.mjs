/**
 * 表情包仓库：收藏（收到的图自动存）、挑选、本地文件读取。
 * 只存 $DSH_HOME/qq-fish/stickers/，不外传。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stickerDir() {
  const dir = join(dshHome(), 'qq-fish', 'stickers')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

function indexPath() {
  return join(stickerDir(), 'index.json')
}

export function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
    return { stickers: Array.isArray(raw.stickers) ? raw.stickers : [] }
  } catch {
    return { stickers: [] }
  }
}

function saveIndex(idx) {
  try { fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2)) } catch {}
}

function guessExt(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return '.png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF') return '.gif'
  if (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp'
  return '.png'
}

/** 从 URL 下载并收藏一张表情包；返回文件名或 null */
/** 读图片宽高（只看 GIF/PNG/JPEG 头部，够筛「截图 vs 表情」了） */
function imageSize(buf) {
  try {
    if (buf.slice(0, 3).toString('latin1') === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue }
        const m = buf[i + 1]
        if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
        const len = buf.readUInt16BE(i + 2)
        if (!len) break
        i += 2 + len
      }
    }
  } catch {}
  return null
}

export async function saveStickerFromUrl(url, meta = {}) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return null
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200 || buf.length > 8 * 1024 * 1024) return null
    // 【收藏筛选】只有真表情才收：GIF 一律收；静态图必须小（<300KB），大图/照片/截图不收
    if (meta.onlySticker) {
      const isGif = buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF'
      if (isGif) {
        // 超过 1.5MB 的 GIF 多半是录屏/动图，不是表情
        if (buf.length > 1.5 * 1024 * 1024) return null
      } else {
        // 静态图必须又小又方：面板截图、照片一律不收
        const dim = imageSize(buf)
        const small = dim && dim.w <= 400 && dim.h <= 400
        if (!small || buf.length > 120 * 1024) return null
      }
    }
    const hash = createHash('md5').update(buf).digest('hex').slice(0, 16)
    const ext = guessExt(buf)
    const name = hash + ext
    const file = join(stickerDir(), name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
    const idx = loadIndex()
    if (!idx.stickers.some((s) => s.file === name)) {
      idx.stickers.push({
        file: name,
        size: buf.length,
        savedAt: Date.now(),
        from: String(meta.from || '').slice(0, 40),
        channel: String(meta.channel || ''),
        tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 8) : [],
      })
      // 只保留最近 500 张
      if (idx.stickers.length > 500) idx.stickers = idx.stickers.slice(-500)
      saveIndex(idx)
    }
    return name
  } catch {
    return null
  }
}

/** 已经下载好的图直接入库（engine 判断完类型再调这里） */
export function saveStickerFromBuffer(buf, meta = {}) {
  try {
    if (!buf || buf.length < 200 || buf.length > 8 * 1024 * 1024) return null
    const hash = createHash('md5').update(buf).digest('hex').slice(0, 16)
    const ext = guessExt(buf)
    const name = hash + ext
    const file = join(stickerDir(), name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
    const idx = loadIndex()
    if (!idx.stickers.some((s) => s.file === name)) {
      idx.stickers.push({
        file: name,
        size: buf.length,
        savedAt: Date.now(),
        from: String(meta.from || '').slice(0, 40),
        channel: String(meta.channel || ''),
        tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 8) : [],
      })
      if (idx.stickers.length > 500) idx.stickers = idx.stickers.slice(-500)
      saveIndex(idx)
    }
    return name
  } catch {
    return null
  }
}

export function listStickers() {
  return loadIndex().stickers || []
}

// 【发图尺寸】QQ 没有"表情"消息类型，1.7MB 的大图会被客户端当图片拉伸满屏。
// 发之前缩到 300px（可关），缩过的存 .thumbs/ 复用；GIF 保持原样不缩（动画会丢）。
let _maxPx = Number(process.env.STICKER_MAX_PX || 300)
export function setStickerMaxPx(n) { _maxPx = Number(n) || 0 }
export function stickerMaxPx() { return _maxPx }

function makeThumbSync(src, dst, maxPx) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(" + maxPx + ",iw)':-2", '-q:v', '3', dst], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
    return fs.existsSync(dst) && fs.statSync(dst).size > 0
  } catch {
    return false
  }
}

/** 读成 base64（给 NapCat 的 base64:// 用）；大图自动缩到 maxPx */
export function stickerBase64(file, opts = {}) {
  const p = join(stickerDir(), String(file || ''))
  if (!fs.existsSync(p)) return ''
  const maxPx = opts.maxPx != null ? Number(opts.maxPx) : _maxPx
  try {
    const st = fs.statSync(p)
    const isGif = /\.gif$/i.test(p)
    if (maxPx > 0 && !isGif && st.size > 120 * 1024) {
      const dir = join(stickerDir(), '.thumbs')
      fs.mkdirSync(dir, { recursive: true })
      const key = String(file).replace(/[\\/]/g, '_').replace(/\.[^.]+$/, '') + '_' + maxPx + '.jpg'
      const dst = join(dir, key)
      if (!fs.existsSync(dst)) makeThumbSync(p, dst, maxPx)
      if (fs.existsSync(dst)) return 'base64://' + fs.readFileSync(dst).toString('base64')
    }
  } catch {}
  try {
    return 'base64://' + fs.readFileSync(p).toString('base64')
  } catch {
    return ''
  }
}

/** 按关键词挑一张（匹配 tags / from / 文件名） */
export function pickStickerByKeyword(keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  const all = listStickers()
  if (!all.length) return null
  if (!kw) return all[all.length - 1]
  const hit = all.find((s) => {
    // 按文件名、OCR 读出的图上文字、标签匹配；上传者昵称不是表情含义，别拿它当关键词
    const hay = [s.file, s.desc || '', ...(s.tags || [])].join(' ').toLowerCase()
    return hay.includes(kw)
  })
  return hit || null
}

/** 给提示词用的简要清单（最近 N 张） */
export function stickerCatalog(limit = 40) {
  // 本尊那几张在最前面，不能被「最近 N 张」截掉
  const all = listStickers()
  if (!all.length) return ''
  // 这个库里大多是哈希文件名的斗图，没有语义标签；
  // 只有「本尊」那几张文件名有意义（她本人的样子），其余交给 nekowhale 大图库按情绪挑。
  const own = []
  for (const s of all) {
    const tags = Array.isArray(s.tags) ? s.tags : []
    // 只认用户手动打的「本尊」：他把标记关掉，这里就一张都不列
    const isOwn = tags.includes('本尊')
    if (isOwn && s.file && !own.includes(s.file)) own.push(s.file)
  }
  if (!own.length) return ''
  return '本尊（她本人的样子，优先用）：' + own.slice(0, 8).join('、') + '\n写法：[[sticker:文件名]]'
}

// ══════════════════════════════════════════════════════════════════════
// 包管理 / 使用统计（借鉴 AstrBot 的 meme_manager）
// ══════════════════════════════════════════════════════════════════════

/** 按包分组统计 */
export function listPacks() {
  const all = listStickers()
  const map = new Map()
  for (const s of all) {
    const pack = String(s.pack || '未分组')
    const item = map.get(pack) || { pack, count: 0, uses: 0, bytes: 0 }
    item.count += 1
    item.uses += Number(s.uses) || 0
    item.bytes += Number(s.size) || 0
    map.set(pack, item)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

/** 按包过滤 */
export function listStickersInPack(pack) {
  const want = String(pack || '').trim()
  const all = listStickers()
  if (!want) return all
  return all.filter((s) => String(s.pack || '未分组') === want)
}

/** 记一次使用（用于「常用表情」排序） */
export function bumpStickerUse(file) {
  const name = String(file || '').trim()
  if (!name) return false
  const idx = loadIndex()
  const hit = idx.stickers.find((s) => s.file === name)
  if (!hit) return false
  hit.uses = (Number(hit.uses) || 0) + 1
  hit.lastUsedAt = Date.now()
  saveIndex(idx)
  return true
}

/** 最常用的 N 张 */
export function topStickers(limit = 10) {
  return listStickers()
    .filter((s) => Number(s.uses) > 0)
    .sort((a, b) => (Number(b.uses) || 0) - (Number(a.uses) || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
}

/** 跨库去重：按 size 分组，同尺寸再比文件内容 md5 */
export function findDuplicates() {
  const all = listStickers()
  const bySize = new Map()
  for (const s of all) {
    const k = Number(s.size) || 0
    if (!k) continue
    if (!bySize.has(k)) bySize.set(k, [])
    bySize.get(k).push(s)
  }
  const dups = []
  for (const [size, group] of bySize) {
    if (group.length < 2) continue
    const byHash = new Map()
    for (const s of group) {
      try {
        const buf = fs.readFileSync(join(stickerDir(), s.file))
        const h = createHash('md5').update(buf).digest('hex')
        if (!byHash.has(h)) byHash.set(h, [])
        byHash.get(h).push(s)
      } catch {}
    }
    for (const [, same] of byHash) {
      if (same.length > 1) dups.push({ size, files: same.map((x) => x.file) })
    }
  }
  return dups
}
