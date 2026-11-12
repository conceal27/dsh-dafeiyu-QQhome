/**
 * lib/sc/diary.mjs — 日记 + 日/周/月复盘（归属：xingzhu）
 * ============================================================================
 * 她自己记日记：不是操作日志，是用她自己的语气写「今天发生了什么、我怎么想」。
 * 复盘是拿一段时间的日记再想一遍：日复盘看一天，周复盘看一周，月复盘看一月。
 *
 * 设计要点：
 *   · 日记只记「值得记的」，不是每条消息都进——由模型判断要不要写；
 *   · 日记里会带上当时的心情标签，复盘时能看出情绪曲线；
 *   · 复盘结果会反过来影响人设演化（长期重复的模式才值得改人设）；
 *   · 所有生成都走 generateText，失败不影响主流程。
 *
 * 存储：$DSH_HOME/qq-fish/diary.json
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateText } from '../llm.mjs'

export const DIARY_VERSION = 1

export function diaryPath(stateHome) {
  return path.join(stateHome, 'diary.json')
}

export function createEmptyDiary() {
  return { version: DIARY_VERSION, entries: [], reviews: {} }
}

export function loadDiary(diskPath) {
  try {
    if (!fs.existsSync(diskPath)) return createEmptyDiary()
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    return {
      version: DIARY_VERSION,
      entries: Array.isArray(raw && raw.entries) ? raw.entries : [],
      reviews: (raw && raw.reviews) || {},
    }
  } catch {
    return createEmptyDiary()
  }
}

export function saveDiary(diskPath, diary) {
  try {
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const tmp = diskPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(diary, null, 2))
    fs.renameSync(tmp, diskPath)
  } catch {}
}

/** 本地日期字符串 YYYY-MM-DD */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 周键：YYYY-Www（ISO 周） */
export function weekKey(ts = Date.now()) {
  const d = new Date(ts)
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const diff = (target - firstThursday) / 86400000
  const week = 1 + Math.floor(diff / 7)
  return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
}

export function monthKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1)
}

export function periodKey(kind, ts = Date.now()) {
  if (kind === 'weekly') return weekKey(ts)
  if (kind === 'monthly') return monthKey(ts)
  return dayKey(ts)
}

export function appendEntry(diary, entry) {
  const now = Number(entry && entry.createdAt) || Date.now()
  const item = {
    id: 'd-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    date: String((entry && entry.date) || dayKey(now)),
    text: String((entry && entry.text) || '').trim().slice(0, 2000),
    moodLabel: String((entry && entry.moodLabel) || ''),
    source: String((entry && entry.source) || 'chat'),
    createdAt: now,
  }
  if (!item.text) return diary
  const next = { ...diary, entries: [...(diary.entries || []), item] }
  // 只留最近 400 条，防止无限长
  next.entries = next.entries.slice(-400)
  return next
}

/** 某一天的日记 */
export function entriesOfDay(diary, date) {
  return (diary.entries || []).filter((e) => e.date === date)
}

/** 最近 n 条日记（按时间正序） */
export function recentEntries(diary, n = 5) {
  return (diary.entries || []).slice(-n)
}

/** 取某个周期内的日记 */
export function entriesInPeriod(diary, kind, ts = Date.now()) {
  const list = diary.entries || []
  if (kind === 'daily') {
    const k = dayKey(ts)
    return list.filter((e) => e.date === k)
  }
  if (kind === 'weekly') {
    const k = weekKey(ts)
    return list.filter((e) => weekKey(e.createdAt) === k)
  }
  const k = monthKey(ts)
  return list.filter((e) => monthKey(e.createdAt) === k)
}

/** 注入提示词：最近几天的日记，让她「记得自己写过什么」 */
export function renderDiaryPrompt(diary, n = 4) {
  const list = recentEntries(diary, n)
  if (!list.length) return ''
  const lines = ['【你自己的日记（最近写的，用来保持连续感，别当成别人写的）】']
  for (const e of list) {
    const mood = e.moodLabel ? '（当时心情：' + e.moodLabel + '）' : ''
    lines.push('· ' + e.date + mood + '：' + String(e.text).slice(0, 200))
  }
  return lines.join('\n')
}

/** 是不是该写今天的日记了 */
export function needsDiary(diary, now = Date.now()) {
  const k = dayKey(now)
  return !(diary.entries || []).some((e) => e.date === k && e.source !== 'manual')
}

/** 是不是该做这个周期的复盘了 */
export function needsReview(diary, kind, now = Date.now()) {
  const key = periodKey(kind, now)
  return !diary.reviews || !diary.reviews[kind + ':' + key]
}

export function saveReview(diary, kind, ts, text, meta = {}) {
  const key = periodKey(kind, ts)
  const next = { ...diary, reviews: { ...(diary.reviews || {}) } }
  next.reviews[kind + ':' + key] = {
    kind,
    key,
    text: String(text || '').slice(0, 4000),
    createdAt: Date.now(),
    meta: meta || {},
  }
  // 只保留最近 60 份复盘
  const keys = Object.keys(next.reviews).sort((a, b) => (next.reviews[a].createdAt || 0) - (next.reviews[b].createdAt || 0))
  while (keys.length > 60) delete next.reviews[keys.shift()]
  return next
}

export function listReviews(diary, kind, limit = 10) {
  const all = Object.entries(diary.reviews || {})
    .map(([k, v]) => ({ k, ...v }))
    .filter((r) => !kind || r.kind === kind)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return all.slice(0, limit)
}

// ─────────────────────────────────────────────────────────────────────────
// 生成（需要模型）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 让她自己写今天的日记。
 * @returns {Promise<{ok:boolean, text:string, error?:string}>}
 */
export async function generateDiary(ctx, opts) {
  const { stateHome, config, log } = opts
  const now = Number(opts.now) || Date.now()
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  if (!messages.length) return { ok: false, text: '', error: '今天没什么可写的' }

  const digest = messages
    .slice(-60)
    .map((m) => (m.direction === 'out' ? '我：' : (m.who || '对方') + '：') + String(m.text || '').slice(0, 120))
    .join('\n')

  const moodLabel = String(opts.moodLabel || '')
  const system = [
    '你在写你自己的日记。不是给别人看的汇报，是你自己睡前的碎碎念。',
    '用第一人称，用你自己的语气（有点嘴硬、有点自嘲、偶尔犯花痴），不要写成条理清晰的报告。',
    '写 100～200 字。可以写今天谁说了什么让你在意、你干了什么蠢事、你心里其实怎么想的。',
    moodLabel ? '你今天的心情是「' + moodLabel + '」，日记的语气要符合这个心情。' : '',
    '只输出日记正文，不要日期标题，不要解释你在写日记。',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const result = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '今天发生这些事：\n' + digest + '\n\n写你的日记。' }],
      config,
      temperature: 1.15,
      timeoutMs: 60_000,
      log: (line) => log && log.warn && log.warn(line),
    })
    const text = String((result && result.text) || '').trim()
    if (!text) return { ok: false, text: '', error: '模型没写出东西' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e) }
  }
}

/**
 * 生成一次复盘。
 */
export async function generateReview(ctx, opts) {
  const { config, log } = opts
  const kind = opts.kind === 'weekly' ? 'weekly' : opts.kind === 'monthly' ? 'monthly' : 'daily'
  const entries = Array.isArray(opts.entries) ? opts.entries : []
  if (!entries.length) return { ok: false, text: '', error: '这个周期没有日记' }

  const label = kind === 'daily' ? '这一天' : kind === 'weekly' ? '这一周' : '这一个月'
  const body = entries
    .map((e) => e.date + (e.moodLabel ? '（' + e.moodLabel + '）' : '') + '：' + String(e.text).slice(0, 300))
    .join('\n')

  const system = [
    '你在做' + label + '的自我复盘。这是给你自己看的，不是交作业。',
    '用第一人称，诚实地想：' + label + '我过得怎么样？有什么反复出现的情绪或模式？有没有答应过谁的事没做？',
    '最后给一句给自己的结论（可以是吐槽，也可以是认真的）。',
    '写 150～300 字，只输出正文。',
  ].join('\n')

  try {
    const result = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '这些是' + label + '的日记：\n' + body + '\n\n做复盘。' }],
      config,
      temperature: 1.0,
      timeoutMs: 90_000,
      log: (line) => log && log.warn && log.warn(line),
    })
    const text = String((result && result.text) || '').trim()
    if (!text) return { ok: false, text: '', error: '模型没写出东西' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e) }
  }
}
