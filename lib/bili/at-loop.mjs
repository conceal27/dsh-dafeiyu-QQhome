/**
 * lib/bili/at-loop.mjs — 有人在 B 站 @ 她，她能看见并回
 * ============================================================================
 * reply-loop 只能接「她评论下面的回复」；如果主人在别的视频评论里直接
 * 「@她自己的昵称 …」，那条不挂在她评论下面，她永远看不到。
 * 这里走 B 站消息中心的 @ 我的（/x/msgfeed/at），把新的 @ 接上并回。
 *
 * 状态：$DSH_HOME/qq-fish/bili/at-state.json  { answered:[{id,at}] , lastCheck }
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateText } from '../llm.mjs'
import { cleanReply, parseSkip, systemPrompt } from '../persona.mjs'
import { postReply } from './comment.mjs'
import { loadAuth } from './client.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

function biliDir(home) { return path.join(home || os.homedir(), '.dsh', 'qq-fish', 'bili') }
export function atStatePath(home) { return path.join(biliDir(home), 'at-state.json') }

function loadState(home) {
  try { return JSON.parse(fs.readFileSync(atStatePath(home), 'utf8')) } catch { return { answered: [], lastCheck: 0 } }
}
function saveState(home, st) {
  try {
    fs.mkdirSync(biliDir(home), { recursive: true })
    fs.writeFileSync(atStatePath(home), JSON.stringify({ answered: (st.answered || []).slice(-300), lastCheck: st.lastCheck || Date.now() }, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

async function fetchAtFeed(home) {
  const acc = loadAuth(home)
  if (!acc || !acc.cookie) return { ok: false, error: 'B 站未登录' }
  try {
    const r = await fetch('https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web', {
      headers: { cookie: acc.cookie, 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json()
    if (j.code !== 0) return { ok: false, error: 'code=' + j.code }
    const items = ((j.data && j.data.items) || []).map((it) => ({
      id: String(it.id || ''),
      at: Number(it.at_time || 0) * 1000,
      mid: String((it.user && it.user.mid) || ''),
      user: String((it.user && it.user.nickname) || ''),
      text: String((it.item && it.item.source_content) || '').slice(0, 300),
      title: String((it.item && it.item.title) || '').slice(0, 60),
      aid: String((it.item && it.item.subject_id) || ''),
      sourceId: String((it.item && it.item.source_id) || ''),
      rootId: String((it.item && it.item.root_id) || '0'),
      type: String((it.item && it.item.type) || ''),
      uri: String((it.item && it.item.uri) || ''),
    }))
    return { ok: true, items }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function timeText(date = new Date()) {
  const h = date.getHours()
  const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  return `${emoji} ${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function atPrompt(it, t, selfName = '') {
  const raw = String(it.text || '')
  // 别人 @ 她时句子里会带上她自己的昵称；那句「@谁」要剥掉，不然她会接着复读
  const name = String(selfName || '').trim()
  const said = name ? raw.split('@' + name).join('').trim() : raw.trim()
  return [
    `现在是 ${t}。有人在 B 站评论区 @ 了你。`,
    it.title ? '视频：《' + it.title + '》' : '',
    `${it.user} 说：「${said}」`,
    '你就着他这句回一句。要求：',
    '· 40 字以内，口语，像评论区接话',
    '· 别提「QQ」「主人」，不用再写 @ 谁',
    '· 纯文字，不要表情包/图片标记',
    '· 不想接就只输出 [skip]',
  ].filter(Boolean).join('\n')
}

/**
 * @returns {Promise<{ok:boolean, replied?:boolean, count?:number, text?:string, dry?:boolean, error?:string}>}
 */
export async function runAtLoop(ctx, config, log, { dry = false, home = os.homedir() } = {}) {
  if (config.biliAtReplyEnabled === false) return { ok: true, skipped: true, reason: '关掉了 @ 回复' }
  const feed = await fetchAtFeed(home)
  if (!feed.ok) return feed
  const ownerMid = String(config.ownerBiliMid || '').trim()
  const st = loadState(home)
  const answered = new Set((st.answered || []).map((x) => String(x.id)))
  const fresh = feed.items.filter((it) => (ownerMid ? it.mid === ownerMid : true) && !answered.has(it.id) && it.aid && it.sourceId)
  if (!fresh.length) {
    st.lastCheck = Date.now()
    saveState(home, st)
    return { ok: true, skipped: true, reason: '没有新的 @' }
  }
  // 太旧的 @ 不补回（第一次上线时消息中心里全是历史 @，别一条条翻旧账）
  const ageMs = Math.max(1, Math.min(72, Number(config.biliAtReplyMaxAgeHours) || 6)) * 3600_000
  const now = Date.now()
  const stale = fresh.filter((it) => it.at && now - it.at > ageMs)
  if (stale.length) {
    for (const it of stale) st.answered.push({ id: it.id, at: now, skipped: 'stale' })
    saveState(home, st)
  }
  const live = fresh.filter((it) => !(it.at && now - it.at > ageMs))
  if (!live.length) return { ok: true, skipped: true, reason: '没有新的 @（' + stale.length + ' 条太旧，已跳过）' }
  const maxPerTick = Math.max(1, Math.min(4, Number(config.biliAtReplyMaxPerTick) || 2))
  const pick = live.slice(0, maxPerTick).reverse() // 从早到晚
  let done = 0
  let lastText = ''
  for (const it of pick) {
    const system = systemPrompt(config, { channel: 'push', personaOverride: String(config.personaOwner || '').trim() })
    const result = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: atPrompt(it, timeText(), config.selfBiliName || config.personaName) }],
      config,
      timeoutMs: 45_000,
      log,
    })
    if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
    const text = cleanReply(parseSkip(result.text), 150)
    if (!text) {
      st.answered.push({ id: it.id, at: Date.now(), skipped: true })
      saveState(home, st)
      continue
    }
    if (dry) return { ok: true, dry: true, text, from: it.user, said: it.text, video: it.title }
    const root = it.rootId && it.rootId !== '0' ? it.rootId : it.sourceId
    const r = await postReply(home, it.aid, root, it.sourceId, text)
    if (!r.ok) return { ok: false, error: r.error || '回复失败', text }
    st.answered.push({ id: it.id, at: Date.now(), rpid: r.rpid, target: it.sourceId })
    saveState(home, st)
    done += 1
    lastText = text
    if (log && log.info) log.info('[B站] 回了 @ 我的 ' + it.user + '：' + text.slice(0, 40))
  }
  return { ok: true, replied: done > 0, count: done, text: lastText }
}

export function atState(home = os.homedir()) { return loadState(home) }
