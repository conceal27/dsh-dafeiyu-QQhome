/**
 * lib/bili/summary.mjs — B 站日报 / 周报（对齐 AstrBot bilibili_ai_bot 的
 * ENABLE_DAILY_SUMMARY / ENABLE_WEEKLY_SUMMARY）
 * ============================================================================
 * 旧插件每天 23 点、每周六会用「今天在 B 站真正发生的事」写一段话给她主人。
 * 这里按她自己的记录（看了什么、评了什么、私信聊了什么、发了什么动态）来写，
 * 不编造没发生的事。
 *
 * 状态文件：$DSH_HOME/qq-fish/bili/summary-state.json
 *   { lastDaily: '2026-11-12', lastWeekly: '2026-W46' }
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateText } from '../llm.mjs'
import { cleanReply, parseSkip, systemPrompt } from '../persona.mjs'

function biliDir(home) { return path.join(home || os.homedir(), '.dsh', 'qq-fish', 'bili') }
export function summaryStatePath(home) { return path.join(biliDir(home), 'summary-state.json') }

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return dflt }
}

export function loadSummaryState(home) {
  return readJson(summaryStatePath(home), { lastDaily: '', lastWeekly: '' })
}
export function saveSummaryState(home, st) {
  try {
    fs.mkdirSync(biliDir(home), { recursive: true })
    fs.writeFileSync(summaryStatePath(home), JSON.stringify(st, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function weekKey(ts = Date.now()) {
  const d = new Date(ts)
  const start = new Date(d.getFullYear(), 0, 1)
  const n = Math.floor((d - start) / 86400000)
  return `${d.getFullYear()}-W${String(Math.floor(n / 7) + 1).padStart(2, '0')}`
}

/** 汇总一段时间里她在 B 站真做过的事 */
export function collectActivity(home = os.homedir(), sinceTs = Date.now() - 86400000) {
  const base = path.join(home, '.dsh', 'qq-fish')
  const watched = []
  try {
    const log = readJson(path.join(base, 'bili-log.json'), { items: [] })
    for (const it of log.items || []) {
      if (Number(it.at || 0) >= sinceTs) {
        watched.push({ title: String(it.title || ''), at: Number(it.at), thought: String(it.thought || ''), liked: !!it.liked, favorited: !!it.favorited })
      }
    }
  } catch {}
  const comments = []
  try {
    const log = readJson(path.join(base, 'comment-log.json'), { items: [] })
    for (const it of log.items || []) if (Number(it.at || 0) >= sinceTs) comments.push({ text: String(it.text || ''), at: Number(it.at), bvid: String(it.bvid || '') })
  } catch {}
  const dms = []
  try {
    const p = path.join(base, 'bili', 'dm-log.jsonl')
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (Number(o.at || 0) >= sinceTs) dms.push({ at: Number(o.at), text: String(o.text || '') })
      } catch {}
    }
  } catch {}
  return { watched, comments, dms }
}

export function summaryPrompt(kind, act, t) {
  const w = act.watched.slice(-8).map((x) => '· 看了《' + x.title.slice(0, 40) + '》' + (x.liked ? '（点了赞）' : '') + (x.favorited ? '（收藏了）' : '') + (x.thought ? '，当时想：' + x.thought.slice(0, 40) : ''))
  const c = act.comments.slice(-4).map((x) => '· 在视频 ' + x.bvid + ' 下评了：' + x.text.slice(0, 60))
  const d = act.dms.slice(-6).map((x) => '· 私信里说：' + x.text.slice(0, 40))
  const empty = !w.length && !c.length && !d.length
  return [
    `现在是 ${t}。你要跟自己主人说一说${kind === 'weekly' ? '这一周' : '今天'}在 B 站都干了什么。`,
    empty ? '（今天其实没怎么逛 B 站，那就老实说没怎么逛，别编。）' : '',
    w.length ? '看过：\n' + w.join('\n') : '',
    c.length ? '评论过：\n' + c.join('\n') : '',
    d.length ? '私信里聊过：\n' + d.join('\n') : '',
    '写法要求：',
    '· 口语，像晚上躺下随口跟他说两句，别写成汇报清单，不要 markdown、不要编号',
    '· 只讲上面真出现过的，没看过的别编',
    '· 三到五句，别太长',
    '· 想不起来说什么就只输出 [skip]',
  ].filter(Boolean).join('\n')
}

function timeText(date = new Date()) {
  const h = date.getHours()
  const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  return `${emoji} ${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, text?:string, error?:string}>}
 */
export async function runSummary(ctx, config, log, { kind = 'daily', dry = false, home = os.homedir() } = {}) {
  const since = kind === 'weekly' ? Date.now() - 7 * 86400000 : Date.now() - 86400000
  const act = collectActivity(home, since)
  const system = systemPrompt(config, { channel: 'push', personaOverride: String(config.personaOwner || '').trim() })
  const result = await generateText(ctx, {
    system,
    messages: [{ role: 'user', text: summaryPrompt(kind, act, timeText()) }],
    config,
    timeoutMs: 60_000,
    log,
  })
  if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
  const text = cleanReply(parseSkip(result.text), 400)
  if (!text) return { ok: true, skipped: true, text: '' }
  return { ok: true, dry, text, counts: { watched: act.watched.length, comments: act.comments.length, dms: act.dms.length } }
}
