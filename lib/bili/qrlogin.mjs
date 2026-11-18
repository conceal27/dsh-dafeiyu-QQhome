/**
 * lib/bili/qrlogin.mjs — B 站扫码登录（给「她」一个专属 B 站号）
 * ============================================================================
 * 流程：generate() 拿二维码 → 用户用 B 站 App 扫 → poll() 轮询 → 成功后把
 * SESSDATA / bili_jct / buvid3 等写进 credentials.json（和现有 bili/client 共用）。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import QRCode from 'qrcode'

const PASSPORT = 'https://passport.bilibili.com'
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

function biliDir(home) {
  return path.join(home, '.dsh', 'qq-fish', 'bili')
}

function hostOf(home) {
  return home || os.homedir()
}

/** 生成二维码（返回 dataUrl 给面板显示） */
export async function generateQr(home) {
  try {
    const r = await fetch(PASSPORT + '/x/passport-login/web/qrcode/generate', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    })
    const j = await r.json()
    if (j.code !== 0) return { ok: false, error: j.message || ('code ' + j.code) }
    const dataUrl = await QRCode.toDataURL(j.data.url, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
    return { ok: true, key: j.data.qrcode_key, dataUrl }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 轮询扫码状态；成功时把 cookie 写盘 */
export async function pollQr(home, key) {
  if (!key) return { ok: false, error: '缺少 qrcode_key' }
  try {
    const r = await fetch(PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    })
    const j = await r.json()
    if (j.code !== 0) return { ok: false, error: j.message || ('code ' + j.code) }
    const d = j.data || {}
    // 0=成功 86090=已扫待确认 86101=未扫码 86038=过期
    if (d.code === 0) {
      const cookies = {}
      const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
      for (const c of list) {
        const m = String(c).match(/^([^=]+)=([^;]*)/)
        if (m) cookies[m[1]] = m[2]
      }
      // 兜底：成功回调 url 里也带着参数
      try {
        const u = new URL(d.url || '')
        for (const [k, v] of u.searchParams) if (!cookies[k]) cookies[k] = v
      } catch {}
      const saved = saveCredentials(hostOf(home), cookies)
      return { ok: true, status: 'ok', saved, cookies: Object.keys(cookies) }
    }
    return {
      ok: true,
      status: d.code === 86090 ? 'scanned' : d.code === 86101 ? 'waiting' : 'expired',
      message: d.message || '',
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 写 credentials.json（和 bili/client.mjs 的 loadAuth 同一路径格式） */
export function saveCredentials(home, cookies) {
  try {
    const dir = biliDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'credentials.json')
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch {}
    const map = {
      SESSDATA: 'sessdata',
      bili_jct: 'bili_jct',
      buvid3: 'buvid3',
      buvid4: 'buvid4',
      DedeUserID: 'dedeuserid',
      DedeUserID__ckMd5: 'dedeuserid__ckmd5',
    }
    for (const [name, key] of Object.entries(map)) {
      const v = cookies[name] || cookies[key]
      if (v) cur[key] = v
    }
    cur.savedAt = Date.now()
    fs.writeFileSync(file, JSON.stringify(cur, null, 2))
    return true
  } catch {
    return false
  }
}

/** 是否已登录（读 credentials.json） */
export function loginState(home) {
  try {
    const file = path.join(biliDir(hostOf(home)), 'credentials.json')
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ok: true, loggedIn: !!(cur && cur.sessdata), savedAt: Number(cur && cur.savedAt) || 0 }
  } catch {
    return { ok: true, loggedIn: false, savedAt: 0 }
  }
}
