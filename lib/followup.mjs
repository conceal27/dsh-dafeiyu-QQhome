/**
 * lib/followup.mjs — 「会追问」：记住他说过要做的事，到点自己问一句
 * ============================================================================
 * 区别：
 *   · lib/selfwake.mjs —— 她自己约的时间（「[wake:23:40:想问问他面试]」）和他明确要求的提醒
 *   · 这一层           —— **他没要求提醒，但说漏了自己的计划**（「明天下午面试」「周末去看房」）
 *
 * 真人会记得：第二天下午发一句「怎么样，面试」。这层就干这个。
 *
 * 三条约束：
 *   1. 只认主人私聊。群里别人的计划不进（隐私 + 不装熟）。
 *   2. 必须有明确时间锚点才记，没有时间的一律丢弃——否则会攒一堆「回头」「改天」的烂账。
 *   3. 到点只问一次。他要是已经说过了，她问一句也不尴尬（「刚想起来要问你」）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { addWakeAt, loadWakes } from './selfwake.mjs'

const FILE = 'followup.json'
const MAX_ITEMS = 60

const pathOf = (home) => join(String(home || ''), FILE)

export function loadFollowups(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { items: [] }
  }
}

function save(home, st) {
  try {
    mkdirSync(String(home), { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ items: (st.items || []).slice(-MAX_ITEMS) }), 'utf8')
  } catch {}
}

const PLAN = /(我要|我得|我得去|我准备|我打算|我明天|我后天|我下周|我周末|我下午|我晚上|我今晚|待会儿我|回头我|一会儿我|马上我|我待会)/

// 有时间锚点 + 有具体的事，才值得追
const TIME_ANCHOR = /(明天|明早|明晚|后天|大后天|下周|下礼拜|周末|今晚|今天下午|今天上午|今天晚|下午|上午|晚上|凌晨|待会儿|回头|一会儿|马上)/

const THING = /(面试|体检|考试|复试|开会|加班|看房|搬家|出差|看病|挂号|手术|复诊|入职|报到|答辩|交材料|交作业|报税|报销|回家|坐车|赶车|上车|飞机|高铁|约|见|谈|签|面试|拍照|健身|跑步|洗牙|拿快递|取件|买菜|做饭|吃药|打针|疫苗)/

function pad(n) { return String(n).padStart(2, '0') }

/** 粗解析时间锚点 → { at, label } */
export function parsePlanTime(text, now = Date.now()) {
  const s = String(text || '')
  const d = new Date(now)
  let dayOffset = 0
  if (/后天/.test(s)) dayOffset = 2
  else if (/大后天/.test(s)) dayOffset = 3
  else if (/明天|明早|明晚/.test(s)) dayOffset = 1
  else if (/下周|下礼拜/.test(s)) dayOffset = 7 - d.getDay() + 1
  else if (/周末/.test(s)) dayOffset = (6 - d.getDay() + 7) % 7 || 7

  // 具体钟点
  let hh = null
  let mm = 0
  const m1 = s.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  const m2 = s.match(/([零一二三四五六七八九十\d]{1,3})\s*点\s*(半|\d{1,2}\s*分)?/)
  const cn = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const toNum = (t) => (/^\d+$/.test(t) ? Number(t) : t === '十一' ? 11 : t === '十二' ? 12 : cn[t])
  if (m1) { hh = Number(m1[1]); mm = Number(m1[2]) }
  else if (m2) {
    hh = toNum(m2[1]); mm = m2[2] === '半' ? 30 : m2[2] ? parseInt(m2[2], 10) : 0
  }
  if (hh != null && !Number.isFinite(hh)) hh = null
  if (hh != null && /下午|晚上|傍晚|夜里|今晚|晚/.test(s) && hh < 12) hh += 12

  // 只有「上午/下午/晚上」这种粗锚点，给个默认钟点
  if (hh == null) {
    if (/上午/.test(s)) hh = 10
    else if (/中午/.test(s)) hh = 12
    else if (/下午/.test(s)) hh = 16
    else if (/晚上|今晚|夜里/.test(s)) hh = 20
    else if (/凌晨/.test(s)) hh = 0
    else if (/明早|早上|早晨/.test(s)) hh = 8
    else hh = 20
  }
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hh, mm || 0, 0, 0)
  // 说「待会儿」「一会儿」这种，两小时后
  if (dayOffset === 0 && /待会儿|一会儿|回头|马上/.test(s) && d.getTime() <= now) {
    return { at: now + 2 * 3600_000, label: '过两小时' }
  }
  if (d.getTime() <= now + 5 * 60_000) d.setDate(d.getDate() + 1)
  const label = pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(hh) + ':' + pad(mm || 0)
  return { at: d.getTime(), label }
}

/**
 * 扫一句主人私聊，看看有没有「值得追问的计划」。
 * @returns {{registered:boolean, item?:object, reason?:string}}
 */
export function scanOwnerPlan(home, text, now = Date.now(), config = {}) {
  const s = String(text || '').trim()
  if (config.followupEnabled === false) return { registered: false, reason: 'disabled' }
  if (s.length < 4 || s.length > 300) return { registered: false, reason: 'length' }
  if (!PLAN.test(s)) return { registered: false, reason: 'not-plan' }
  if (!TIME_ANCHOR.test(s)) return { registered: false, reason: 'no-time' }
  if (!THING.test(s)) return { registered: false, reason: 'no-thing' }
  // 他在问她/在撒娇，不是在说自己，别记
  if (/(你|妳)/.test(s) && !/(我明天|我后天|我下周|我周末|我下午|我晚上|我今晚|我要|我得)/.test(s)) {
    return { registered: false, reason: 'about-her' }
  }

  const key = s.replace(/\s+/g, '').slice(0, 30)
  const st = loadFollowups(home)
  const dup = st.items.find((x) => x.key === key && now - Number(x.createdAt || 0) < 7 * 86400_000)
  if (dup) return { registered: false, reason: 'dup' }

  const t = parsePlanTime(s, now)
  if (!t || !Number.isFinite(t.at)) return { registered: false, reason: 'bad-time' }

  // 交给 selfwake 的时间线去发：她到点会自己开口，语气由推送那一步决定
  const note = '他之前说「' + s.slice(0, 80) + '」，到这个点了，问问怎么样了。' +
    '别像闹钟，像突然想起来；他要是已经说了结果，就顺势接一句；他要是嫌你烦，就顶回去。'
  let wake = null
  try { wake = addWakeAt(home, t.at, note) } catch {}
  if (!wake) return { registered: false, reason: 'wake-failed' }

  const item = { key, text: s.slice(0, 160), at: t.at, label: t.label, createdAt: now, wakeId: wake.id }
  st.items.push(item)
  save(home, st)
  return { registered: true, item }
}

/** 面板用 */
export function followupStatus(home, now = Date.now()) {
  const st = loadFollowups(home)
  const pending = st.items.filter((x) => Number(x.at) > now).sort((a, b) => a.at - b.at)
  const past = st.items.filter((x) => Number(x.at) <= now).sort((a, b) => b.at - a.at).slice(0, 20)
  return { ok: true, pending, past, wakeCount: (loadWakes(home).items || []).length }
}
