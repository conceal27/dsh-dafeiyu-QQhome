/**
 * lib/organic.mjs — 神经-体液调节：让主动性从内部"涨"出来
 * ============================================================================
 * 为什么要这个：
 *   以前的主动性是「计时器到点 + 概率」，不管她想不想说，时间到了就评估一次。
 *   人机感就来自这里——间隔是钟表给的，不是她自己长出来的。
 *
 * 这套模型的思路（模拟有机生命）：
 *   1. 有一个「说话张力」（tension 0-100）在持续累积
 *   2. 累积速率由内部状态决定：想念、情绪、周期、累不累
 *   3. 涨到阈值 → 她开口 → 张力回落（不是归零，回落一大截）
 *   4. 张力没涨满，就算过去很久也不会硬发
 *
 * 和 drive.mjs 的分工：
 *   drive  = 瞬时判断「此刻冲动够不够」（一次性算完）
 *   organic = 连续状态「攒了多久、攒得多快」（有记忆、会回落）
 *
 * 数据：qq-fish/organic.json
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathOf, stateHome } from './store.mjs'
import { loadBody, cycleDay, phaseOf } from './body.mjs'
import { readMood } from './vitals.mjs'
import { loadSchedule } from './schedule.mjs'

const BASE_RATE = 0.75        // 基础累积：每分钟 +0.75 → 从 0 涨到 85 约 113 分钟
const THRESHOLD = 85          // 张力阈值
const RELEASE_DROP = 70       // 开口后回落多少
const FLOOR_AFTER = 12        // 回落后不低于这个（刚说完话也有点想继续）
const HARD_MIN_GAP = 25 * 60 * 1000   // 两次开口至少间隔 25 分钟（防抖）
const SAVE_THROTTLE = 3 * 60 * 1000   // 状态最多 3 分钟落一次盘

// 进程内单例：张力必须连续累积，不能每次从文件重读（否则刚涨上去就被旧值覆盖）
let ST = null
let lastSaveAt = 0

function load() {
  if (ST) return ST
  const now = Date.now()
  let raw = null
  try { raw = JSON.parse(readFileSync(pathOf('organic.json'), 'utf8')) } catch {}
  ST = {
    tension: 30,
    lastTickAt: now,
    lastReleaseAt: 0,
    lastInteractAt: 0,
    threshold: THRESHOLD,
    ...(raw || {}),
  }
  return ST
}

function save(st, force = false) {
  ST = st
  const now = Date.now()
  if (!force && now - lastSaveAt < SAVE_THROTTLE) return
  lastSaveAt = now
  try { writeFileSync(pathOf('organic.json'), JSON.stringify(st, null, 2) + '\n', 'utf8') } catch {}
}

/**
 * 累积速率（点/分钟）。这就是「体液」在推着神经走的部分。
 */
export function currentRate(st, { config = {}, now = Date.now() } = {}) {
  const cfgRate = Math.min(2.5, Math.max(0.2, Number(config.organicRate) || BASE_RATE))
  let rate = cfgRate
  const notes = []

  // ① 想念：距上次互动越久，涨得越快（最多 ×1.8）
  const sinceInteract = st.lastInteractAt ? (now - st.lastInteractAt) / 3600000 : 12
  if (sinceInteract > 1) {
    const boost = Math.min(0.8, (sinceInteract - 1) * 0.18)
    rate *= 1 + boost
    if (boost > 0.2) notes.push('想他了+' + Math.round(boost * 100) + '%')
  }

  // ② 情绪：从 mood 状态取（拿不到就用中性）
  try {
    const m = loadBody()
    const day = cycleDay(m)
    const phase = phaseOf(day, m)
    // 周期影响：排卵期想亲近、经期往下沉
    if (phase === 'ovulation') { rate *= 1.3; notes.push('排卵期×1.3') }
    else if (phase === 'pms') { rate *= 1.15; notes.push('经前×1.15') }
    else if (phase === 'period') { rate *= 0.8; notes.push('经期×0.8') }
    else if (phase === 'follicular') { rate *= 1.1; notes.push('卵泡期×1.1') }
  } catch {}

  // ③ 作息：深夜困了，涨得慢
  try {
    const sch = loadSchedule()
    const h = new Date(now).getHours()
    const wake = Number(sch.wakeHour), sleep = Number(sch.sleepHour)
    let asleep = null
    try { const m = readMood(stateHome()); if (m && typeof m.asleep === 'boolean') asleep = m.asleep } catch {}
    const byClock = sleep > wake ? (h >= sleep || h < wake) : (h >= sleep && h < wake)
    const sleeping = asleep == null ? byClock : asleep
    if (sleeping) { rate *= 0.35; notes.push('睡着了×0.35') }
    else if (h >= 22 || h < 1) { rate *= 0.7; notes.push('困了×0.7') }
  } catch {}

  // ④ 刚开口过：短期内涨得慢（不是禁令，是余韵）
  if (st.lastReleaseAt && now - st.lastReleaseAt < 90 * 60 * 1000) {
    rate *= 0.55
    notes.push('刚说过×0.55')
  }

  return { rate, notes }
}

/**
 * 走一步。返回 { fire, tension, rate, notes, gapMin }
 */
export function tickOrganic({ config = {}, now = Date.now(), markInteract = false } = {}) {
  const st = load()
  const dtMin = Math.max(0, (now - (st.lastTickAt || now)) / 60000)
  if (markInteract) st.lastInteractAt = now

  const { rate, notes } = currentRate(st, { config, now })
  st.tension = Math.max(0, Math.min(100, Number(st.tension || 0) + rate * dtMin))
  st.lastTickAt = now

  const cfgThreshold = Math.min(99, Math.max(50, Number(config.organicThreshold) || THRESHOLD))
  const gapOk = !st.lastReleaseAt || now - st.lastReleaseAt >= HARD_MIN_GAP
  const fire = st.tension >= cfgThreshold && gapOk

  if (fire) {
    st.tension = Math.max(FLOOR_AFTER, st.tension - RELEASE_DROP)
    st.lastReleaseAt = now
    save(st, true)
  } else {
    save(st)
  }
  return {
    fire,
    tension: Math.round(st.tension),
    rate: Number(rate.toFixed(2)),
    notes,
    gapMin: st.lastReleaseAt ? Math.round((now - st.lastReleaseAt) / 60000) : null,
    threshold: cfgThreshold,
  }
}

/**
 * 发送失败/没真发出去：把「涨满时已经扣掉」的张力还回去。
 * 人攒够勇气开口、结果话没递出去，不该当她已经说过——否则每次桥掉线都白攒一轮。
 * 不动 lastReleaseAt：25 分钟硬间隔保留，避免失败后每 45 秒重试死循环。
 */
export function restoreTension(amount = RELEASE_DROP) {
  const st = load()
  st.tension = Math.max(0, Math.min(100, Number(st.tension || 0) + (Number(amount) || 0)))
  save(st, true)
  return Math.round(st.tension)
}
/** 有人跟她说话：互动时间戳 + 张力小幅上跳（被搭理了会兴奋） */
export function noteInteraction({ now = Date.now(), bump = 8 } = {}) {
  const st = load()
  st.lastInteractAt = now
  st.tension = Math.min(100, Number(st.tension || 0) + bump)
  save(st, true)
  return { tension: Math.round(st.tension) }
}

/** 她说了一句话（被动回复也算）：张力回落一点 */
export function noteSpoke({ now = Date.now() } = {}) {
  const st = load()
  st.tension = Math.max(FLOOR_AFTER, Number(st.tension || 0) - 25)
  st.lastReleaseAt = now
  save(st, true)
}

/** 面板按钮：现在就让她想说话（直接把张力拉满） */
export function forceFullTension() {
  const st = load()
  st.tension = 99
  save(st, true)
  return { tension: 99 }
}

export function organicSnapshot() {
  const st = load()
  const { rate, notes } = currentRate(st, {})
  return {
    tension: Math.round(st.tension),
    threshold: Number(st.threshold || THRESHOLD),
    rate: Number(rate.toFixed(2)),
    notes,
    lastReleaseAt: st.lastReleaseAt,
    gapMin: st.lastReleaseAt ? Math.round((Date.now() - st.lastReleaseAt) / 60000) : null,
    sinceInteractMin: st.lastInteractAt ? Math.round((Date.now() - st.lastInteractAt) / 60000) : null,
  }
}
