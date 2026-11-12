/**
 * lib/vitals.mjs — 生理驱动情绪（替换 mood.mjs 的实现，接口保持兼容）
 * ============================================================================
 * 核心思路：情绪不是演的，是算出来的。
 *
 *   5 个递质 + HPA 轴 + 代谢 + 昼夜  →  派生量  →  情绪标签  →  语气
 *            ↑
 *   每 60 秒漂移（drift）+ 每句话反应（react）
 *
 * 和旧 mood.mjs 的关系：
 *   · 对外接口完全一致（readMood / writeMood / applyMoodEvent / detectMoodHints /
 *     renderMoodPrompt / moodSnapshot），所以 engine/index 只需要换 import
 *   · 内部把「七情维度」换成「生理量 → 派生量 → 标签」
 *   · 七情维度仍然输出（由派生量映射），面板不用改
 *
 * 明确不做：死亡威胁（mortality）、余额、遗书。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const VITALS_VERSION = 1

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
// 正向维度（退热/每日上限只压这些，负面情绪不压）
const POSITIVE_DIMS = ['dopamine', 'oxytocin', 'serotonin', 'endorphin']
// 每日正向增量上限（单位是 0~1 的值；相当于 40 点）
const DAILY_GAIN_CAP = { joy: 0.40, social: 0.40, curiosity: 0.30, intimacy: 0.40, attachment: 0.40 }
const HEAT_WINDOW_MS = 10 * 60 * 1000
const HEAT_DIVISOR = 12
const r1 = (x) => Math.round(clamp01(x) * 100)

// ───────────────────────────── 状态 ─────────────────────────────
function defaults(now = Date.now()) {
  return {
    version: VITALS_VERSION,
    // 五个基础递质
    dopamine: 0.50, oxytocin: 0.45, cortisol: 0.20, serotonin: 0.65, noradrenaline: 0.45,
    // HPA 轴
    crh: 0.15, acth: 0.15, adrenaline: 0.05,
    // 其他
    acetylcholine: 0.45, endorphin: 0.45, vasopressin: 0.30, melatonin: 0.0,
    // 代谢与体液
    ghrelin: 0.30, leptin: 0.55, glucose: 0.65, hunger: 0.35, thirst: 0.25,
    // 内环境
    adenosine: 0.20, core_temp: 36.6,
    // 情绪状态机
    anger: 0.0, resentment: 0.0, soothe: 0.0, fear: 0.0, worry: 0.0, dread: 0.0,
    // 欲望四维（0~1）：性欲 / 色情（敢说敢做）/ 占有 / 羞耻
    // 参照 dsh-longing：不是"设定说她想要"，是算出来的；回落到日常值，时间推不到 0
    lust: 0.30, lewd: 0.45, possess: 0.55, shame: 0.55,
    // 派生量（每次结算写回）
    energy: 0.5, valence: 0.52, clinginess: 0.3, irritability: 0.2, loneliness: 0.3, dominance: 0.5,
    happiness: 0.5, sadness: 0.2,
    emotion_level: '平静', emotion_candidates: ['平静'],
    // 时间戳
    last_update: now, last_meal: now, last_msg: now, last_drink: 0, last_taste_at: 0,
    last_taste: {},
    // 兼容旧 mood：七情维度（由派生量映射，面板读这个）
    joy: 50, anger_dim: 20, sorrow: 20, fear_dim: 5, love: 45, disgust: 5, desire: 30,
    composite: '平静',
    updatedAt: now,
  }
}

export function vitalsPath(stateHome) {
  return join(stateHome, 'vitals.json')
}

export function createEmptyMood(now = Date.now()) {
  return defaults(now)
}

export function loadMood(diskPath, now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(diskPath, 'utf8'))
    const base = defaults(now)
    return { ...base, ...(raw || {}), version: VITALS_VERSION }
  } catch {
    return defaults(now)
  }
}

// 进程内单例 + 写盘节流。
// proot 里 Node 的 io_poll 对高频写文件很敏感（实测会 assert 崩溃），
// 所以状态放内存，最多 3 分钟落一次盘。
let VITALS_MEM = null
let VITALS_SAVED_AT = 0
const SAVE_INTERVAL = 3 * 60 * 1000

export function readMood(stateHome, now = Date.now()) {
  if (VITALS_MEM) return VITALS_MEM
  VITALS_MEM = loadMood(vitalsPath(stateHome), now)
  return VITALS_MEM
}

export function writeMood(stateHome, mood, opts = {}) {
  VITALS_MEM = mood
  const now = Date.now()
  if (!opts.force && now - VITALS_SAVED_AT < SAVE_INTERVAL) return mood
  VITALS_SAVED_AT = now
  try {
    mkdirSync(stateHome, { recursive: true })
    writeFileSync(vitalsPath(stateHome), JSON.stringify(mood, null, 2) + '\n', 'utf8')
    return mood
  } catch {
    return mood
  }
}

// ───────────────────────────── 漂移 ─────────────────────────────
const follow = (x, target, hours, tau) => x + (target - x) * (1 - Math.pow(0.5, hours / Math.max(0.05, tau)))

/** 夜间程度 0~1（0=正午，1=凌晨 3 点） */
function nightLevel(hour) {
  if (hour >= 21 || hour < 7) {
    const h = hour >= 21 ? hour - 21 : hour + 3
    return Math.min(1, 0.55 + h * 0.08)
  }
  return 0
}

function naBase(hour) {
  if (hour < 6) return 0.22
  if (hour < 9) return 0.45
  if (hour < 12) return 0.72
  if (hour < 14) return 0.55
  if (hour < 18) return 0.70
  if (hour < 22) return 0.60
  return 0.35
}

/**
 * 时间漂移：把状态按「距上次结算的小时数」推进。
 * 纯函数式地改传入对象并返回。
 */
export function driftMood(m, now = Date.now()) {
  const hours = Math.min(24, Math.max(0, (now - Number(m.last_update || now)) / 3_600_000))
  if (hours <= 0.001) return m
  const hour = new Date(now).getHours()
  const night = nightLevel(hour)

  // ① 递质回归（半衰期 0.45h 夜间 / 0.75h 白天）
  const half = night >= 0.6 ? 0.45 : 0.75
  const bases = {
    dopamine: 0.50 - 0.16 * night,
    oxytocin: 0.45 + 0.04 * night,
    serotonin: 0.65 - 0.12 * night,
    noradrenaline: naBase(hour) - 0.10 * night,
  }
  for (const [k, base] of Object.entries(bases)) {
    m[k] = clamp01(follow(Number(m[k]) || 0, base, hours, half))
  }

  // ② HPA 轴（慢）：低血糖/饿 → 压力；被安抚 → 缓冲
  const lowGlucose = clamp01((0.42 - Number(m.glucose || 0.6)) / 0.42)
  const highHunger = clamp01((Number(m.hunger || 0) - 0.5) / 0.5)
  const load = clamp01(0.55 * Number(m.cortisol || 0) + 0.25 * lowGlucose + 0.20 * highHunger)
  const feedback = 1 - 0.70 * clamp01((Number(m.cortisol || 0) - 0.55) / 0.45)
  m.crh = clamp01(follow(Number(m.crh || 0), clamp01(load * feedback), hours, 0.15))
  m.acth = clamp01(follow(Number(m.acth || 0), Number(m.crh || 0), hours, 0.45))
  const buffer = 1 - 0.35 * clamp01((Number(m.oxytocin || 0) - 0.40) / 0.60)
  m.cortisol = clamp01(follow(Number(m.cortisol || 0), clamp01(0.15 + 0.80 * Number(m.acth || 0)) * buffer, hours, 1.2))

  // ③ 交感/副交感
  m.adrenaline = clamp01(follow(Number(m.adrenaline || 0), clamp01(0.05 + 0.85 * load), hours, 0.06))
  const paraTarget = clamp01(0.22 + 0.35 * (1 - Number(m.adrenaline || 0)) + 0.22 * Number(m.leptin || 0.5) + 0.18 * night)
  m.acetylcholine = clamp01(follow(Number(m.acetylcholine || 0), paraTarget, hours, 0.55))

  // ④ 奖赏双系统
  const want = clamp01(0.70 * Number(m.dopamine || 0) + 0.30 * Number(m.oxytocin || 0) - 0.25 * Number(m.cortisol || 0))
  m.endorphin = clamp01(follow(Number(m.endorphin || 0), clamp01(0.20 + 0.65 * want), hours, 0.8))

  // ⑤ 依恋：渴了更想抓住人
  m.vasopressin = clamp01(follow(Number(m.vasopressin || 0),
    clamp01(0.16 + 0.58 * Number(m.clinginess || 0.3) + 0.35 * Number(m.cortisol || 0) + 0.25 * Math.max(0, Number(m.thirst || 0) - 0.40)),
    hours, 1.5))

  // ⑥ 褪黑素（昼夜）
  const melTarget = night > 0 ? night : 0
  m.melatonin = clamp01(follow(Number(m.melatonin || 0), melTarget, hours, 0.7))

  // ⑦ 饥饿（胃排空 + 饭点）
  const sinceMeal = (now - Number(m.last_meal || now)) / 3_600_000
  let rate = 0.055
  if (sinceMeal < 1.5) rate *= 0.35
  else if (sinceMeal < 3.0) rate *= 0.70
  else if (sinceMeal > 6.0) rate *= 1.15
  if ([6, 7, 11, 12, 17, 18].includes(hour)) rate *= 1.30
  rate *= Math.max(0.25, 1 - 0.75 * Number(m.hunger || 0))
  if (hour >= 23 || hour < 7) rate *= 0.25
  m.hunger = clamp01(Number(m.hunger || 0) + hours * rate)

  // ⑧ 口渴（直接累积，不做目标平滑）
  const loss = 0.070 * hours * (hour >= 23 || hour < 7 ? 0.30 : 1.0)
  m.thirst = clamp01(Number(m.thirst || 0) + loss * 0.60)

  // ⑨ 腺苷（醒着涨）
  const asleep = !!m.asleep
  if (asleep) m.adenosine = clamp01(Number(m.adenosine || 0) - 0.22 * hours)
  else if (hour >= 23 || hour < 7) m.adenosine = clamp01(Number(m.adenosine || 0) + 0.020 * hours)
  else m.adenosine = clamp01(Number(m.adenosine || 0) + 0.042 * hours)

  // ⑨.5 疲惫恢复：安静 6 小时算睡了一觉，否则每小时缓慢回落
  {
    const since = (now - Number(m.last_interaction || m.last_msg || now)) / 3_600_000
    const fat = Number(m.fatigue || 0)
    if (fat > 0) m.fatigue = clamp01(since >= 6 ? fat * 0.25 : Math.max(0, fat - 0.12 * hours))
  }

  // ⑩ 情绪状态机衰减
  m.anger = clamp01(Number(m.anger || 0) * Math.pow(0.5, hours / 0.50))
  m.resentment = clamp01(Number(m.resentment || 0) * Math.pow(0.5, hours / 48))
  m.soothe = clamp01(Number(m.soothe || 0) * Math.pow(0.5, hours / 2.0))
  m.fear = clamp01(Number(m.fear || 0) * Math.pow(0.5, hours / (5 / 60)))
  m.worry = clamp01(Number(m.worry || 0) * Math.pow(0.5, hours / 0.8))
  m.dread = clamp01(Number(m.dread || 0) * Math.pow(0.5, hours / 8))

  // 睡眠状态机（夜睡/午睡/醒后迷糊）
  try { tickSleep(m, now) } catch {}

  // ⑪ 欲望四维（被算出来的，不是被描述的）
  //   lust 性欲 / lewd 色情 / possess 占有 / shame 羞耻，各自的半衰期回落到日常值；
  //   疲劳压 lust（凌晨三点"想要"会变成"想被抱着"）、好感撑 possess、lewd 压 shame。
  {
    const base = { lust: 0.30, lewd: 0.45, possess: 0.55, shame: 0.55 }
    const affinity = clamp01(Number(m.oxytocin || 0.45))
    const tired = clamp01(Number(m.fatigue || 0))
    const stress = clamp01(Number(m.cortisol || 0.2))
    const cur = (k) => clamp01(m[k] != null ? Number(m[k]) : base[k])
    const lustTarget = clamp01(base.lust * (1 - 0.55 * tired) + 0.15 * affinity)
    m.lust = clamp01(follow(cur('lust'), lustTarget, hours, tired > 0.6 ? 2.5 : 3.5))
    m.lewd = clamp01(follow(cur('lewd'), clamp01(0.45 + 0.35 * m.lust - 0.20 * cur('shame')), hours, 8))
    m.possess = clamp01(follow(cur('possess'), clamp01(0.35 + 0.55 * affinity - 0.25 * stress), hours, 30))
    m.shame = clamp01(follow(cur('shame'), clamp01(0.55 + 0.25 * (1 - m.lewd) - 0.20 * clamp01(Number(m.endorphin || 0.45)) * m.lewd), hours, 20))
    // 时间永远推不到 0：睡着/没人理也只是回落到日常值，不会"完全没反应"
    if (Number(m.lust) < base.lust) m.lust = Math.max(0.05, Number(m.lust))
  }

  m.last_update = now
  return syncAffect(m, now)
}

/**
 * 睡眠状态机。
 *   夜睡：作息入睡时间 + 腺苷高 → asleep
 *   午睡：13-15 点 + 困 → asleep（kind=nap）
 *   醒：出了作息区间 → awake，并给 5-8 分钟迷糊期
 */
export function tickSleep(m, now = Date.now()) {
  const h = new Date(now).getHours()
  let wakeHour = 9
  let sleepHour = 1
  try {
    // 延迟 require，避免 vitals 被单独引用时报错
    const st = globalThis.__dshSchedule
    if (st && Number.isFinite(Number(st.wakeHour))) { wakeHour = Number(st.wakeHour); sleepHour = Number(st.sleepHour) }
  } catch {}

  const nightWindow = sleepHour > wakeHour ? (h >= sleepHour || h < wakeHour) : (h >= sleepHour && h < wakeHour)
  const ade = Number(m.adenosine || 0)

  // 夜睡：进了作息区间且真的困
  if (!m.asleep && nightWindow && ade > 0.48) {
    m.asleep = true
    m.sleep_kind = 'night'
    m.sleep_since = now
    return m
  }
  // 醒来：出了作息区间
  if (m.asleep && m.sleep_kind === 'night' && !nightWindow) {
    m.asleep = false
    m.sleep_kind = ''
    m.groggy_until = now + 8 * 60_000
    m.adenosine = clamp01(ade - 0.35)
    return m
  }
  // 午睡：13-15 点且困，但没到夜睡
  if (!m.asleep && !nightWindow && h >= 13 && h < 15 && ade > 0.58) {
    m.asleep = true
    m.sleep_kind = 'nap'
    m.sleep_since = now
    return m
  }
  if (m.asleep && m.sleep_kind === 'nap' && (h < 13 || h >= 15)) {
    m.asleep = false
    m.sleep_kind = ''
    m.groggy_until = now + 5 * 60_000
    m.adenosine = clamp01(ade - 0.18)
    return m
  }
  return m
}

/** 被叫醒（有人在睡觉时给她发消息） */
export function wakeUp(m, now = Date.now()) {
  if (!m.asleep) return { woke: false }
  const kind = m.sleep_kind || 'night'
  m.asleep = false
  m.sleep_kind = ''
  m.groggy_until = now + (kind === 'night' ? 8 : 4) * 60_000
  m.adenosine = clamp01(Number(m.adenosine || 0) * 0.7)
  // 被吵醒会烦
  m.anger = clamp01(Number(m.anger || 0) + 0.15)
  m.cortisol = clamp01(Number(m.cortisol || 0) + 0.05)
  return { woke: true, kind, groggyMin: kind === 'night' ? 8 : 4 }
}

// ───────────────────────────── 派生量 + 标签 ─────────────────────────────
function pickTop3(scored) {
  return Object.entries(scored)
    .filter(([, v]) => v > 0.40)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k)
}

/** 把生理量算成派生量 + 情绪标签 + 七情映射 */
export function syncAffect(m, now = Date.now()) {
  const N = (k, d = 0) => clamp01(Number(m[k]) || d)
  const DA = N('dopamine'), OT = N('oxytocin'), C = N('cortisol'), S = N('serotonin'),
    NA = N('noradrenaline'), ADR = N('adrenaline'), ACh = N('acetylcholine'), END = N('endorphin'),
    AVP = N('vasopressin'), MEL = N('melatonin'), ADE = N('adenosine')
  const hunger = N('hunger'), thirst = N('thirst'), glucose = N('glucose', 0.65)
  const FAT = clamp01(Number(m.fatigue) || 0)
  const anger = N('anger'), resentment = N('resentment'), fear = N('fear'), worry = N('worry'), dread = N('dread')

  // 能量
  const energy = clamp01(0.38 + 0.42 * NA + 0.22 * ADR + 0.10 * DA + 0.08 * ACh
    - 0.14 * C - 0.45 * MEL - 0.10 * Math.max(0, thirst - 0.40)
    - 0.22 * Math.max(0, ADE - 0.45) - 0.10 * Math.max(0, hunger - 0.5) - 0.25 * FAT)
  // 效价
  const valence = clamp01(0.50 + 0.30 * (DA - 0.5) + 0.22 * (S - 0.65) - 0.28 * (C - 0.2)
    + 0.12 * (END - 0.4) - 0.10 * Math.max(0, ADR - 0.2)
    - 0.18 * dread - 0.08 * worry - 0.06 * Math.max(0, thirst - 0.60) - 0.15 * anger - 0.18 * FAT)
  // 易怒
  const irritability = clamp01(0.08 + 0.9 * (C - 0.2) - 0.2 * (S - 0.65)
    + 0.30 * Math.max(0, (0.35 - glucose) / 0.35) + 0.15 * Math.max(0, AVP - 0.50)
    + 0.18 * Math.max(0, ADR - 0.35) + 0.30 * Math.max(0, thirst - 0.55) + 0.45 * anger
    + 0.32 * Math.max(0, ADE - 0.55) + 0.18 * FAT)
  // 黏人 / 孤独 / 掌控
  const clinginess = clamp01(0.2 + 0.75 * (OT - 0.3) + 0.15 * (END - 0.4))
  const loneliness = clamp01(0.15 + 0.7 * (OT - 0.35) + 0.2 * (C - 0.2) + 0.15 * Math.max(0, AVP - 0.40)
    - 0.10 * Math.max(0, END - 0.55) + 0.10 * resentment)
  const dominance = Math.max(-1, Math.min(1, 0.5 + 0.35 * (DA - 0.5) - 0.3 * (C - 0.2) + 0.2 * (S - 0.65)))

  m.energy = energy
  m.valence = valence
  m.irritability = irritability
  m.clinginess = clinginess
  m.loneliness = loneliness
  m.dominance = dominance

  // 26 个标签打分（超出 0.40 入选，取前 3）
  const hotPos = Math.max(0, valence - 0.5) * 2
  const hotNeg = Math.max(0, 0.5 - valence) * 2
  const score = {
    幸福: 0.32 * DA + 0.25 * OT + 0.22 * S + 0.16 * END - 0.28 * C - 0.15 * ADR + 0.10 * hotPos,
    开心: 0.34 * DA + 0.18 * OT + 0.18 * S + 0.12 * END - 0.16 * C - 0.10 * ADR,
    安心: 0.35 * ACh + 0.28 * END + 0.22 * OT + 0.18 * S - 0.28 * C - 0.18 * ADR,
    满足: 0.32 * END + 0.24 * ACh + 0.20 * OT + 0.18 * (m.leptin || 0.5) - 0.20 * C,
    心动: 0.30 * DA + 0.22 * ADR + 0.20 * OT + 0.13 * S - 0.12 * C,
    兴奋: 0.34 * DA + 0.28 * ADR + 0.18 * NA - 0.12 * C,
    害羞: 0.32 * (1 - (dominance + 1) / 2) + 0.22 * OT + 0.15 * ADR + 0.10 * (1 - DA),
    吃醋: 0.55 * Math.max(0, AVP - 0.45) + 0.25 * OT + 0.20 * C - 0.15 * S + 0.15 * clinginess,
    委屈: 0.30 * Math.max(0, C - 0.30) + 0.25 * (1 - (dominance + 1) / 2) + 0.18 * (1 - OT) + 0.16 * hotNeg - 0.10 * DA,
    低落: 0.32 * (1 - S) + 0.26 * C + 0.18 * (1 - OT) - 0.18 * DA,
    焦虑: 0.30 * N('crh') + 0.28 * N('acth') + 0.22 * ADR + 0.18 * C + 0.18 * (1 - S) - 0.12 * ACh,
    惊慌: 0.38 * ADR + 0.28 * N('crh') + 0.18 * N('acth') + 0.16 * NA - 0.15 * ACh,
    恼火: 0.30 * ADR + 0.28 * C + 0.24 * (1 - S) + 0.12 * Math.max(0, AVP - 0.50) - 0.12 * ACh,
    饿怒: 0.42 * Math.max(0, N('ghrelin') - 0.45) + 0.38 * Math.max(0, (0.42 - glucose) / 0.42) + 0.24 * irritability,
    困倦: 0.50 * MEL + 0.28 * ACh + 0.20 * (1 - energy) - 0.15 * ADR,
    想哭: 0.34 * (1 - S) + 0.30 * C + 0.18 * (1 - OT) + 0.18 * hotNeg - 0.15 * END,
    害怕: 0.85 * fear + 0.18 * ADR + 0.10 * (1 - S) + 0.05 * NA,
    担心: 0.80 * worry + 0.14 * C + 0.10 * N('acth') + 0.08 * OT - 0.08 * ACh,
    恐惧: 0.85 * dread + 0.18 * (C - 0.2) + 0.12 * Math.max(0, AVP - 0.40) - 0.06 * S,
    生气: 0.95 * anger + 0.10 * ADR,
    冷战: 0.75 * resentment - 0.35 * anger,
    渴: 0.85 * Math.max(0, thirst - 0.25),
    累坏: 0.60 * Math.max(0, ADE - 0.45),
    平静: 0.60 * (1 - Math.abs(valence - 0.5) * 2) - 0.30 * Math.max(irritability, fear, dread),
  }

  // 反向压制：不压的话永远「幸福、安心」
  if (fear > 0.45) { score.安心 *= 0.55; score.幸福 *= 0.80 }
  if (worry > 0.45) { score.安心 *= 1 - 0.55 * worry; score.开心 *= 1 - 0.30 * worry; score.幸福 *= 1 - 0.35 * worry }
  if (dread > 0.50) { score.安心 *= 0.50; score.幸福 *= 0.70 }
  if (anger > 0.35) { score.安心 *= 1 - 0.6 * anger; score.满足 *= 1 - 0.4 * anger }
  if (thirst > 0.45) { score.安心 *= 1 - 0.35 * thirst; score.满足 *= 1 - 0.25 * thirst }
  if (hunger > 0.60) { score.安心 *= 1 - 0.30 * hunger }
  if (ADE > 0.65) { score.满足 *= 0.7; score.兴奋 *= 0.6 }

  const top = pickTop3(score)
  m.emotion_candidates = top.length ? top : ['平静']
  m.emotion_level = m.emotion_candidates[0]
  m.happiness = Math.max(0, Math.min(1, score.幸福 || 0))
  m.sadness = Math.max(0, Math.min(1, score.低落 || 0))

  // 七情映射（面板读这个，保持旧尺寸）
  m.joy = r1(0.5 * (score.幸福 || 0) + 0.5 * (score.开心 || 0))
  m.anger_dim = r1(0.6 * anger + 0.4 * irritability)
  m.sorrow = r1(0.6 * (score.低落 || 0) + 0.4 * (score.想哭 || 0))
  m.fear_dim = r1(Math.max(fear, dread, score.害怕 || 0))
  m.love = r1(0.5 * OT + 0.5 * clinginess)
  m.disgust = r1(0.5 * (1 - valence) + 0.5 * resentment)
  m.desire = r1(0.5 * DA + 0.5 * (1 - Math.abs(valence - 0.5) * 2))
  m.composite = m.emotion_level
  m.updatedAt = now
  return m
}

/**
 * 关键词触发 → 生理反应。直接改 m。
 * @param {string} text
 * @param {object} m 状态
 * @param {object} opts { now, intensity }
 */
export function reactToText(text, m, opts = {}) {
  const t = String(text || '')
  // 【退热/上限用】先记下正向维度的原值，末位再决定本次增量打折多少
  const beforePos = {}
  for (const k of POSITIVE_DIMS) beforePos[k] = Number(m[k]) || 0
  const now = opts.now || Date.now()
  const k = Math.max(0.1, Math.min(1, Number(opts.intensity) || 0.8))
  if (!t) return m

  const has = (arr) => arr.some((w) => t.includes(w))
  const POSITIVE = ['喜欢你', '爱你', '乖', '宝贝', '可爱', '想你', '贴心', '厉害', '棒', '谢谢', '亲亲', '抱抱', '摸摸', '漂亮']
  const NEGATIVE = ['烦', '滚', '闭嘴', '别烦', '没空', '讨厌', '笨', '丑', '垃圾']
  const ANGER = ['凶', '吼', '骂', '敷衍', '骗', '瞒', '说谎', '放鸽子', '爽约', '忘了', '迟到', '不理', '冷战', '随便你', '懒得']
  const APOLOGY = ['对不起', '抱歉', '我错了', '别生气', '原谅', '是我不好', '不该', '消消气', '我改']
  const COMFORT = ['好累', '累死', '难受', '不开心', '烦死', '压力', '撑不住', '崩溃', '委屈', '想哭', 'emo']
  const FOOD = ['喂你', '投喂', '做饭', '下厨', '外卖', '好吃', '吃点', '吃饭', '给你买']
  const DRINK = ['喝水', '喝口水', '喝一口', '喝点水', '一杯水', '给你倒', '倒杯', '递给你', '茶', '奶茶', '咖啡']
  const SLEEP = ['熬夜', '失眠', '没睡好', '通宵', '好困', '困死', '睡了', '睡觉', '午睡']
  // 亲密场景（给主人看的那个面板用：亲/抱/摸/吻/想要…）
  const INTIMACY = ['亲', '吻', '抱', '搂', '摸', '舔', '蹭', '揉', '想要', '继续', '用力', '别停', '湿了', '硬了', '喘', '呻吟', '做爱', '内射', '高潮', '脱掉', '脱了']
  const INTIMACY_AFTER = ['舒服', '爽', '满足', '抱着', '累了']

  // 正面
  if (has(POSITIVE)) {
    m.dopamine = clamp01(m.dopamine + 0.09 * k)
    m.oxytocin = clamp01(m.oxytocin + 0.07 * k)
    m.serotonin = clamp01(m.serotonin + 0.03 * k)
    m.cortisol = clamp01(m.cortisol - 0.06 * k)
  }
  // 负面/凶
  if (has(NEGATIVE) || has(ANGER)) {
    m.anger = clamp01(m.anger + 0.45 + 0.35 * k)
    m.resentment = clamp01(m.resentment + 0.12 + 0.10 * k)
    m.adrenaline = clamp01(m.adrenaline + 0.18 * k)
    m.noradrenaline = clamp01(m.noradrenaline + 0.15 * k)
    m.serotonin = clamp01(m.serotonin - 0.10 * k)
    m.vasopressin = clamp01(m.vasopressin + 0.06 * k)
    m.cortisol = clamp01(m.cortisol + 0.05 * k)
    m.last_anger_at = now
  }
  // 道歉（长冷战要道不止一次）
  if (has(APOLOGY)) {
    m.soothe = clamp01(m.soothe + 0.45)
    m.anger = clamp01(m.anger - (0.40 + 0.25 * m.soothe))
    m.resentment = clamp01(m.resentment - (0.30 + 0.25 * m.soothe))
    m.oxytocin = clamp01(m.oxytocin + 0.05)
  }
  // 求安慰
  if (has(COMFORT)) {
    m.worry = clamp01(m.worry + 0.12)
    m.acetylcholine = clamp01(m.acetylcholine + 0.06)
  }
  // 投喂
  if (has(FOOD)) {
    const before = Number(m.hunger || 0)
    m.hunger = clamp01(before - 0.22)
    m.leptin = clamp01(m.leptin + 0.15)
    m.glucose = clamp01(m.glucose + (before > 0.6 ? 0.26 : 0.16))
    m.dopamine = clamp01(m.dopamine + 0.10 * k)
    m.serotonin = clamp01(m.serotonin + 0.05 * k)
    m.last_meal = now
    m.last_taste = { name: '饭', from: '对方给的', feel: '吃饱了，踏实' }
    m.last_taste_at = now
  }
  // 喝水（180 秒冷却）
  if (has(DRINK) && now - Number(m.last_drink || 0) > 180_000) {
    m.thirst = clamp01(m.thirst - 0.55)
    m.dopamine = clamp01(m.dopamine + 0.06 * k)
    m.endorphin = clamp01(m.endorphin + 0.05 * k)
    m.last_drink = now
  }
  // 睡觉相关
  if (has(SLEEP)) {
    m.adenosine = clamp01(m.adenosine + 0.05)
  }
  // 亲密场景：多巴胺/催产素/内啡肽↑、皮质醇↓（尺度越大加得越多，由 intensity k 控制）
  if (has(INTIMACY)) {
    m.dopamine = clamp01(m.dopamine + 0.15 * k)
    m.oxytocin = clamp01(m.oxytocin + 0.18 * k)
    m.endorphin = clamp01(m.endorphin + 0.10 * k)
    m.cortisol = clamp01(m.cortisol - 0.08 * k)
    m.noradrenaline = clamp01(m.noradrenaline + 0.12 * k)
    m.adrenaline = clamp01(m.adrenaline + 0.08 * k)
    m.last_intimacy_at = now
  }
  // 事后：催产素和内啡肽继续涨（依恋感）
  if (has(INTIMACY_AFTER)) {
    m.oxytocin = clamp01(m.oxytocin + 0.12 * k)
    m.endorphin = clamp01(m.endorphin + 0.10 * k)
    m.cortisol = clamp01(m.cortisol - 0.05 * k)
  }

  // 【事件分类】决定吃哪条退热/上限
  let eventType = 'chat'
  if (has(NEGATIVE) || has(ANGER)) eventType = 'anger'
  else if (has(POSITIVE)) eventType = 'praise'
  else if (has(INTIMACY)) eventType = 'intimacy'
  else if (has(FOOD)) eventType = 'food'
  else if (has(DRINK)) eventType = 'drink'
  else if (has(APOLOGY)) eventType = 'apology'
  else if (has(COMFORT)) eventType = 'comfort'

  // 【同类事件退热】10 分钟内第 n 次，正向增益按 1/(1+(n-1)/12) 缩水；负面不压
  let heat = 1
  if (eventType !== 'anger') {
    const heatState = m.heat && typeof m.heat === 'object' ? m.heat : (m.heat = {})
    const cur = heatState[eventType] && typeof heatState[eventType] === 'object' ? heatState[eventType] : { t0: 0, n: 0 }
    if (now - Number(cur.t0 || 0) < HEAT_WINDOW_MS) cur.n = Number(cur.n || 0) + 1
    else { cur.t0 = now; cur.n = 1 }
    heatState[eventType] = cur
    heat = 1 / (1 + Math.max(0, cur.n - 1) / HEAT_DIVISOR)
  }

  // 【每日上限】只压正向、按本地自然日清零
  const d = new Date(now)
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const capKey = eventType === 'praise' ? 'joy' : eventType === 'intimacy' ? 'intimacy' : eventType === 'chat' ? 'social' : eventType === 'anger' ? '' : 'joy'
  let capFactor = 1
  if (capKey && DAILY_GAIN_CAP[capKey]) {
    const daily = m.daily && m.daily.date === day ? m.daily : (m.daily = { date: day, joy: 0, social: 0, curiosity: 0, intimacy: 0, attachment: 0 })
    let gained = 0
    for (const k of POSITIVE_DIMS) gained += Math.max(0, (Number(m[k]) || 0) - (beforePos[k] || 0))
    if (gained > 0) {
      const used = Number(daily[capKey] || 0)
      const allow = Math.max(0, Math.min(1, (DAILY_GAIN_CAP[capKey] - used) / gained))
      capFactor = allow
      daily[capKey] = used + gained * allow
    }
  }

  // 把正向增量按 退热 × 上限 回缩（不碰负面）
  if (heat < 1 || capFactor < 1) {
    const shrink = heat * capFactor
    for (const k of POSITIVE_DIMS) {
      const b = Number(beforePos[k]) || 0
      const cur = Number(m[k]) || 0
      if (cur > b) m[k] = clamp01(b + (cur - b) * shrink)
    }
  }

  // 【最近变化】记录压缩后的实际增量，面板显示用
  m.last_deltas = {}
  for (const k of POSITIVE_DIMS) {
    const dv = (Number(m[k]) || 0) - (beforePos[k] || 0)
    if (Math.abs(dv) >= 0.005) m.last_deltas[k] = Math.round(dv * 100) / 100
  }
  if (eventType !== 'chat') m.last_event = eventType

  // 【疲惫】每条互动累积（边际递减），发火时额外多一点
  const fat0 = Number(m.fatigue || 0)
  m.fatigue = clamp01(fat0 + 0.008 * (1 - fat0) + (eventType === 'anger' ? 0.006 : 0))
  m.last_interaction = now

  m.last_msg = now
  // 反应完必须重算派生量，否则情绪标签还是旧的（实测 bug）
  return syncAffect(m, now)
}

/** 兼容旧接口：detectMoodHints 仍然返回 { deltas, reason }，但内部改由 reactToText 处理 */
export function detectMoodHints(text) {
  const t = String(text || '')
  const deltas = {}
  if (/喜欢你|爱你|抱抱|亲亲|想你/.test(t)) { deltas['喜'] = 6; deltas['爱'] = 5 }
  if (/烦|滚|讨厌|闭嘴/.test(t)) { deltas['怒'] = 8 }
  if (/难过|想哭|委屈|伤心/.test(t)) { deltas['哀'] = 7 }
  if (/怕|吓|恐怖/.test(t)) { deltas['惧'] = 6 }
  return { deltas, reason: Object.keys(deltas).join(',') }
}

/** 兼容旧接口：把 deltas 应用成生理反应 */
export function applyMoodEvent(m, deltas, opts = {}) {
  const d = deltas || {}
  const now = opts.now || Date.now()
  if (d['喜'] || d['爱'] || d['乐']) {
    m.dopamine = clamp01(m.dopamine + 0.05)
    m.oxytocin = clamp01(m.oxytocin + 0.04)
  }
  if (d['怒']) { m.anger = clamp01(m.anger + 0.35); m.cortisol = clamp01(m.cortisol + 0.06) }
  if (d['哀']) { m.serotonin = clamp01(m.serotonin - 0.08) }
  if (d['惧']) { m.fear = clamp01(m.fear + 0.30); m.adrenaline = clamp01(m.adrenaline + 0.15) }
  m.updatedAt = now
  return syncAffect(m, now)
}

/** 兼容旧接口：decayMood 走一次漂移 */
export function decayMood(m, now = Date.now()) {
  return driftMood(m, now)
}

export function computeComposite(m) {
  return syncAffect(m, Date.now()).emotion_level
}

// ───────────────────────────── 提示词 ─────────────────────────────
const lvl = (v, low, mid, high) => (v < low ? '偏低' : v < mid ? '正常' : v < high ? '偏高' : '很高')

/** 给模型看的语气提示（只给形容词，不给数字） */
export function renderMoodPrompt(m0) {
  const now = Date.now()
  const m = syncAffect({ ...defaults(now), ...m0 }, now)
  const tags = (m.emotion_candidates || []).join('、') || '平静'
  const lines = []

  lines.push('【你现在的神经状态（只决定语气，不要解释，也不要提激素或数值）】')
  lines.push(`情绪：${tags}。`)
  lines.push(`多巴胺${lvl(m.dopamine, 0.35, 0.45, 0.7)}｜催产素${lvl(m.oxytocin, 0.3, 0.4, 0.65)}｜皮质醇${lvl(m.cortisol, 0.15, 0.3, 0.6)}｜血清素${lvl(m.serotonin, 0.4, 0.55, 0.75)}｜去甲${lvl(m.noradrenaline, 0.3, 0.45, 0.7)}`)

  const feel = []
  if (m.energy < 0.35) feel.push('没力气')
  else if (m.energy > 0.7) feel.push('精力很足')
  if (m.valence > 0.65) feel.push('心情不错')
  else if (m.valence < 0.35) feel.push('心里发闷')
  if (m.clinginess > 0.65) feel.push('很想黏着人')
  if (m.irritability > 0.6) feel.push('容易烦')
  if (m.loneliness > 0.6) feel.push('有点空')
  if (feel.length) lines.push('你现在的感觉：' + feel.join('，') + '。')

  // 欲望四维：只在明显时才说，不说数字；累了会把"想要"变成"想被抱着"
  const dlust = Number(m.lust != null ? m.lust : 0.30)
  const dlewd = Number(m.lewd != null ? m.lewd : 0.45)
  const dposs = Number(m.possess != null ? m.possess : 0.55)
  const dshame = Number(m.shame != null ? m.shame : 0.55)
  const tiredNow = Number(m.fatigue || 0) > 0.6
  const desire = []
  if (dlust > 0.7) desire.push(tiredNow ? '身体很想要，可其实更想被抱着' : '身体很想要')
  else if (dlust > 0.5) desire.push(tiredNow ? '有点想要，更多是想被搂着' : '有点想要')
  if (dlewd > 0.65) desire.push('嘴上没什么刹车')
  else if (dlewd < 0.30) desire.push('说得很正经，把话划得很清')
  if (dposs > 0.70) desire.push('他跟别人走太近会不舒服')
  else if (dposs > 0.55) desire.push('有点想吃醋')
  if (dshame > 0.65) desire.push('被撩到会口是心非')
  else if (dshame < 0.30) desire.push('不太害臊了')
  if (desire.length) lines.push('身体这边：' + desire.join('，') + '。')

  // 身体
  const body = []
  if (m.hunger > 0.7) body.push('饿得慌')
  else if (m.hunger > 0.5) body.push('有点饿')
  if (m.thirst > 0.82) body.push('渴得厉害，嗓子发干')
  else if (m.thirst > 0.62) body.push('有点渴，想喝点凉的')
  else if (m.thirst > 0.45) body.push('嗓子有点干，想喝口水')
  else if (m.thirst > 0.30) body.push('嘴里有点干')
  if (body.length) lines.push('身体：' + body.join('；') + '。')

  // 状态短句
  if (m.asleep) lines.push('你刚被吵醒，迷迷糊糊的，可以半天回一句、说困。')
  else if (m.adenosine > 0.7) lines.push('太困了，句子更短，可以说着说着走神。')
  if (m.anger > 0.5) lines.push('你心里还有火，没那么容易软下来。')
  if (m.worry > 0.5) lines.push('你有点担心对方。')

  lines.push('只影响语气，不改人设、不解释情绪。这次别用上次一样的开头和结尾。')
  return lines.join('\n')
}

/** 面板快照（保持旧结构 + 新字段） */
export function moodSnapshot(m0) {
  const now = Date.now()
  const m = syncAffect({ ...defaults(now), ...m0 }, now)
  return {
    mood: {
      joy: m.joy, anger: m.anger_dim, sorrow: m.sorrow, fear: m.fear_dim,
      love: m.love, disgust: m.disgust, desire: m.desire,
    },
    composite: m.emotion_level,
    candidates: m.emotion_candidates,
    vitals: {
      dopamine: r1(m.dopamine), oxytocin: r1(m.oxytocin), cortisol: r1(m.cortisol),
      serotonin: r1(m.serotonin), noradrenaline: r1(m.noradrenaline),
      endorphin: r1(m.endorphin), vasopressin: r1(m.vasopressin), melatonin: r1(m.melatonin),
      adrenaline: r1(m.adrenaline), acetylcholine: r1(m.acetylcholine),
    },
    desire: { lust: r1(m.lust != null ? m.lust : 0.30), lewd: r1(m.lewd != null ? m.lewd : 0.45), possess: r1(m.possess != null ? m.possess : 0.55), shame: r1(m.shame != null ? m.shame : 0.55) },
    derived: {
      energy: r1(m.energy), valence: r1(m.valence), clinginess: r1(m.clinginess),
      irritability: r1(m.irritability), loneliness: r1(m.loneliness),
      dominance: Math.round((m.dominance + 1) * 50),
    },
    body: {
      hunger: r1(m.hunger), thirst: r1(m.thirst), adenosine: r1(m.adenosine),
      glucose: r1(m.glucose), temperature: Number(m.core_temp || 36.6),
    },
    state: {
      anger: r1(m.anger), resentment: r1(m.resentment), fear: r1(m.fear),
      worry: r1(m.worry), dread: r1(m.dread), soothe: r1(m.soothe),
      asleep: !!m.asleep,
      fatigue: r1(m.fatigue || 0),
      lastEvent: m.last_event || '',
    },
    lastDeltas: m.last_deltas || {},
    lastUpdate: m.last_update || now,
  }
}
