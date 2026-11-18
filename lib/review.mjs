/**
 * lib/review.mjs — 周记 / 月记（比「只看日记」更厚的复盘）
 * ============================================================================
 * lib/sc/diary.mjs 里已经有 generateReview，但它只吃「这个周期的日记」。
 * 问题：日记一天一篇，周记光看七篇 200 字，写出来还是日记的复读。
 *
 * 这一层把这几样东西一起摆给她看：
 *   · 这周的日记（她当时怎么想的）
 *   · daystream（她这些天实际在干嘛：打盹、发呆、刷手机……）
 *   · 跨平台记忆（空间发的、B站看的、抖音刷到的、shared）
 *   · 情绪趋势（这几天是往上走还是往下掉）
 * 然后让她自己写「这一周我过得怎么样」。
 *
 * 只读，不改状态；写盘由调用方决定（saveReview）。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateText } from './llm.mjs'
import { entriesInPeriod, loadDiary } from './sc/diary.mjs'
import { loadStream } from './daystream.mjs'
import { loadMemoryCard, resolveMemoryCardPaths } from './sc/memory-card.mjs'
import { trendSummary } from './trend.mjs'

const PUBLIC_SCOPES = new Set(['qzone', 'douyin', 'bili', 'shared'])
const KIND_LABEL = { daily: '这一天', weekly: '这一周', monthly: '这一个月' }

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

function periodStart(kind, now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (kind === 'weekly') d.setDate(d.getDate() - 6)
  else if (kind === 'monthly') d.setDate(1)
  return d.getTime()
}

/** 把这几样素材摆在一起 */
export function gatherReviewMaterial(home, kind, now = Date.now()) {
  const since = periodStart(kind, now)
  const diary = (() => {
    try { return loadDiary(join(String(home || ''), 'diary.json')) } catch { return { entries: [] } }
  })()
  const entries = entriesInPeriod(diary, kind, now)

  const stream = []
  try {
    for (const e of (loadStream(home).entries || [])) {
      if (num(e.at) < since) continue
      const line = String(e.line || '').trim()
      if (line) stream.push(line.slice(0, 60))
    }
  } catch {}

  const life = []
  try {
    const paths = resolveMemoryCardPaths(join(String(home || ''), 'memory'))
    const card = loadMemoryCard(paths)
    for (const r of (card && card.records) || []) {
      const ts = num(r.ts)
      if (!ts || ts < since) continue
      if (!PUBLIC_SCOPES.has(String(r.scope || ''))) continue
      const text = String(r.text || '').replace(/\s+/g, ' ').trim()
      if (text.length >= 8) life.push({ at: ts, scope: String(r.scope), text: text.slice(0, 120) })
    }
  } catch {}
  life.sort((a, b) => b.at - a.at)

  let trend = { notes: [] }
  try { trend = trendSummary(home, { days: kind === 'monthly' ? 30 : 7, now }) } catch {}

  // daystream 重复的很多，去重后保留最近的
  const seen = new Set()
  const streamUniq = []
  for (const line of stream.reverse()) {
    const k = line.slice(0, 12)
    if (seen.has(k)) continue
    seen.add(k)
    streamUniq.push(line)
  }

  return {
    kind,
    since,
    entries,
    stream: streamUniq.slice(0, 30),
    life: life.slice(0, 14),
    trendNotes: (trend && trend.notes) || [],
    counts: { entries: entries.length, stream: streamUniq.length, life: life.length },
  }
}

/** 真的去写这份复盘 */
export async function generatePeriodReview(ctx, { home, config = {}, log, kind = 'weekly', now = Date.now() } = {}) {
  const mat = gatherReviewMaterial(home, kind, now)
  const label = KIND_LABEL[kind] || '这一周'
  if (!mat.entries.length && !mat.stream.length && !mat.life.length) {
    return { ok: false, error: '这个周期没什么可复盘的', counts: mat.counts }
  }

  const parts = []
  if (mat.entries.length) {
    parts.push('【' + label + '你写的日记】\n' + mat.entries
      .map((e) => e.date + (e.moodLabel ? '（' + e.moodLabel + '）' : '') + '：' + String(e.text).slice(0, 260))
      .join('\n'))
  }
  if (mat.stream.length) {
    parts.push('【' + label + '你实际在干嘛（零零碎碎的）】\n' + mat.stream.map((s) => '· ' + s).join('\n'))
  }
  if (mat.life.length) {
    parts.push('【' + label + '你在别的平台上经历的事】\n' + mat.life.map((x) => '· [' + x.scope + '] ' + x.text).join('\n'))
  }
  if (mat.trendNotes.length) {
    parts.push('【这几天的状态】\n' + mat.trendNotes.map((n) => '· ' + n).join('\n'))
  }

  const system = [
    '你在写' + label + '的周记/复盘。这是写给你自己看的，不是交作业，也不是给我看的汇报。',
    '用第一人称，用你自己的语气（嘴硬、自嘲、偶尔心软）。别用「首先其次最后」这种腔调。',
    '要写出：' + label + '过得怎么样、有没有反复出现的情绪或模式、有没有什么事其实一直放在心上、答应过谁的事做了没有。',
    '如果素材里有具体的事，就提那件事，别写空泛的感悟。',
    '最后给一句给自己的结论（可以是吐槽，也可以是认真的）。',
    '写 180～320 字，只输出正文，不要标题、不要日期、不要分点。',
  ].join('\n')

  try {
    const r = await generateText(ctx, {
      feature: 'diary',
      system,
      messages: [{ role: 'user', text: parts.join('\n\n') + '\n\n写' + label + '的复盘。' }],
      config,
      temperature: 1.0,
      maxTokens: 900,
      timeoutMs: 90_000,
      log: (line) => log && log.warn && log.warn(line),
    })
    const text = String((r && r.text) || '').trim()
    if (!text) return { ok: false, error: '模型没写出东西', counts: mat.counts }
    return { ok: true, text, counts: mat.counts, trendNotes: mat.trendNotes, model: r && r.model }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), counts: mat.counts }
  }
}
