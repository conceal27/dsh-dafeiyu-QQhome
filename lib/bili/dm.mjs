/**
 * lib/bili/dm.mjs — 用她的小号给主人发 B 站私信
 * ============================================================================
 * 坑（邦邦踩过，我们复现过）：
 *   · 必须带 msg[msg_status]、msg[timestamp]
 *   · dev_id 必须稳定（从 buvid3 推导），每次随机会被风控盯
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

function biliDir(home) {
  return path.join(home || os.homedir(), '.dsh', 'qq-fish', 'bili')
}
function loadCred(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(biliDir(home), 'credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 稳定 dev_id（同一账号不变） */
function devIdOf(cred) {
  const raw = String((cred && cred.buvid3) || '')
  const uuid = raw.replace(/infoc$/, '')
  if (/^[0-9a-f-]{20,}$/i.test(uuid)) return uuid
  return '00000000-0000-4000-8000-000000000000'
}

/** 发一条文本私信；返回 { ok, msgKey } 或 { ok:false, error } */
export async function sendDm(home, toMid, text) {
  const cred = loadCred(home)
  if (!cred || !cred.sessdata) return { ok: false, error: 'B 站未登录' }
  const cookie = 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3
  const content = String(text || '').trim().slice(0, 500)
  if (!content) return { ok: false, error: '内容为空' }
  try {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { cookie, 'user-agent': UA },
      signal: AbortSignal.timeout(15000),
    })).json()
    if (!nav.data || !nav.data.isLogin) return { ok: false, error: 'B 站 cookie 失效，需要重新扫码' }
    const me = nav.data.mid
    if (String(me) === String(toMid)) return { ok: false, error: '不能给自己发私信' }
    const body = new URLSearchParams({
      'msg[sender_uid]': String(me),
      'msg[receiver_id]': String(toMid),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[dev_id]': devIdOf(cred),
      'msg[content]': JSON.stringify({ content }),
      'csrf': cred.bili_jct,
    })
    const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, referer: 'https://message.bilibili.com/' },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json()
    if (j.code === 0) return { ok: true, msgKey: j.data && j.data.msg_key }
    return { ok: false, error: (j.message || 'code ' + j.code) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
