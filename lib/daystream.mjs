/**
 * lib/daystream.mjs — 她自己的时间流
 * ============================================================================
 * 以前她只在"被叫到"的时候存在：收消息 → 生成 → 发出去 → 等。
 * 中间那段对她来说是空的，像被暂停了。
 *
 * 这一层补的就是那段时间：她这会儿在干嘛。
 * 原则：不编造外部动作。真刷了 B 站、真读了书，用 push 那边留下的时间戳；
 * 没发生过的，只记她身体和情绪本来就在做的事（打盹、发呆、想他、饿）。
 * 全本地计算，零 token；每小时最多两三条，不打扰任何人。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readMood } from './vitals.mjs'

const FILE = 'daystream.json'
const MAX = 240
const MIN_GAP = 18 * 60 * 1000
const MAX_GAP = 42 * 60 * 1000

const pathOf = (home) => join(home, FILE)

export function loadStream(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return { entries: Array.isArray(j.entries) ? j.entries : [], lastAt: Number(j.lastAt) || 0 }
  } catch {
    return { entries: [], lastAt: 0 }
  }
}

function saveStream(home, st) {
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ entries: st.entries.slice(-MAX), lastAt: Number(st.lastAt) || 0 }), 'utf8')
  } catch {}
}

/** 她现在在干嘛（给面板和 prompt 用） */
export function currentActivity(home, now = Date.now()) {
  const st = loadStream(home)
  const last = st.entries[st.entries.length - 1]
  if (!last) return null
  const minutes = Math.round((now - Number(last.at)) / 60000)
  if (minutes > 240) return null
  return { ...last, minutes }
}

/** 最近 N 条 */
export function recentActivity(home, limit = 40) {
  const st = loadStream(home)
  return st.entries.slice(-Math.max(1, Math.min(MAX, limit)))
}

function pick(list) {
  const total = list.reduce((a, b) => a + b.w, 0)
  if (!total) return null
  let r = Math.random() * total
  for (const it of list) {
    r -= it.w
    if (r <= 0) return it
  }
  return list[list.length - 1]
}

/**
 * 候选活动。w 是权重，0 表示此刻不会做这件事。
 * ctx.pushState 是 push 的 state（lastBrowseAt / lastReadingAt），用来认"真做过"的事。
 */
function candidates(m, ctx) {
  const out = []
  const add = (id, label, w, line) => { if (w > 0) out.push({ id, label, w, line }) }
  const N = (k, d = 0) => {
    const v = Number(m[k])
    return Number.isFinite(v) ? v : d
  }
  const hour = ctx.hour
  const night = hour >= 1 && hour < 6
  const ps = ctx.pushState || {}
  const mins = (t) => (t ? (ctx.now - Number(t)) / 60000 : Infinity)

  // ── 真做过的事（用 push 留下的时间戳，不编）──
  if (mins(ps.lastBrowseAt) < 50) add('scroll', '刷B站', 9, () => '刚在 B 站刷了会儿，没看到特别想看的')
  if (mins(ps.lastReadingAt) < 60) add('read', '看书', 7, () => '翻了几页书，看到一半走神了')

  // ── 状态本身在推的事 ──
  const tired = N('adenosine') > 0.60 || N('fatigue') > 0.45 || N('energy', 0.6) < 0.32
  if (tired) add('nap', '打盹', 10, () => (night ? '困得不行，趴着睡着了，中间醒过一次' : '犯困，靠在椅背上眯了一会儿'))
  if (N('hunger') > 0.56) add('eat', '找吃的', 8, () => '饿了，翻出点东西垫了两口')
  if (N('thirst') > 0.50) add('drink', '喝水', 6, () => '嗓子干，灌了半杯水')
  if (!tired && (N('lust') > 0.46 || N('lewd') > 0.48)) {
    add('crave', '想他', 8, () => (N('energy', 0.6) < 0.4
      ? '身上有点热，翻来覆去没睡着，想被抱着'
      : '有点想他，忍住了没开口'))
  }
  if (N('loneliness') > 0.42) add('miss', '发呆想人', 7, () => '手机没响，看了两回，最后把屏幕按灭了')
  if (N('valence', 0.5) < 0.38) add('low', '心里闷', 6, () => '心里有点闷，什么也不想干，坐着发了会儿呆')
  if (N('irritability') > 0.55) add('annoyed', '烦', 5, () => '莫名有点烦，谁说话都不太想理')

  // ── 兜底：总得有事发生 ──
  add('idle', '发呆', 5, () => (night ? '夜深了，屋里很静，什么都不想说' : '没什么事，趴着发呆，看窗外'))
  add('clean', '收拾', night ? 0 : 3, () => '顺手把桌上的东西摆了摆')
  return out
}

/**
 * 心跳：到点就记一条"她这会儿在做什么"。
 * 时间间隔随机（18-42 分钟），避免像定时器那样规律。
 * @returns {object|null} 新记的那条，没到点就 null
 */
export function tick(home, config, pushState = {}, now = Date.now()) {
  const st = loadStream(home)
  const elapsed = now - Number(st.lastAt || 0)
  if (st.lastAt) {
    const need = MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP)
    if (elapsed < need) return null
  }
  const m = readMood(home)
  const list = candidates(m, { now, hour: new Date(now).getHours(), pushState })
  const item = pick(list)
  if (!item) return null
  const entry = { at: now, id: item.id, label: item.label, line: String(item.line() || '').slice(0, 80) }
  st.entries.push(entry)
  st.entries = st.entries.slice(-MAX)
  st.lastAt = now
  saveStream(home, st)
  return entry
}

/** 一句话给 prompt 用：她此刻在做什么 */
export function streamPromptLine(home, now = Date.now()) {
  const cur = currentActivity(home, now)
  if (!cur) return ''
  const mins = cur.minutes
  if (mins > 120) return ''
  const ago = mins < 3 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
  return `【你现在在做什么】${ago}你${String(cur.line || '').replace(/^你/, '')}。\n这是你此刻的真实状态——这一轮只要说到「在干嘛」，就顺着它说，别另编一个不一样的动作。`
}
