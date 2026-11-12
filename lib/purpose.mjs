/**
 * lib/purpose.mjs — 目的机制胶水（移植自 SurfCore 的 purpose-engine.js）
 * ============================================================================
 * 作用：把「固定 90 分钟发一次」换成「按目的机制智能决策」：
 *   · 安静时段不打扰（23:30–08:30）
 *   · 主人刚说过话不久 → 不插话（idleThresholdMs = 30 分钟）
 *   · 每日上限（默认 4 条）
 *   · 随机间隔（150–300 分钟）
 *   · 冷却 / 重试
 * 状态：$DSH_HOME/qq-fish/purpose-state.json
 * ============================================================================
 */
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import {
  DEFAULT_PURPOSE_CONFIG,
  normalizePurposeConfig,
  createPurposeState,
  normalizePurposeState,
  evaluatePurposeTick,
  inQuietHours,
  normalizePurposeConfig as normPurposeCfg,
  markPurposeDelivered,
  markPurposeSkip,
  applyPurposeOutcome,
  ensurePurposeDay,
  ensurePurposeSchedule,
  NEED_LABELS,
  PURPOSE_NEEDS,
} from './sc/purpose-engine.mjs'
import { stateHome, recentMessages } from './store.mjs'
import { loadSchedule } from './schedule.mjs'
import { readMood } from './vitals.mjs'

/** 安静时段：silenceFollowSchedule 打开时跟随她的作息（睡下 → 醒来），否则用目的机制自己的设置 */
function withScheduleQuiet(cfg, config) {
  if (!config || config.silenceFollowSchedule === false) return cfg
  try {
    const sch = loadSchedule()
    const sleep = Math.round(Number(sch && sch.sleepHour))
    const wake = Math.round(Number(sch && sch.wakeHour))
    if (Number.isFinite(sleep) && Number.isFinite(wake)) {
      const p2 = (n) => String(((n % 24) + 24) % 24).padStart(2, '0') + ':00'
      return { ...cfg, quietStart: p2(sleep), quietEnd: p2(wake) }
    }
  } catch {}
  return cfg
}

export function inQuiet(now = Date.now(), config = {}) {
  try {
    // 生理上醒着（被消息叫醒/自己起来了）就不算安静时段
    try {
      const m = readMood(stateHome())
      if (m && m.asleep === false) return false
    } catch {}
    const cfg = withScheduleQuiet(normPurposeCfg((config && config.purpose) || {}), config)
    return inQuietHours(now, cfg)
  } catch {
    return false
  }
}

export function purposeStatePath() {
  return join(stateHome(), 'purpose-state.json')
}

export function loadPurposeState(now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(purposeStatePath(), 'utf8'))
    return normalizePurposeState(raw, now)
  } catch {
    return createPurposeState(now)
  }
}

export function savePurposeState(state) {
  try {
    mkdirSync(stateHome(), { recursive: true })
    writeFileSync(purposeStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {}
}

/**
 * 主人（对方）最近一次说话距今多久（毫秒）；没有记录返回 Infinity。
 * 带 5 秒缓存：这个函数每 45 秒被 tick 调一次，而它要读 482 行 JSONL（单次 544ms），
 * 不缓存等于每 45 秒白烧半秒 CPU。
 */
let idleCache = { at: 0, value: Infinity }
export function ownerIdleMs(now = Date.now(), { force = false } = {}) {
  if (!force && now - idleCache.at < 5000) {
    const cached = idleCache.value
    return cached === Infinity ? Infinity : Math.max(0, now - cached.base + cached.offset)
  }
  let last = 0
  for (const m of recentMessages(200)) {
    if (!m || m.direction !== 'in') continue
    if (!String(m.text || '').trim()) continue
    last = Math.max(last, Number(m.ts) || 0)
  }
  const idle = last ? Math.max(0, now - last) : Infinity
  idleCache = { at: now, value: idle === Infinity ? Infinity : { base: now, offset: idle } }
  return idle
}


/**
 * 判断现在该不该主动发。
 * @returns {{run:boolean, reason:string, nextFireAt:number, state:object, cfg:object}}
 */
export function purposeGate({ now = Date.now(), config = {}, busy = false, paused = false, budgetBlocked = false } = {}) {
  const state = loadPurposeState(now)
  const cfg = withScheduleQuiet(normalizePurposeConfig((config && config.purpose) || {}), config)
  const env = {
    enabled: true,
    busy,
    paused,
    budgetBlocked,
    ownerIdleMs: ownerIdleMs(now),
  }
  let verdict
  try {
    verdict = evaluatePurposeTick({ now, config: cfg, state, env })
  } catch (e) {
    return { run: false, reason: 'error:' + String((e && e.message) || e).slice(0, 60), nextFireAt: 0, state, cfg }
  }
  return {
    run: verdict && verdict.action === 'run',
    reason: (verdict && verdict.reason) || 'unknown',
    nextFireAt: (verdict && verdict.nextFireAt) || 0,
    state,
    cfg,
  }
}

export function recordDelivered(now = Date.now(), planned = null, config = {}) {
  const state = loadPurposeState(now)
  try {
    const cfg = withScheduleQuiet(normalizePurposeConfig((config && config.purpose) || {}), config)
    markPurposeDelivered(state, { now, planned })
    // 关键：发送成功后必须排下一次触发，否则每一轮 tick 都会判定「该发了」
    applyPurposeOutcome(state, { now, config: cfg, outcome: 'sent', planned })
    savePurposeState(state)
  } catch {}
}

export function recordSkip(reason = '', now = Date.now(), nextFireAt = 0, config = {}) {
  const state = loadPurposeState(now)
  try {
    const cfg = withScheduleQuiet(normalizePurposeConfig((config && config.purpose) || {}), config)
    markPurposeSkip(state, { reason: String(reason).slice(0, 60), nextFireAt })
    applyPurposeOutcome(state, { now, config: cfg, outcome: 'failed', memo: { purpose: String(reason || '').slice(0, 60) } })
    if (nextFireAt > 0) state.nextFireAt = nextFireAt
    savePurposeState(state)
  } catch {}
}

export function status(now = Date.now(), config = {}) {
  const state = loadPurposeState(now)
  const cfg = withScheduleQuiet(normalizePurposeConfig((config && config.purpose) || {}), config)
  return {
    countToday: Number(state.countToday) || 0,
    dailyMax: cfg.dailyMax,
    nextFireAt: Number(state.nextFireAt) || 0,
    lastDeliveredAt: Number(state.lastDeliveredAt) || 0,
    gapMinMin: Math.round(cfg.gapMinMs / 60000),
    gapMaxMin: Math.round(cfg.gapMaxMs / 60000),
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    idleThresholdMin: Math.round(cfg.idleThresholdMs / 60000),
    needs: PURPOSE_NEEDS.map((n) => ({ key: n, label: NEED_LABELS[n] || n })),
    ownerIdleMs: ownerIdleMs(now),
    recent: Array.isArray(state.history) ? state.history.slice(-5) : [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 【通用冷却闸门】把目的机制里「安静时段 + 主人刚说话 + 每日上限 + 最小间隔 + 冷却重试」
// 这一套原样复用给别的自动行为（B 站自己逛 / 分享）。**不是复制一份新逻辑**：
// 判定仍然交给 sc/purpose-engine.mjs 的 evaluatePurposeTick，排下一次仍然交给
// planNextFire / applyPurposeOutcome，只是状态存在另一个文件里、按 kind 分槽。
// 现有 purposeGate() 的行为一个字节都没改（它还是读 purpose-state.json）。
// ─────────────────────────────────────────────────────────────────────────────

/** 冷却状态文件：默认 $DSH_HOME/qq-fish/cooling.json，结构 { kinds: { [kind]: purposeState } } */
export function coolingStatePath() {
  return join(stateHome(), 'cooling.json')
}

function loadCoolingFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

function saveCoolingFile(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch {}
}

/**
 * 读某个 kind 的冷却状态（不存在就是一份新状态）。
 * @param {string} kind
 * @param {{now?:number, file?:string}} opt
 */
export function loadCoolingState(kind, { now = Date.now(), file = coolingStatePath() } = {}) {
  const data = loadCoolingFile(file)
  const raw = data && data.kinds && data.kinds[String(kind)]
  return normalizePurposeState(raw, now)
}

/** 写回某个 kind 的冷却状态 */
export function saveCoolingState(kind, state, { file = coolingStatePath() } = {}) {
  const data = loadCoolingFile(file)
  const kinds = (data && typeof data.kinds === 'object' && data.kinds) ? data.kinds : {}
  kinds[String(kind)] = state
  saveCoolingFile(file, { ...data, kinds })
}

/** 把一个 kind 的冷却配置收敛成 purpose-engine 认的形状（安静时段默认取她的作息） */
export function coolingConfig({
  gapMinMs = 90 * 60 * 1000,
  gapMaxMs = 180 * 60 * 1000,
  dailyMax = 4,
  idleThresholdMs = 30 * 60 * 1000,
  quietStart = '',
  quietEnd = '',
  retryMs = 15 * 60 * 1000,
  maxAttempts = 2,
  initialDelayMinMs = 5 * 60 * 1000,
} = {}, config = {}) {
  const base = normalizePurposeConfig({}, { ownerQQ: (config && config.ownerQq) || '' })
  let qs = String(quietStart || '')
  let qe = String(quietEnd || '')
  // 没显式给就跟随她的作息（睡下 → 醒来）；和 purposeGate 的 silenceFollowSchedule 同源
  if ((!qs || !qe) && !(config && config.silenceFollowSchedule === false)) {
    try {
      const sch = loadSchedule()
      const sleep = Math.round(Number(sch && sch.sleepHour))
      const wake = Math.round(Number(sch && sch.wakeHour))
      if (Number.isFinite(sleep) && Number.isFinite(wake) && sleep !== wake) {
        const p2 = (n) => String(((n % 24) + 24) % 24).padStart(2, '0') + ':00'
        qs = qs || p2(sleep)
        qe = qe || p2(wake)
      }
    } catch {}
  }
  return normalizePurposeConfig({
    ...base,
    gapMinMs,
    gapMaxMs: Math.max(gapMinMs, gapMaxMs),
    dailyMax,
    idleThresholdMs,
    retryMs,
    maxAttempts,
    initialDelayMinMs,
    ...(qs && qe ? { quietStart: qs, quietEnd: qe } : {}),
  })
}

/**
 * 通用冷却判定。语义与 purposeGate 完全一致（同一份 evaluatePurposeTick）：
 * 安静时段 / 每日上限 / 最小间隔没到 / 主人刚说过话 / 忙 → 都不触发。
 * @returns {{run:boolean, reason:string, nextFireAt:number, state:object, cfg:object}}
 */
export function coolingGate(kind, {
  now = Date.now(),
  config = {},
  stateFile = coolingStatePath(),
  busy = false,
  skipOwnerActive = true,
  // 可注入：调用方已经算过「主人距上次说话多久」时直接传进来（省一次 JSONL 扫描，
  // 也让这条判据可以脱离真实聊天记录单测）
  ownerIdleMs: idleOverride = null,
  ...cfgIn
} = {}) {
  const state = loadCoolingState(kind, { now, file: stateFile })
  const cfg = coolingConfig(cfgIn, config)
  let idle = Infinity
  if (skipOwnerActive) {
    const ov = Number(idleOverride)
    if (idleOverride !== null && idleOverride !== undefined && Number.isFinite(ov)) idle = Math.max(0, ov)
    else { try { idle = ownerIdleMs(now) } catch { idle = Infinity } }
  }
  const env = { enabled: true, busy, paused: false, budgetBlocked: false, ownerIdleMs: skipOwnerActive ? idle : Infinity }
  try {
    ensurePurposeDay(state, now)
    // 第一次用：排一个初始延迟，别一开就立刻刷
    if (!state.nextFireAt) ensurePurposeSchedule(state, { now, config: cfg })
  } catch {}
  let verdict
  try {
    verdict = evaluatePurposeTick({ now, config: cfg, state, env })
  } catch (e) {
    return { run: false, reason: 'error:' + String((e && e.message) || e).slice(0, 60), nextFireAt: 0, state, cfg }
  }
  // evaluatePurposeTick 内部会跨天重置 countToday，这里顺手落盘保住这个重置
  try { saveCoolingState(kind, state, { file: stateFile }) } catch {}
  return {
    run: !!(verdict && verdict.action === 'run'),
    reason: (verdict && verdict.reason) || 'unknown',
    nextFireAt: (verdict && verdict.nextFireAt) || 0,
    state,
    cfg,
  }
}

/** 冷却记账：这次真做了 → 占今日次数 + 排下一次（复用 applyPurposeOutcome） */
export function recordCoolingSent(kind, {
  now = Date.now(),
  config = {},
  stateFile = coolingStatePath(),
  text = '',
  ...cfgIn
} = {}) {
  const state = loadCoolingState(kind, { now, file: stateFile })
  const cfg = coolingConfig(cfgIn, config)
  try {
    markPurposeDelivered(state, { now })
    state.lastText = String(text || '').slice(0, 200)
    applyPurposeOutcome(state, { now, config: cfg, outcome: 'sent' })
  } catch {}
  saveCoolingState(kind, state, { file: stateFile })
  return state
}

/** 冷却记账：试了但没成功（不会占次数，但会记一笔并安排重试） */
export function recordCoolingSkip(kind, {
  now = Date.now(),
  config = {},
  stateFile = coolingStatePath(),
  reason = '',
  ...cfgIn
} = {}) {
  const state = loadCoolingState(kind, { now, file: stateFile })
  const cfg = coolingConfig(cfgIn, config)
  try {
    markPurposeSkip(String(reason).slice(0, 60), now, 0)
    saveCoolingState(kind, state, { file: stateFile })
  } catch {}
  return state
}

/** 面板/日志用：某个 kind 现在的冷却状态 */
export function coolingStatus(kind, { now = Date.now(), config = {}, stateFile = coolingStatePath(), ...cfgIn } = {}) {
  const state = loadCoolingState(kind, { now, file: stateFile })
  const cfg = coolingConfig(cfgIn, config)
  return {
    kind: String(kind),
    countToday: Number(state.countToday) || 0,
    dailyMax: cfg.dailyMax,
    nextFireAt: Number(state.nextFireAt) || 0,
    lastSentAt: Number(state.lastSentAt) || 0,
    gapMinMin: Math.round(cfg.gapMinMs / 60000),
    gapMaxMin: Math.round(cfg.gapMaxMs / 60000),
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    idleThresholdMin: Math.round(cfg.idleThresholdMs / 60000),
    lastSkip: state.lastSkip || null,
  }
}
