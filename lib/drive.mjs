/**
 * lib/drive.mjs — 开口冲动：她自己决定「现在想不想说话」
 * 不是定时器到点就发，而是把四个信号合成一个 0~1 的冲动值：
 *   精力（作息 + 生理周期）× 心情 × 动机（想做/想问）× 关系（亲密度）
 *
 * 用法：
 *   - 常规触发仍由 purpose-engine 定时兜底（保证她不会彻底消失）
 *   - 但冲动够高、又有具体理由（有想做的事 / 有问题想问）时，允许提前开口
 * 这个模块只做判断，不发送；发不发由 push.mjs 决定。
 * ============================================================================
 */
import { stateHome } from './store.mjs'
import { loadSchedule } from './schedule.mjs'
import { loadBody, cycleDay, phaseOf } from './body.mjs'
import { activeIntents } from './intent.mjs'
import { pendingCuriosity } from './curiosity.mjs'
import { socialFactor, sulkState } from './social.mjs'

function hourOf(now) {
  return new Date(now).getHours()
}

/** 按作息判断此刻醒着没（sleep 可以是 0~4 的凌晨） */
function isAwake(hour, sch) {
  const wake = Number(sch && sch.wakeHour)
  const sleep = Number(sch && sch.sleepHour)
  if (!Number.isFinite(wake) || !Number.isFinite(sleep)) return hour >= 8 || hour < 1
  if (wake <= sleep) return hour >= wake && hour < sleep
  return hour >= wake || hour < sleep
}

/**
 * 计算此刻的开口冲动。
 * @returns {Promise<{drive:number, motive:string, reason:string, breakIn:boolean, signals:object}>}
 */
export async function computeDrive({ config = {}, now = Date.now() } = {}) {
  const signals = {}
  // ① 精力
  let energy = 0.6
  try {
    const sch = loadSchedule()
    energy = isAwake(hourOf(now), sch) ? 0.75 : 0.2
    signals.awake = isAwake(hourOf(now), sch)
  } catch {}
  let phase = ''
  try {
    const b = await loadBody()
    const day = cycleDay(b)
    phase = phaseOf(day, b)
    if (phase === 'period') energy *= 0.7
    else if (phase === 'pms') energy *= 0.85
    else if (phase === 'ovulation') energy = Math.min(1, energy + 0.15)
    signals.phase = phase
  } catch {}
  signals.energy = Number(energy.toFixed(2))

  // ② 心情（读 mood 状态，拿不到就用中性值）
  let mood = 0.5
  try {
    // 改用 vitals 的效价（0~1）。旧代码用中文键读七情，键名对不上，
    // 这个信号一直卡在默认值 0.6 从没生效过。
    const m = await import('./vitals.mjs')
    const raw = m.readMood(stateHome())
    const filled = m.syncAffect({ ...raw }, Date.now())
    mood = Math.max(0.1, Math.min(1, Number(filled.valence) || 0.5))
    signals.moodLabel = filled.emotion_level || ''
    signals.moodDerived = {
      energy: Math.round((filled.energy || 0) * 100),
      irritability: Math.round((filled.irritability || 0) * 100),
      clinginess: Math.round((filled.clinginess || 0) * 100),
      loneliness: Math.round((filled.loneliness || 0) * 100),
    }
  } catch {}
  signals.mood = Number(mood.toFixed(2))

  // ③ 动机：有没有具体想做的事 / 想问的问题（最强的信号）
  let motive = 'none'
  let motiveScore = 0.25
  let reason = '没什么特别想说的'
  try {
    const intents = await activeIntents()
    const curious = await pendingCuriosity(3)
    if (intents.length) {
      motive = 'intent'
      motiveScore = 0.95
      reason = intents[0].text
    } else if (curious.length) {
      motive = 'curiosity'
      motiveScore = 0.8
      reason = '一直想问：「' + curious[0].word + '」'
    }
  } catch {}
  signals.motive = motive
  signals.motiveScore = motiveScore

  // ④ 关系：越熟越敢主动
  let relation = 0.3
  try {
    const b = await loadBody()
    relation = Math.min(1, (Number(b.intimacy) || 0) / 200)
  } catch {}
  signals.relation = Number(relation.toFixed(2))

  const raw = 0.35 * motiveScore + 0.25 * energy + 0.2 * relation + 0.2 * mood
  // ⑤ 社交状态：她主动过但你没回，会自己收敛；赌气了就憋着
  let social = 1
  let sulk = { sulking: false }
  try {
    social = await socialFactor()
    sulk = await sulkState()
  } catch {}
  signals.social = Number(social.toFixed(2))
  if (sulk.sulking) signals.sulking = true

  const drive = raw * social
  const d = Number(drive.toFixed(3))

  // 破例条件：动力足 + 有具体理由 + 不在赌气
  // 0.68 不是「外部限额」，是「她真的想」的下限；赌气时再想也憋着。
  const breakIn = d >= 0.68 && motive !== 'none' && !sulk.sulking

  return { drive: d, motive, reason, breakIn, signals, raw: Number(raw.toFixed(3)) }
}

/**
 * 给「主动搭话」用的一句话：告诉她为什么现在开口。
 * 没理由就返回空串（那就老老实实按定时器来）。
 */
export async function driveHint({ config = {}, now = Date.now() } = {}) {
  const d = await computeDrive({ config, now })
  if (!d.breakIn) return { hint: '', drive: d }
  const why = d.motive === 'intent'
    ? `你心里一直搁着一件事：「${d.reason}」。现在正好有机会，可以自然地提起来。`
    : d.motive === 'curiosity'
      ? `你惦记着${d.reason}，可以找个话头问一句——别像查词典。`
      : ''
  return { hint: why, drive: d }
}
