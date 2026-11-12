/**
 * lib/napcat-local.mjs — 从 NapCat 本机缓存里找"刚收到的图"
 * ============================================================================
 * 为什么需要它：QQ 图片段给的是 gchat.qpic.cn/download?fileid=… 直链，可这台机器
 * 所在的网络访问 gchat.qpic.cn 直接连不上（curl http=000，DSH 的 SSRF 校验还会先
 * 报 EAI_AGAIN），所以靠 URL 下载永远拿不到图。
 * 但 NapCat 在收消息时已经把原图写进了 nt_data 目录，文件名就是段里的 file 字段。
 * 这里按文件名去本地找，读到就零网络拿到图。
 * ============================================================================
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOMES = [...new Set([process.env.HOME, homedir()].filter(Boolean))]
const ROOTS = []
for (const h of HOMES) {
  ROOTS.push(join(h, '.config/QQ'))
  ROOTS.push(join(h, 'napcat/QQ'))
  ROOTS.push(join(h, 'napcat/.config/QQ'))
}

const IMG_RE = /^[0-9a-z][0-9a-z_-]{7,}\.(jpg|jpeg|png|gif|webp|bmp)$/i

let cache = { at: 0, map: new Map() }

function walk(dir, depth, map) {
  if (depth < 0) return
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walk(p, depth - 1, map)
    } else {
      const low = e.name.toLowerCase()
      if (!IMG_RE.test(low)) continue
      const ori = /[\\/]Ori[\\/]/.test(p) || /[\\/]origin/i.test(p)
      const prev = map.get(low)
      if (!prev || (ori && !prev.ori)) {
        try { map.set(low, { path: p, ori, size: statSync(p).size }) } catch {}
      }
    }
  }
}

/** 重建索引（60 秒内复用） */
function index() {
  if (Date.now() - cache.at < 60000 && cache.map.size) return cache.map
  const map = new Map()
  for (const root of ROOTS) {
    let nts = []
    try {
      nts = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^(nt_qq|nt_qq_)/i.test(d.name))
        .map((d) => join(root, d.name, 'nt_data'))
    } catch { continue }
    for (const nt of nts) {
      for (const sub of ['Pic', 'Emoji', 'File']) walk(join(nt, sub), 4, map)
    }
  }
  cache = { at: Date.now(), map }
  return map
}

/**
 * 按 NapCat 段里的 file 字段找本地原图。
 * @param {string} file 例如 "20D4A6B601B1CD8BF77BB2C4DF749FCE.jpg"
 * @returns {string|null} 本地绝对路径
 */
export function findNapcatImage(file) {
  try {
    const base = String(file || '').replace(/^.*[\\/]/, '').toLowerCase()
    if (!base || !IMG_RE.test(base)) return null
    const hit = index().get(base)
    return hit ? hit.path : null
  } catch {
    return null
  }
}

/** 索引规模（诊断用） */
export function napcatIndexSize() {
  try { return index().size } catch { return 0 }
}
