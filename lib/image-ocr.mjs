/**
 * lib/image-ocr.mjs — 图片 OCR（DeepSeek 官方 OCR API）
 * ============================================================================
 * 她的模型没有视觉能力：QQ 收到的图片先识别成文字，再拼进上下文。
 * 配置：~/.dsh/qq-fish/ocr-deepseek.json  {"apiKey":"sk-...","enabled":true}
 *       或环境变量 DEEPSEEK_API_KEY。
 * 计费：每 1000 页 1.5 元（每张图一页），识别失败不计费。
 * 接口：POST https://api.deepseek.com/v1/tools/ocr（multipart: file + purpose）
 * ============================================================================
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OCR_URL = 'https://api.deepseek.com/v1/tools/ocr'
const CFG = () => join(homedir(), '.dsh', 'qq-fish', 'ocr-deepseek.json')

let _key = ''
let _keyAt = 0
async function loadKey() {
  const now = Date.now()
  if (_key && now - _keyAt < 60000) return _key
  let k = process.env.DEEPSEEK_API_KEY || ''
  if (!k) {
    try {
      const j = JSON.parse(await readFile(CFG(), 'utf8'))
      if (j && j.enabled !== false && j.apiKey) k = String(j.apiKey)
    } catch {}
  }
  if (k) { _key = k; _keyAt = now }
  return k
}

async function fetchImageBytes(url, timeoutMs = 20000) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new Error('图片不是 http(s) 直链')
  const res = await fetch(target, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://q.qq.com/' },
  })
  if (!res.ok) throw new Error('图片下载 HTTP ' + res.status)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.byteLength) throw new Error('图片为空')
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error('图片太大')
  const b = buf
  let mediaType = 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) mediaType = 'image/png'
  else if (b[0] === 0x47 && b[1] === 0x49) mediaType = 'image/gif'
  else if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49) mediaType = 'image/webp'
  return { data: buf, mediaType }
}

/**
 * 下载 QQ 图片并 OCR。返回 { ok, text, pages } 或 { ok:false, error }。
 * 失败不抛异常，调用方回退成 [图片]。
 */
export async function ocrImageFromUrl(url, { timeoutMs = 30000 } = {}) {
  const key = await loadKey()
  if (!key) return { ok: false, error: '没配 DeepSeek key（ocr-deepseek.json 或 DEEPSEEK_API_KEY）' }
  let img = null
  try { img = await fetchImageBytes(url) } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 120) } }
  try {
    const form = new FormData()
    form.append('purpose', 'text_recognition')
    const ext = String(img.mediaType || 'image/jpeg').split('/')[1] || 'jpg'
    form.append('file', new Blob([img.data], { type: img.mediaType }), 'qq-image.' + ext)
    const res = await fetch(OCR_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await res.json().catch(() => null)
    if (j && j.error) return { ok: false, error: String(j.error.message || j.error).slice(0, 160) }
    if (!res.ok) return { ok: false, error: 'OCR HTTP ' + res.status }
    const pages = Array.isArray(j && j.pages) ? j.pages : []
    const text = pages.map((p) => String(p.text || '')).join('\n').replace(/<｜[^｜]*｜>/g, '').trim()
    if (!text) return { ok: false, error: '图里没识别出文字' }
    return { ok: true, text: text.slice(0, 800), pages: pages.length || 1 }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}
