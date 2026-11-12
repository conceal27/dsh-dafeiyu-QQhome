/**
 * lib/memo.mjs — 状态备忘 / 定时任务 / 关键词触发（对齐 AstrBot astrbot_plugin_instant_memo）
 * ============================================================================
 * 旧插件给她四把「记着」的钩子，迁过来后只剩 [wake:] 一种。这里补齐：
 *   status_memo      状态备忘：一直记着的一条（直到手动删）
 *   task             定时任务：每天/一次的到点提醒（接进 selfwake，由 push 真正发出去）
 *   keyword_trigger  关键词触发：话里出现某个词，就把这条附进上下文
 *
 * 文件：$DSH_HOME/qq-fish/memo.json
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { addWakeAt } from './selfwake.mjs'

const FILE = 'memo.json'
const MAX_STATUS = 60
const MAX_TASKS = 60
const MAX_TRIGGERS = 80

export function memoPath(home) { return join(home, FILE) }

const EMPTY = () => ({ version: 1, statusMemos: [], tasks: [], triggers: [] })

export function loadMemo(home) {
  try {
    const j = JSON.parse(readFileSync(memoPath(home), 'utf8'))
    return {
      version: 1,
      statusMemos: Array.isArray(j.statusMemos) ? j.statusMemos : [],
      tasks: Array.isArray(j.tasks) ? j.tasks : [],
      triggers: Array.isArray(j.triggers) ? j.triggers : [],
    }
  } catch { return EMPTY() }
}

export function saveMemo(home, m) {
  try {
    mkdirSync(home, { recursive: true })
    const out = {
      version: 1,
      statusMemos: (m.statusMemos || []).slice(-MAX_STATUS),
      tasks: (m.tasks || []).slice(-MAX_TASKS),
      triggers: (m.triggers || []).slice(-MAX_TRIGGERS),
    }
    const tmp = memoPath(home) + '.tmp'
    writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8')
    renameSync(tmp, memoPath(home))
    return out
  } catch { return m }
}

const id = (s) => createHash('sha1').update(String(s) + Date.now() + Math.random()).digest('hex').slice(0, 10)
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// ── 状态备忘 ────────────────────────────────────────────────
export function addStatusMemo(home, content, { until = 0 } = {}) {
  const text = clip(content, 400)
  if (!text) return { ok: false, error: '内容是空的' }
  const m = loadMemo(home)
  const item = { id: id(text), content: text, until: Number(until) || 0, createdAt: Date.now() }
  m.statusMemos.push(item)
  saveMemo(home, m)
  return { ok: true, item }
}

export function removeStatusMemo(home, idPrefix) {
  const p = String(idPrefix || '').trim()
  const m = loadMemo(home)
  const before = m.statusMemos.length
  m.statusMemos = m.statusMemos.filter((x) => !(p === 'all' || String(x.id).startsWith(p) || String(x.content).includes(p)))
  saveMemo(home, m)
  return { ok: before !== m.statusMemos.length, removed: before - m.statusMemos.length }
}

// ── 定时任务 ────────────────────────────────────────────────
/** type: 'daily'（每天 HH:MM） | 'once'（绝对时间戳 at） */
export function addTask(home, { text, type = 'daily', hhmm = '', at = 0 } = {}) {
  const t = clip(text, 200)
  if (!t) return { ok: false, error: '内容是空的' }
  let nextAt = 0
  let hh = 0, mm = 0
  if (type === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
    if (!m) return { ok: false, error: 'daily 任务要写 HH:MM' }
    hh = Number(m[1]); mm = Number(m[2])
    if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return { ok: false, error: '时间不合法' }
    nextAt = nextOccurrenceMs(hh, mm, Date.now())
  } else {
    nextAt = Number(at) || 0
    if (!nextAt) return { ok: false, error: 'once 任务要有绝对时间' }
    const d = new Date(nextAt)
    hh = d.getHours(); mm = d.getMinutes()
  }
  const m = loadMemo(home)
  const item = { id: id(t), text: t, type, hh, mm, nextAt, enabled: true, createdAt: Date.now() }
  m.tasks.push(item)
  saveMemo(home, m)
  return { ok: true, item }
}

export function removeTask(home, idPrefix) {
  const p = String(idPrefix || '').trim()
  const m = loadMemo(home)
  const before = m.tasks.length
  m.tasks = m.tasks.filter((x) => !(p === 'all' || String(x.id).startsWith(p) || String(x.text).includes(p)))
  saveMemo(home, m)
  return { ok: before !== m.tasks.length, removed: before - m.tasks.length }
}

function nextOccurrenceMs(hh, mm, now = Date.now()) {
  const d = new Date(now)
  d.setHours(hh, mm, 0, 0)
  if (d.getTime() <= now + 20_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * 每次心跳调一次：把到点的定时任务塞进 selfwake（push 会当「她自己想起来了」发出去）。
 * 关键是幂等：同一条任务同一时刻只登记一次，发过了才推到下一次。
 */
export function syncTasks(home, now = Date.now(), log = null) {
  const m = loadMemo(home)
  let changed = 0
  for (const t of m.tasks) {
    if (!t.enabled) continue
    if (!t.nextAt) continue
    // 已经过期超过 10 分钟就不再补发（人不在/服务挂过），直接跳下一次
    if (now > t.nextAt + 10 * 60 * 1000) {
      t.nextAt = t.type === 'daily' ? nextOccurrenceMs(t.hh, t.mm, now) : 0
      if (t.type !== 'daily') t.enabled = false
      changed++
      continue
    }
    if (now >= t.nextAt) {
      try {
        const r = addWakeAt(home, t.nextAt, t.text, now)
        if (r && r.ok !== false) {
          if (log) log.info('[备忘] 定时任务到点：' + String(t.text).slice(0, 30))
          t.lastFiredAt = now
          t.nextAt = t.type === 'daily' ? nextOccurrenceMs(t.hh, t.mm, now + 60_000) : 0
          if (t.type !== 'daily') t.enabled = false
          changed++
        }
      } catch {}
    }
  }
  if (changed) saveMemo(home, m)
  return changed
}

// ── 关键词触发 ──────────────────────────────────────────────
export function addTrigger(home, keyword, content) {
  const k = clip(keyword, 40)
  const c = clip(content, 400)
  if (!k || !c) return { ok: false, error: '关键词和内容都要有' }
  const m = loadMemo(home)
  const item = { id: id(k + c), keyword: k, content: c, enabled: true, createdAt: Date.now() }
  m.triggers.push(item)
  saveMemo(home, m)
  return { ok: true, item }
}

export function removeTrigger(home, idPrefix) {
  const p = String(idPrefix || '').trim()
  const m = loadMemo(home)
  const before = m.triggers.length
  m.triggers = m.triggers.filter((x) => !(p === 'all' || String(x.id).startsWith(p) || String(x.keyword).includes(p)))
  saveMemo(home, m)
  return { ok: before !== m.triggers.length, removed: before - m.triggers.length }
}

// ── 提示词注入 ──────────────────────────────────────────────
export function memoPromptBlock(home, msgText = '', opts = {}) {
  const m = loadMemo(home)
  const now = Date.now()
  const parts = []
  const live = (m.statusMemos || []).filter((x) => !x.until || Number(x.until) > now)
  if (opts.status !== false && live.length) {
    parts.push('【你记着的事】\n' + live.slice(-10).map((x) => '- ' + x.content).join('\n'))
  }
  const text = String(msgText || '')
  if (text) {
    const hits = (m.triggers || []).filter((x) => x.enabled && text.includes(String(x.keyword || ''))).slice(0, 3)
    if (hits.length) parts.push('【说到这个词就要想起来】\n' + hits.map((x) => '- ' + x.content).join('\n'))
  }
  const daily = (m.tasks || []).filter((x) => x.enabled && x.type === 'daily')
  if (daily.length) {
    const hhmm = (h, mm) => String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
    parts.push('【你自己定的固定提醒】\n' + daily.slice(0, 8).map((x) => '- 每天 ' + hhmm(x.hh, x.mm) + '：' + x.text).join('\n'))
  }
  return parts.join('\n\n')
}

export function memoStats(home) {
  const m = loadMemo(home)
  return {
    statusMemos: m.statusMemos.length,
    tasks: m.tasks.filter((x) => x.enabled).length,
    triggers: m.triggers.length,
  }
}
