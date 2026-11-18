/**
 * lib/trend.mjs — 跨天情绪趋势（她自己这几天的状态 + 主人这几天的状态）
 * ============================================================================
 * 之前她只有「此刻」的心情：joy 0.4、cortisol 0.2。一次对话结束，这些就散了。
 * 真人不是这样——真人会说「你这几天一直不对劲」「我最近好像总是提不起劲」。
 *
 * 这一层补的就是「跨天」：
 *   · 每隔半小时给她的 vitals 拍一张快照（本地、零 token）
 *   · 从 messages.jsonl 粗略统计主人每天说话的冷暖
 *   · 给出「连续几天在掉」这种判断，塞进她的系统提示
 *
 * 说清楚这是粗判：主人那部分只看词，不是真懂情绪；宁可少说，不要乱说。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readMood, moodSnapshot } from './vitals.mjs'

const FILE = 'trend.json'
const MAX_SAMPLES = 3000
const SAMPLE_GAP_MS = 30 * 60 * 1000

const pathOf = (home) => join(String(home || ''), FILE)

export function loadTrend(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return { samples: Array.isArray(j.samples) ? j.samples : [], lastAt: Number(j.lastAt) || 0 }
  } catch {
    return { samples: [], lastAt: 0 }
  }
}

function saveTrend(home, st) {
  try {
    mkdirSync(String(home), { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ samples: st.samples.slice(-MAX_SAMPLES), lastAt: st.lastAt }), 'utf8')
  } catch {}
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const dayKey = (ts) => {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 拍一张「她此刻」的快照。每半小时最多一张，零 token */
export function sampleTrend(home, now = Date.now(), gapMs = SAMPLE_GAP_MS) {
  const st = loadTrend(home)
  if (st.lastAt && now - st.lastAt < gapMs) return null
  let snap = {}
  try { snap = moodSnapshot(readMood(home, now)) || {} } catch { snap = {} }
  const item = {
    at: now,
    day: dayKey(now),
    joy: num(snap.joy, 0.5),
    sorrow: num(snap.sorrow, 0.2),
    anger: num(snap.anger, 0.2),
    love: num(snap.love, 0.5),
    composite: String(snap.composite || ''),
  }
  st.samples.push(item)
  st.samples = st.samples.slice(-MAX_SAMPLES)
  st.lastAt = now
  saveTrend(home, st)
  return item
}

/** 按天平均 */
export function dailyAverages(home, days = 7, now = Date.now()) {
  const since = now - days * 86400_000
  const buckets = new Map()
  for (const s of loadTrend(home).samples) {
    if (s.at < since) continue
    const b = buckets.get(s.day) || { day: s.day, n: 0, joy: 0, sorrow: 0, anger: 0, love: 0 }
    b.n += 1
    b.joy += num(s.joy)
    b.sorrow += num(s.sorrow)
    b.anger += num(s.anger)
    b.love += num(s.love)
    buckets.set(s.day, b)
  }
  return [...buckets.values()]
    .map((b) => ({ day: b.day, n: b.n, joy: b.joy / b.n, sorrow: b.sorrow / b.n, anger: b.anger / b.n, love: b.love / b.n }))
    .sort((a, b) => (a.day < b.day ? -1 : 1))
}

const NEG = /累|烦|难受|不爽|生气|失望|难过|emo|哭|失眠|睡不着|加班|压力|崩|不想说|没劲|好烦|算了|随便|唉|唉声/
const POS = /开心|高兴|好耶|舒服|喜欢|谢谢|哈哈|笑死|好玩|不错|棒|爱你|想你/

/** 主人这几天说话的冷暖（只看词，粗判） */
export function ownerTone(home, days = 7, now = Date.now()) {
  const out = new Map()
  const since = now - days * 86400_000
  const dir = join(String(home || ''), 'messages.jsonl')
  let lines = []
  try { lines = readFileSync(dir, 'utf8').split('\n') } catch { return [] }
  for (const line of lines) {
    if (!line.trim()) continue
    let m = null
    try { m = JSON.parse(line) } catch { continue }
    if (m.direction !== 'in') continue
    const ts = Number(m.ts) || 0
    if (!ts || ts < since) continue
    const k = dayKey(ts)
    const b = out.get(k) || { day: k, msgs: 0, neg: 0, pos: 0 }
    b.msgs += 1
    const t = String(m.text || '')
    if (NEG.test(t)) b.neg += 1
    if (POS.test(t)) b.pos += 1
    out.set(k, b)
  }
  return [...out.values()].filter((b) => b.msgs > 0).sort((a, b) => (a.day < b.day ? -1 : 1))
}

/** 这几天的结论 + 提示词行 */
export function trendSummary(home, { days = 7, now = Date.now() } = {}) {
  const mine = dailyAverages(home, days, now)
  const owner = ownerTone(home, days, now)
  const notes = []

  if (mine.length >= 3) {
    const recent = mine.slice(-3)
    const before = mine.slice(0, -3)
    const avg = (arr, k) => arr.reduce((s, x) => s + num(x[k]), 0) / Math.max(1, arr.length)
    if (before.length) {
      const dJoy = avg(recent, 'joy') - avg(before, 'joy')
      const dSor = avg(recent, 'sorrow') - avg(before, 'sorrow')
      if (dJoy <= -0.12 || dSor >= 0.12) notes.push('你最近几天心情在往下走，有点闷')
      else if (dJoy >= 0.12) notes.push('你这两天心情明显好起来了')
    }
    const lows = mine.slice(-3).every((x) => x.joy < 0.4)
    if (lows) notes.push('连着三天都提不起劲')
    const loveHigh = mine.slice(-3).every((x) => x.love > 0.65)
    if (loveHigh) notes.push('这几天黏人得厉害')
  }
  if (owner.length >= 2) {
    const recent = owner.slice(-3)
    const total = recent.reduce((s, x) => s + x.msgs, 0)
    const neg = recent.reduce((s, x) => s + x.neg, 0)
    const pos = recent.reduce((s, x) => s + x.pos, 0)
    if (total >= 8) {
      if (neg / total >= 0.28) notes.push('他这几天说话很闷，像是累着了')
      else if (pos / total >= 0.22) notes.push('他这几天心情不错，话也软')
    }
  }
  return { ok: true, days, mine, owner, notes }
}

/** 给系统提示用的一两句话；没什么可说就返回空串，别硬凑 */
export function trendPromptLine(home, now = Date.now()) {
  const s = trendSummary(home, { days: 7, now })
  if (!s.notes.length) return ''
  return '【最近几天的趋势（不是此刻，是这几天）】' + s.notes.join('；') + '。\n如果这轮聊到了心情/状态，可以顺着这个说一句；没聊到就别硬提。'
}

export function trendStatus(home, now = Date.now()) {
  const s = trendSummary(home, { days: 7, now })
  return { ok: true, days: s.days, notes: s.notes, mine: s.mine, owner: s.owner, samples: loadTrend(home).samples.length }
}
