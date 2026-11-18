/**
 * lib/bili/dm-chat.mjs — B 站私信对话（对齐 AstrBot bilibili_ai_bot 的 ENABLE_PRIVATE_MESSAGES）
 * ============================================================================
 * AstrBot 那边她能在 B 站私信里跟主人聊（scope=owner、轮询、自动回、能顺手看视频分享）。
 * 迁过来时只迁了「发私信」（dm.mjs），「收私信并回」这一半没有 —— 这里补上。
 *
 * 数据文件：$DSH_HOME/qq-fish/bili/dm-state.json
 *   { lastSeenTs, lastReplyAt, today:{date,count} }
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateText } from '../llm.mjs'
import { cleanReply, parseSkip, systemPrompt } from '../persona.mjs'
import { sendDm } from './dm.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export function biliDir(home) { return path.join(home || os.homedir(), '.dsh', 'qq-fish', 'bili') }
export function dmStatePath(home) { return path.join(biliDir(home), 'dm-state.json') }

function loadCred(home) {
  try { return JSON.parse(fs.readFileSync(path.join(biliDir(home), 'credentials.json'), 'utf8')) } catch { return null }
}

function loadState(home) {
  try { return JSON.parse(fs.readFileSync(dmStatePath(home), 'utf8')) } catch { return { lastSeenTs: 0, lastReplyAt: 0, today: { date: '', count: 0 } } }
}
function saveState(home, st) {
  try {
    fs.mkdirSync(biliDir(home), { recursive: true })
    fs.writeFileSync(dmStatePath(home), JSON.stringify(st, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

async function getJson(url, cookie) {
  try {
    const r = await fetch(url, {
      headers: { cookie, 'user-agent': UA, referer: 'https://message.bilibili.com/' },
      signal: AbortSignal.timeout(20000),
    })
    return await r.json()
  } catch (e) { return { code: -1, message: String((e && e.message) || e) } }
}

/** 拉最近会话（只用来判断有没有新消息，不回复非主人） */
export async function listSessions(home) {
  const cred = loadCred(home)
  if (!cred || !cred.sessdata) return { ok: false, error: 'B 站未登录' }
  const cookie = 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3
  const j = await getJson('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&size=20&end_duration=0&build=0&mobi_app=web', cookie)
  if (j.code !== 0) return { ok: false, error: j.message || ('code ' + j.code) }
  const list = ((j.data && j.data.session_list) || []).map((s) => ({
    talkerId: String(s.talker_id || ''),
    unread: Number(s.unread_count || 0),
    ts: Number(s.session_ts || 0),
    last: String((s.last_msg && (s.last_msg.content || s.last_msg.text)) || '').slice(0, 120),
  }))
  return { ok: true, items: list }
}

/** 拉和某个人的私信记录（时间正序） */
export async function fetchMessages(home, talkerId, size = 20) {
  const cred = loadCred(home)
  if (!cred || !cred.sessdata) return { ok: false, error: 'B 站未登录' }
  const cookie = 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3
  const j = await getJson(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${encodeURIComponent(talkerId)}&session_type=1&size=${Math.max(1, Math.min(50, size))}&build=0&mobi_app=web`, cookie)
  if (j.code !== 0) return { ok: false, error: j.message || ('code ' + j.code) }
  const list = ((j.data && j.data.messages) || []).slice().reverse().map((m) => {
    let text = String(m.content || '')
    try {
      const o = JSON.parse(text)
      text = String(o.content || o.text || o.title || text)
    } catch {}
    return { key: String(m.msg_key || ''), from: String(m.sender_uid || ''), ts: Number(m.timestamp || 0), text }
  })
  return { ok: true, messages: list }
}

function dmPrompt(history, t) {
  const lines = history.map((m) => (m.mine ? '她：' : '主人：') + String(m.text).replace(/\s+/g, ' ').slice(0, 200))
  return [
    `现在是 ${t}，你在 B 站私信里跟主人聊天（不是在 QQ 里）。`,
    '下面是最近的对话（她=你自己，主人=他）：',
    '---',
    lines.join('\n'),
    '---',
    '就着他最后说的话回一句。要求：',
    '· 像平常聊天，一两句话，别铺陈，别复述他说过的话',
    '· 不要提「QQ」「微信」这些别的渠道，你们现在就在 B 站私信',
    '· 不要写表情包/图片标记，纯文字',
    '· 没什么想说的就只输出 [skip]',
  ].join('\n')
}

async function ask(ctx, config, log, prompt) {
  const system = systemPrompt(config, { channel: 'push', personaOverride: String(config.personaOwner || '').trim() })
  const result = await generateText(ctx, {
    system,
    messages: [{ role: 'user', text: prompt }],
    config,
    timeoutMs: 45_000,
    log,
  })
  if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
  const text = cleanReply(parseSkip(result.text), config)
  return text ? { ok: true, text } : { ok: true, skipped: true }
}

/**
 * 检查主人的 B 站私信并回一条。
 * @returns {Promise<{ok:boolean, skipped?:boolean, replied?:boolean, text?:string, newCount?:number, error?:string}>}
 */
export async function runDmReply(ctx, config, log, { dry = false, home = os.homedir() } = {}) {
  if (config.biliDmReply === false) return { ok: true, skipped: true, reason: '关掉了 B 站私信回复' }
  const ownerMid = String(config.ownerBiliMid || '').trim()
  if (!ownerMid) return { ok: false, error: '没配主人 B 站 UID（ownerBiliMid）' }
  const fetch = await fetchMessages(home, ownerMid, 20)
  if (!fetch.ok) return fetch
  const st = loadState(home)
  const today = new Date().toISOString().slice(0, 10)
  if (st.today && st.today.date !== today) st.today = { date: today, count: 0 }
  const maxPerPoll = Math.max(1, Math.min(5, Number(config.biliDmMaxPerPoll) || 3))
  const maxPerDay = Math.max(0, Math.min(50, Number(config.biliDmMaxPerDay ?? 20)))
  if (st.today.count >= maxPerDay) return { ok: true, skipped: true, reason: '今天 B 站私信回够数了' }

  const fresh = fetch.messages.filter((m) => m.from === ownerMid && m.ts * 1000 > Number(st.lastSeenTs || 0))
  if (!fresh.length) return { ok: true, skipped: true, reason: '没有新私信' }
  const pick = fresh.slice(-maxPerPoll)
  const lastTs = pick[pick.length - 1].ts * 1000

  // 只把「已经看过的 + 新来的」拼成上下文，标明谁说的
  const selfMid = (loadCred(home) || {}).dedeuserid || ''
  const history = fetch.messages
    .filter((m) => m.ts * 1000 <= lastTs)
    .slice(-12)
    .map((m) => ({ mine: String(m.from) === String(selfMid), text: m.text }))

  const t = (() => {
    const d = new Date()
    const h = d.getHours()
    const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
    return `${emoji} ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })()

  const gen = await ask(ctx, config, log, dmPrompt(history, t))
  if (!gen.ok) return gen
  if (gen.skipped) {
    if (!dry) { st.lastSeenTs = lastTs; saveState(home, st) }
    return { ok: true, skipped: true, reason: '她觉得这句不用回', newCount: pick.length }
  }
  if (dry) return { ok: true, dry: true, text: gen.text, newCount: pick.length }

  const sent = await sendDm(home, ownerMid, gen.text.slice(0, 500))
  if (!sent.ok) return { ok: false, error: sent.error, text: gen.text }
  st.lastSeenTs = lastTs
  st.lastReplyAt = Date.now()
  st.today.count = Number(st.today.count || 0) + 1
  saveState(home, st)
  try {
    fs.appendFileSync(path.join(biliDir(home), 'dm-log.jsonl'), JSON.stringify({
      at: Date.now(), to: ownerMid, newCount: pick.length, text: gen.text,
    }) + '\n')
  } catch {}
  if (log && log.info) log.info('[B站] 私信回了主人：' + String(gen.text).replace(/\s+/g, ' ').slice(0, 40))
  return { ok: true, replied: true, text: gen.text, newCount: pick.length }
}

export function dmState(home = os.homedir()) {
  return loadState(home)
}
