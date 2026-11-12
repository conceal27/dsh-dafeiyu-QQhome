/**
 * lib/bili/awake.mjs — B 站自动行为的统一「她睡着了吗」闸门（A 项）
 * ============================================================================
 * 背景：以前只有「分享 / 动态 / 评论」有 asleepNow 判断，而且那个判断只看
 * vitals.json 的 asleep 字段；【自己逛】【私信】【@ 回复】【评论接话】【日报】
 * 完全没有睡眠闸门——昨晚 03:17、06:36 的 B 站私信和 04:44 那次刷视频就是这么来的。
 *
 * 这里的判定**不依赖 inQuiet() 单独作战**：
 *   · 第一权威是她自己的作息（schedule.json 的 sleepHour → wakeHour，支持跨午夜）；
 *   · 其次 vitals 的 asleep === true（真的睡过去了）；
 *   · 再次主人手填的 nightSilenceStart/End（silenceFollowSchedule 关掉时才独立生效）；
 *   · 最后把 purpose 的 inQuiet() 当作「再多拦一道」的附加条件。
 * 关键：inQuiet() 第一件事是「asleep === false 就返回 false」（生理上醒着就不算安静），
 * 那是给「她醒着但别吵她」用的；半夜被消息吵醒后 asleep 会变 false，所以这里
 * **必须**自己算作息窗口，并且所有条件取「任一判定为睡 → 跳过」。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSchedule } from '../schedule.mjs'
import { readMood } from '../vitals.mjs'
import { recentMessages, stateHome } from '../store.mjs'
import { inQuiet } from '../purpose.mjs'

/** 所有需要过闸门的 B 站自动行为 */
export const BILI_AUTO_KINDS = Object.freeze([
  'watch',   // 自己逛
  'share',   // 分享给主人
  'dynamic', // 发动态
  'comment', // 发评论
  'dm',      // 回私信
  'at',      // 回 @
  'reply',   // 评论区接话
  'summary', // 日报 / 周报
])

/**
 * 两类行为的区别（2026-11-12 按主人第③句「给他权利让他决定自己要做什么」重划）：
 *   self  —— 她自己做的事（自己逛/发动态/在自己视频下评论）：只受「她真的睡着了」约束，
 *            醒着就是她的自由，由 lib/bili/will.mjs 问她本人决定，不由钟点替她决定。
 *   owner —— 会到他眼前的动作（分享/私信/@回复/评论接话/日报）：主人睡着时一件都不做，
 *            这条是硬约束，不给「她愿意」留口子——半夜吵醒人不叫自由。
 */
export const BILI_SELF_KINDS = Object.freeze(['watch', 'dynamic', 'comment'])
export const BILI_OWNER_KINDS = Object.freeze(['share', 'dm', 'at', 'reply', 'summary'])
export function isSelfKind(kind) { return BILI_SELF_KINDS.includes(String(kind)) }
export function isOwnerKind(kind) { return BILI_OWNER_KINDS.includes(String(kind)) }

export const BILI_KIND_LABEL = Object.freeze({
  watch: '自己逛',
  share: '分享视频',
  dynamic: '发动态',
  comment: '发评论',
  dm: '回私信',
  at: '回 @',
  reply: '评论接话',
  summary: '日报',
})

const pad2 = (n) => String(n).padStart(2, '0')

/** now → 当天第几分钟 */
export function minutesOfDay(now = Date.now()) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/** 小时窗口判定，支持跨午夜（start === end 视为关闭 → 恒 false） */
export function inHourWindow(minutes, startHour, endHour) {
  const s = Math.round(Number(startHour)) * 60
  const e = Math.round(Number(endHour)) * 60
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false
  const m = ((Math.round(Number(minutes)) % 1440) + 1440) % 1440
  return s < e ? (m >= s && m < e) : (m >= s || m < e)
}

function safeSchedule() {
  try { return loadSchedule() } catch { return null }
}

/**
 * 把「她自己的作息」解析成一个可复用的睡眠窗口。
 * @returns {{sleepHour:number, wakeHour:number, startMin:number, endMin:number, quietStart:string, quietEnd:string}}
 */
export function sleepWindowOf(config = {}, schedule = null) {
  const sch = schedule || safeSchedule() || {}
  let sleepH = Number(sch.sleepHour)
  let wakeH = Number(sch.wakeHour)
  if (!Number.isFinite(sleepH)) sleepH = Number(config.nightSilenceStart)
  if (!Number.isFinite(wakeH)) wakeH = Number(config.nightSilenceEnd)
  if (!Number.isFinite(sleepH)) sleepH = 2
  if (!Number.isFinite(wakeH)) wakeH = 9
  sleepH = ((Math.round(sleepH) % 24) + 24) % 24
  wakeH = ((Math.round(wakeH) % 24) + 24) % 24
  return {
    sleepHour: sleepH,
    wakeHour: wakeH,
    startMin: sleepH * 60,
    endMin: wakeH * 60,
    quietStart: pad2(sleepH) + ':00',
    quietEnd: pad2(wakeH) + ':00',
  }
}

/**
 * 现在她是不是在睡（纯逻辑，可注入一切依赖，方便单测）。
 * @param {{now?:number, config?:object, schedule?:object, mood?:object, quiet?:boolean}} opt
 */
export function sleepState({ now = Date.now(), config = {}, schedule = null, mood = null, quiet = undefined, messages = null } = {}) {
  // 主人这会儿睡了吗：只看他最近有没有说话（bili/will.mjs 的 ownerAwake，45 分钟窗口）
  const win = sleepWindowOf(config, schedule)
  const minutes = minutesOfDay(now)
  const inScheduleSleep = inHourWindow(minutes, win.sleepHour, win.wakeHour)

  let moodAsleep = false
  if (mood && typeof mood === 'object') {
    moodAsleep = mood.asleep === true
  } else {
    try { const m = readMood(stateHome()); moodAsleep = !!(m && m.asleep === true) } catch {}
  }

  // 主人手填的深夜静默：只在「不跟随作息」时才独立生效（跟随作息时和上面同源）
  let inNightSilence = false
  if (config && config.silenceFollowSchedule === false) {
    const s = Number(config.nightSilenceStart)
    const e = Number(config.nightSilenceEnd)
    if (Number.isFinite(s) && Number.isFinite(e) && s !== e) inNightSilence = inHourWindow(minutes, s, e)
  }

  // purpose 的安静时段：附加条件。注意它自带的 asleep===false 短路会让它中途放行，
  // 所以它只能「多拦一道」，不能「放行」。
  let quietNow = false
  if (typeof quiet === 'boolean') quietNow = quiet
  else { try { quietNow = inQuiet(now, config) === true } catch {} }

  const asleep = inScheduleSleep || moodAsleep || inNightSilence

  // 【主人熬夜例外】他要是在熬夜（半夜还在说话），她也醒着 —— 但只在「作息窗口内」生效，
  // 真睡过去了（moodAsleep）不叫醒她。需求：「不要每天晚上刷，如果他晚上决定熬夜可以晚上刷」。
  let ownerNight = { active: false, lastOwnerAt: 0, minutesAgo: -1, reason: '不在夜间窗口' }
  if (inScheduleSleep) {
    try {
      ownerNight = ownerNightAwake({ now, config, messages: Array.isArray(messages) ? messages : null })
    } catch {}
  }
  // 他醒着 → 不按作息窗口拦；但她自己真的睡着了（moodAsleep）仍然算睡。
  const ownerKeepsHerUp = ownerNight.active && !moodAsleep
  const asleepEff = (asleep && !ownerKeepsHerUp) || moodAsleep
  // 主人睡着了没：他最近没说话就算睡了（45 分钟窗口，和 will.mjs 的 ownerAwake 同源）
  let ownerAwakeNow = true
  try {
    const rows = Array.isArray(messages) ? messages : recentMessages(60)
    const ownerQq = String((config && (config.ownerQq || config.accessAdminId)) || '').replace(/\D/g, '')
    let lastAt = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]
      if (!r || r.direction !== 'in') continue
      const uid = String(r.senderId || r.uin || '').replace(/\D/g, '')
      if (ownerQq && uid !== ownerQq) continue
      lastAt = Number(r.ts) || 0
      if (lastAt) break
    }
    if (lastAt) ownerAwakeNow = now - lastAt <= Math.max(5, Number((config && config.biliOwnerAwakeMinutes) || 45)) * 60_000
  } catch {}
  return {
    ownerAsleep: !ownerAwakeNow,
    blocked: (asleepEff || quietNow) && !ownerKeepsHerUp,
    asleep: asleepEff,
    quietNow,
    inScheduleSleep,
    moodAsleep,
    inNightSilence,
    ownerNight,
    ownerKeepsHerUp,
    minutes,
    clock: pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60),
    window: win,
  }
}

// ───────────────────────────────── 主人熬夜时的「陪着他」例外
/**
 * 主人半夜还醒着吗？
 * ============================================================================
 * 需求原话（2026-11-12）：「不要每天晚上刷，如果他晚上决定熬夜可以晚上刷」。
 * 意思是：夜间默认不刷 B 站（别养出「每晚固定刷」的习惯），但如果**主人自己**半夜
 * 还在跟她说话（他决定熬夜），那她也醒着，这时候可以刷——是她陪着他，不是她自己的夜班。
 *
 * 判据只看真实聊天记录里「主人最近有没有说话」，不靠猜：
 *   · 主人最近一条消息在 ownerActiveMinutes（默认 30 分钟）之内，且方向是 in；
 *   · 且这条消息之后她还没回过（他在等）或者刚回完——两种都算他醒着，都放行；
 *   · 只认主人 QQ（config.ownerQq / accessAdminId），别人半夜发消息不算。
 * 状态：不需要持久化，纯读 messages.jsonl。
 * ============================================================================
 * @returns {{active:boolean, lastOwnerAt:number, minutesAgo:number, reason:string}}
 */
export function ownerNightAwake({ now = Date.now(), config = {}, messages = null } = {}) {
  const owner = String((config && (config.ownerQq || config.accessAdminId)) || '').replace(/\D/g, '')
  const limitMin = Math.max(5, Number((config && config.biliOwnerNightAwakeMinutes) || 30))
  if (config && config.biliOwnerNightAwake === false) {
    return { active: false, lastOwnerAt: 0, minutesAgo: -1, reason: '主人熬夜例外被关掉了' }
  }
  let rows = messages
  if (!Array.isArray(rows)) {
    try { rows = recentMessages(60) } catch { rows = [] }
  }
  let lastOwnerAt = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    if (!r || r.direction !== 'in') continue
    const uid = String(r.senderId || r.uin || '').replace(/\D/g, '')
    if (owner && uid !== owner) continue
    lastOwnerAt = Number(r.ts) || 0
    if (lastOwnerAt) break
  }
  if (!lastOwnerAt) return { active: false, lastOwnerAt: 0, minutesAgo: -1, reason: '最近没有主人的消息' }
  const minutesAgo = Math.round((now - lastOwnerAt) / 60000)
  if (minutesAgo < 0) return { active: false, lastOwnerAt, minutesAgo, reason: '时间戳在未来' }
  if (minutesAgo > limitMin) {
    return { active: false, lastOwnerAt, minutesAgo, reason: '主人最后说话是 ' + minutesAgo + ' 分钟前（超过 ' + limitMin + ' 分钟）' }
  }
  return { active: true, lastOwnerAt, minutesAgo, reason: '主人 ' + minutesAgo + ' 分钟前还在说话，他醒着' }
}

/** 给日志用的一句话原因 */
export function sleepReason(st) {
  if (st.ownerKeepsHerUp) return `主人还在熬夜（${(st.ownerNight || {}).minutesAgo} 分钟前还在说话），她陪着`
  if (st.inScheduleSleep) return `她的作息里这个点（${st.window.sleepHour}点–${st.window.wakeHour}点）还在睡`
  if (st.moodAsleep) return '她这会儿真的睡着了'
  if (st.inNightSilence) return '夜里静默时段'
  if (st.quietNow) return '现在处于安静时段'
  return '睡着/安静时段'
}

/**
 * 统一闸门：B 站任何一种自动行为，动手前先问这一句。
 * @param {string} kind BILI_AUTO_KINDS 之一
 * @returns {{ok:boolean, skipped:boolean, reason:string, state:object}}
 */
export function biliAutoAllowed(kind, { now = Date.now(), config = {}, schedule = null, mood = null, quiet = undefined, messages = null } = {}) {
  const st = sleepState({ now, config, schedule, mood, quiet, messages })
  if (config && config.biliSleepGate === false) {
    return { ok: true, skipped: false, reason: '闸门被关掉了（biliSleepGate=false）', state: st }
  }
  // 她自己做的事：只拦「她真的睡过去了」。作息窗口内她醒着 = 她可以自己决定。
  if (isSelfKind(kind)) {
    if (st.moodAsleep) {
      return { ok: false, skipped: true, reason: '她真的睡着了（生理上睡过去了）', state: st }
    }
    return {
      ok: true,
      skipped: false,
      reason: st.inScheduleSleep ? '作息窗口内但她还醒着——要不要做由她自己定' : '醒着',
      state: st,
    }
  }
  // 会到他眼前的动作（分享/私信/@回复/评论接话/日报）：
  // 判定标准只有一条——**主人是不是睡下了**。她的作息窗口不该成为这条的理由：
  // 主人熬夜时她陪着（②），主人睡了她也不去吵他（①），这与她自己的作息无关。
  if (st.ownerAsleep) {
    return { ok: false, skipped: true, reason: '主人那边安静了（他睡了），别去吵他', state: st }
  }
  if (st.moodAsleep) {
    return { ok: false, skipped: true, reason: '她真的睡着了', state: st }
  }
  return {
    ok: true,
    skipped: false,
    reason: st.ownerKeepsHerUp ? '主人还在熬夜，她陪着（夜间例外）' : '醒着',
    state: st,
  }
}
