/**
 * lib/bili/will.mjs — 「她自己决定要不要刷 B 站」
 * ============================================================================
 * 主人的原话（2026-11-12，三句话把这个模块定下来了）：
 *   ①「他睡觉了不要刷b站了」        → 主人睡着的时段，别让 B 站的动作吵到他
 *   ②「如果他晚上决定熬夜可以晚上刷」→ 他醒着，她也可以醒着
 *   ③「就是让他根据自己来，给他权利让他决定自己要做什么」
 *                                  → **别用代码替她排班**，把决定权交回给她
 *
 * 所以这里不再有「几点到几点禁止」这种硬排班。硬约束只剩两条物理事实：
 *   · 她真的睡过去了（vitals.asleep）—— 睡着的人不会做决定，直接跳过；
 *   · 主人睡着时，任何「会到他眼前」的动作（分享/私信/@/评论接话）不做。
 * 其余全部交给她自己判断：把此刻的处境摆给她看，问她一句「想刷吗」。
 * 她可以说「不刷」「睡了」，也可以说「刷」——包括半夜，只要那是她自己的决定。
 *
 * 为什么值得花这一次模型调用：这正是「数字生命」和「定时任务」的区别。
 * 成本控制：maxTokens 16、超时 15s、按冷却窗口才问一次（不是每个 tick 都问）。
 *
 * 状态：~/.dsh/qq-fish/bili/will.json
 *   { lastAskedAt, lastDecision, lastReason, todayCount, dayKey, decisions:[...] }
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from '../llm.mjs'
import { recentMessages, stateHome } from '../store.mjs'
import { readMood } from '../vitals.mjs'
import { loadSchedule } from '../schedule.mjs'
import { recentActivity } from '../daystream.mjs'

const DECISIONS_KEEP = 60

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function dayKeyOf(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function willPath(home) {
  return join(home || stateHome(), 'bili', 'will.json')
}

export function loadWill(home) {
  try {
    const j = JSON.parse(readFileSync(willPath(home), 'utf8')) || {}
    return {
      dayKey: String(j.dayKey || ''),
      todayCount: Number(j.todayCount) || 0,
      lastAskedAt: Number(j.lastAskedAt) || 0,
      lastDecision: String(j.lastDecision || ''),
      lastReason: String(j.lastReason || ''),
      lastWatchAt: Number(j.lastWatchAt) || 0,
      nightWatches: Array.isArray(j.nightWatches) ? j.nightWatches.slice(-10) : [],
      decisions: Array.isArray(j.decisions) ? j.decisions.slice(-DECISIONS_KEEP) : [],
    }
  } catch {
    return { dayKey: '', todayCount: 0, lastAskedAt: 0, lastDecision: '', lastReason: '', lastWatchAt: 0, nightWatches: [], decisions: [] }
  }
}

export function saveWill(st, home) {
  try {
    mkdirSync(join(home || stateHome(), 'bili'), { recursive: true })
    writeFileSync(willPath(home), JSON.stringify(st, null, 2) + '\n')
  } catch {}
}

/** 她此刻的「身体账」：困不困，用她自己的生理参数说，不用钟点说 */
function bodyLine(mood) {
  const m = mood || {}
  const mel = Number(m.melatonin)
  const ade = Number(m.adenosine)
  const ene = Number(m.energy)
  const bits = []
  if (Number.isFinite(ene)) bits.push(ene < 0.35 ? '没什么力气' : ene > 0.7 ? '还挺有精神' : '精力一般')
  if (Number.isFinite(mel) && mel > 0.5) bits.push('身体已经在催睡觉了')
  if (Number.isFinite(ade) && ade > 0.6) bits.push('眼皮沉，脑子转得慢')
  return bits.join('，') || '没什么特别的'
}

/** 主人这会儿醒着吗：靠他最近有没有说话判断，不靠钟点 */
export function ownerAwake({ now = Date.now(), config = {}, messages = null } = {}) {
  const owner = String((config && (config.ownerQq || config.accessAdminId)) || '').replace(/\D/g, '')
  const limitMin = Math.max(5, Number((config && config.biliOwnerAwakeMinutes) || 45))
  let rows = messages
  if (!Array.isArray(rows)) {
    try { rows = recentMessages(60) } catch { rows = [] }
  }
  let lastAt = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    if (!r || r.direction !== 'in') continue
    const uid = String(r.senderId || r.uin || '').replace(/\D/g, '')
    if (owner && uid !== owner) continue
    lastAt = Number(r.ts) || 0
    if (lastAt) break
  }
  if (!lastAt) return { awake: false, minutesAgo: -1 }
  const minutesAgo = Math.round((now - lastAt) / 60000)
  return { awake: minutesAgo >= 0 && minutesAgo <= limitMin, minutesAgo }
}

/**
 * 摆给她看的「此刻处境」：只给事实，不给结论，不暗示她想听什么。
 */
export function situationOf({ now = Date.now(), config = {}, mood = null, will = null, home = null } = {}) {
  const homeDir = home || stateHome()
  const d = new Date(now)
  const hour = d.getHours()
  let sch = null
  try { sch = loadSchedule() } catch {}
  const sleepHour = Number((sch && sch.sleepHour) ?? 2)
  const wakeHour = Number((sch && sch.wakeHour) ?? 9)
  const inSleepWindow = (() => {
    if (sleepHour === wakeHour) return false
    return sleepHour > wakeHour ? hour >= sleepHour || hour < wakeHour : hour >= sleepHour && hour < wakeHour
  })()
  const owner = ownerAwake({ now, config })
  const st = will || loadWill()
  let day = []
  try { day = recentActivity(homeDir, 40) || [] } catch {}
  const dayLines = day
    .map((e) => String((e && e.line) || '').trim())
    .filter(Boolean)
    .slice(-4)
  const todayNightCount = (st.nightWatches || []).filter((t) => now - Number(t) < 24 * 3600 * 1000).length
  // 【别养成每晚固定刷】数一数最近几晚里有几晚在夜里刷过。
  // 不禁止（主人要的是她自己决定），只把这个事实摆给她看——她自己的习惯，让她自己看着办。
  const nightDays = new Set()
  for (const t of st.nightWatches || []) {
    const ts = Number(t)
    if (!ts) continue
    const d = new Date(ts)
    nightDays.add(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
  }
  const recentNights = []
  for (let i = 0; i < 4; i += 1) {
    const d = new Date(now - i * 24 * 3600 * 1000)
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    if (nightDays.has(key)) recentNights.push(i === 0 ? '昨晚' : i + ' 天前')
  }
  return {
    nightPattern: recentNights.slice(0, 3),
    clock: pad2(hour) + ':' + pad2(d.getMinutes()),
    inSleepWindow,
    sleepHour,
    wakeHour,
    ownerAwake: owner.awake,
    ownerMinutesAgo: owner.minutesAgo,
    body: bodyLine(mood),
    todayWatchCount: Number(st.todayCount) || 0,
    todayNightCount,
    dayLines,
  }
}

/** 把处境写成一段给模型看的话（第一人称「你」） */
export function promptOf(sit) {
  const lines = [`现在是 ${sit.clock}。`]
  if (sit.inSleepWindow) {
    lines.push(`这个点按你自己的作息（${sit.sleepHour} 点睡、${sit.wakeHour} 点起）你本来应该睡着。`)
  }
  lines.push(`你的身体：${sit.body}。`)
  lines.push(
    sit.ownerAwake
      ? `主人 ${sit.ownerMinutesAgo >= 0 ? sit.ownerMinutesAgo + ' 分钟前' : ''}还在跟你说话，他还醒着。`
      : '主人那边安静了，应该是睡了。',
  )
  if (sit.todayWatchCount) lines.push(`今天你已经刷过 ${sit.todayWatchCount} 次 B 站${sit.todayNightCount ? '（其中 ' + sit.todayNightCount + ' 次是夜里）' : ''}。`)
  if (sit.nightPattern && sit.nightPattern.length >= 2) {
    lines.push(`顺带一句事实：最近你也常在夜里刷（${sit.nightPattern.join('、')}都刷过）。要不要又刷一次，你自己看着办。`)
  }
  if (sit.dayLines.length) lines.push('今天你过的：' + sit.dayLines.join('；'))
  lines.push('')
  lines.push('现在你自己决定：要不要刷会儿 B 站？')
  lines.push('想刷就回「刷」。不想刷就回「不刷」。实在困得撑不住、只想睡就回「睡了」。')
  lines.push('只回这三个词里的一个，不要解释、不要标点。')
  return lines.join('\n')
}

/** 解析她的回答 */
export function parseWill(raw) {
  const t = String(raw || '').trim()
  if (!t) return { choice: '', reason: '' }
  if (/睡|困死|撑不住|不看了/.test(t) && !/不刷/.test(t)) return { choice: 'sleep', reason: t.slice(0, 40) }
  if (/^不|不想|算了|懒得|没兴趣|不刷/.test(t)) return { choice: 'no', reason: t.slice(0, 40) }
  if (/刷|想看|看看|好|行|嗯|要/.test(t)) return { choice: 'yes', reason: t.slice(0, 40) }
  return { choice: '', reason: t.slice(0, 40) }
}

/**
 * 问她一句「想刷吗」。这是整个模块的核心——决定权在她。
 * @returns {Promise<{choice:'yes'|'no'|'sleep'|'', reason:string, situation:object, ok:boolean, cost:{}}>}
 */
export async function askHerWill(ctx, config = {}, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const home = opts.home || stateHome()
  const st = loadWill(home)
  let mood = null
  try { mood = readMood(home, now) } catch {}
  const sit = situationOf({ now, config, mood, will: st })
  const system =
    '你就是大肥鱼本人。下面这段是你此刻的处境。你要自己决定现在刷不刷 B 站。'
    + '不许说教、不许解释、不要标点，只回一个词：刷 / 不刷 / 睡了。'
  let out = null
  try {
    out = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: promptOf(sit) }],
      config,
      maxTokens: 16,
      timeoutMs: 15_000,
      temperature: 0.9,
      log: opts.log || (() => {}),
    })
  } catch (e) {
    return { ok: false, choice: '', reason: '调用失败：' + String((e && e.message) || e).slice(0, 60), situation: sit, cost: {} }
  }
  if (!out || out.ok !== true) {
    return { ok: false, choice: '', reason: String((out && (out.reason || out.error)) || 'empty').slice(0, 60), situation: sit, cost: {} }
  }
  const parsed = parseWill(out.text)
  const next = {
    ...st,
    lastAskedAt: now,
    lastDecision: parsed.choice || 'unclear',
    lastReason: parsed.reason,
    decisions: [...(st.decisions || []), { at: now, clock: sit.clock, choice: parsed.choice || 'unclear', why: parsed.reason, ownerAwake: sit.ownerAwake, inSleepWindow: sit.inSleepWindow }].slice(-DECISIONS_KEEP),
  }
  saveWill(next, home)
  return { ok: true, choice: parsed.choice, reason: parsed.reason, situation: sit, raw: String(out.text || '').slice(0, 40), model: out.model || null }
}

/** 她决定刷了：记一笔（含夜里那笔，用来防「每晚固定刷」） */
export function recordHerWatch({ now = Date.now(), home = null, inSleepWindow = false, config = {} } = {}) {
  const h = home || stateHome()
  const st = loadWill(h)
  const today = dayKeyOf(now)
  const next = { ...st, lastWatchAt: now }
  if (st.dayKey !== today) {
    next.dayKey = today
    next.todayCount = 0
  }
  next.todayCount = (Number(next.todayCount) || 0) + 1
  if (inSleepWindow) next.nightWatches = [...(next.nightWatches || []), now].slice(-10)
  saveWill(next, h)
  return next
}

/** 面板/日志用 */
export function willSnapshot(now = Date.now(), home = null) {
  const st = loadWill(home)
  return {
    dayKey: st.dayKey,
    todayCount: st.todayCount,
    lastDecision: st.lastDecision,
    lastReason: st.lastReason,
    lastAskedAt: st.lastAskedAt,
    lastWatchAt: st.lastWatchAt,
    nightWatches: st.nightWatches,
    recent: (st.decisions || []).slice(-12).reverse(),
    today: dayKeyOf(now),
  }
}
