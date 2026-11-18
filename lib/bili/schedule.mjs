/**
 * lib/bili/schedule.mjs — 她每天一份「B 站浏览时间表」（D 项，对齐 AstrBot 插件）
 * ============================================================================
 * 参考实现：AstrBot 插件 astrbot_plugin_bilibili_ai_bot 的 core/schedule_mixin.py
 *   _generate_daily_schedule()  每天生成一组主动视频时间点（PROACTIVE_TIMES_COUNT=5）
 *   _schedule_slot_due()        到点只触发一次（GRACE 内），不补旧的
 *   _save_schedule_state()      状态存 date + times + triggered
 *   main.py 主循环里还有硬闸门 in_sleep → 睡眠时段直接 continue
 *
 * 这里的做法**不调用模型**（不为了排时间多花一次 token）：
 *   · 时间池来自她当天的作息：schedule.json 的 wakeHour→sleepHour，
 *     叠加 dayplan/YYYY-MM-DD.json 的时段块（有就用，没有就用作息）；
 *   · 从「清醒且没在睡/吃」的时段里用确定性模板挑落点（每段取中段，避免刚睡醒/快睡着），
 *     再叠加一点按日期哈希出来的抖动（同一天重算结果稳定，不同天不一样）；
 *   · 跨天自动重新生成；睡眠闸门另算（awake.mjs），这里只保证时间点落在清醒时段。
 *
 * 状态：$DSH_HOME/qq-fish/bili/schedule.json
 *   { date, times:['HH:MM'], triggered:['HH:MM'], generatedAt, wakeHour, sleepHour, source }
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSchedule } from '../schedule.mjs'
import { stateHome } from '../store.mjs'

export const MIN_SLOTS = 3
export const MAX_SLOTS = 5
/** 到点后多久之内还算「该触发」，超了就当错过了（不补） */
export const TRIGGER_GRACE_MINUTES = 20

/** 「吃/忙」类活动：不排浏览时间点（她在吃饭、出门办事的时候刷视频不自然） */
const BUSY_RE = /吃|饭|煮|做饭|洗澡|洗漱|上班|上课|开会|通勤|路上|运动|跑步|健身|考试|面试|睡|午睡|打盹/

function pad2(n) { return String(n).padStart(2, '0') }
function hm(minutes) { return pad2(Math.floor(minutes / 60) % 24) + ':' + pad2(minutes % 60) }

export function dateKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 'HH:MM' → 当天分钟；非法返回 null */
export function parseHM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (!(h >= 0 && h <= 24) || !(mi >= 0 && mi <= 59)) return null
  return (h % 24) * 60 + mi
}

/**
 * B 站状态目录。
 * 统一口径：**不传 home 就走 store.stateHome()**（插件里其它模块都这么干，尊重 DSH_HOME）。
 * 传了 home 时兼容两种写法，免得调用方踩坑：
 *   · home = 状态目录（就是 stateHome() 的返回值，形如 .../qq-fish）→ 直接用它；
 *   · home = 真实家目录（例如 ~）→ 补 /.dsh/qq-fish。
 * 判断依据只看末尾是不是 qq-fish，简单且不会误判。
 */
export function biliDir(home) {
  if (home) {
    const p = String(home)
    return path.basename(p) === 'qq-fish' ? path.join(p, 'bili') : path.join(p, '.dsh', 'qq-fish', 'bili')
  }
  try {
    const sh = stateHome()
    if (sh) return path.join(sh, 'bili')
  } catch {}
  return path.join(os.homedir(), '.dsh', 'qq-fish', 'bili')
}
export function schedulePath(home) { return path.join(biliDir(home), 'schedule.json') }

function readJson(p, dflt) {
  try {
    let text = fs.readFileSync(p, 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    return JSON.parse(text)
  } catch { return dflt }
}

export function loadBiliSchedule(home) {
  const raw = readJson(schedulePath(home), null)
  if (!raw || typeof raw !== 'object') return { date: '', times: [], triggered: [] }
  return {
    date: String(raw.date || ''),
    times: (Array.isArray(raw.times) ? raw.times : []).map(String).filter((t) => parseHM(t) != null).slice(0, MAX_SLOTS),
    triggered: (Array.isArray(raw.triggered) ? raw.triggered : []).map(String),
    generatedAt: Number(raw.generatedAt) || 0,
    wakeHour: Number(raw.wakeHour),
    sleepHour: Number(raw.sleepHour),
    source: String(raw.source || ''),
  }
}

export function saveBiliSchedule(home, st) {
  const file = schedulePath(home)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch { return false }
}

/** 她的作息窗口（轻量版，避免和 bili/awake.mjs 互相 import 造成循环依赖） */
function sleepWindowOf(schedule = null) {
  let sch = schedule
  if (!sch) { try { sch = loadSchedule() } catch { sch = null } }
  const s = Number(sch && sch.sleepHour)
  const w = Number(sch && sch.wakeHour)
  const sleepHour = Number.isFinite(s) ? ((Math.round(s) % 24) + 24) % 24 : 2
  const wakeHour = Number.isFinite(w) ? ((Math.round(w) % 24) + 24) % 24 : 9
  return { sleepHour, wakeHour, startMin: sleepHour * 60, endMin: wakeHour * 60 }
}

/** 稳定哈希（同一个 seed 每次得到同一个数，不同天不一样） */
function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 窗口是否跨午夜（start > end） */
function crossesMidnight(startMin, endMin) { return startMin > endMin }

/**
 * 从作息 + 当天日程里算出「可以刷 B 站的清醒段」。
 * @returns {{startMin:number, endMin:number, source:string}[]}
 */
export function awakeWindows({ schedule = null, dayplan = null } = {}) {
  const sch = schedule || (() => { try { return loadSchedule() } catch { return null } })()
  const sleepH = Number((sch && sch.sleepHour) ?? 2)
  const wakeH = Number((sch && sch.wakeHour) ?? 9)
  const wakeMin = (Math.round(wakeH) % 24) * 60
  const sleepMin = (Math.round(sleepH) % 24) * 60
  // 清醒段 = wake → sleep（跨午夜时是 wake..1440 与 0..sleep）
  const awake = []
  if (wakeMin < sleepMin) awake.push({ startMin: wakeMin, endMin: sleepMin })
  else if (wakeMin > sleepMin) { awake.push({ startMin: wakeMin, endMin: 1440 }); awake.push({ startMin: 0, endMin: sleepMin }) }
  else awake.push({ startMin: 0, endMin: 1440 }) // 睡醒同点 = 不设睡眠窗口

  // 当天日程块：只留「醒着且不忙」的段，并夹在清醒段内
  const items = Array.isArray(dayplan && dayplan.items) ? dayplan.items : []
  const usable = []
  for (const it of items) {
    const s = parseHM(it && it.start)
    const e = parseHM(it && it.end)
    if (s == null || e == null) continue
    const label = String((it && (it.activity || '')) + ' ' + (it && (it.location || '')) + ' ' + (it && (it.detail || '')))
    if (/睡/.test(label)) continue
    const busy = BUSY_RE.test(label)
    const span = e > s ? e - s : (1440 - s) + e
    if (span < 30) continue
    // 忙的时段只要它的后半段（吃完通常还剩点时间），睡的时段整段丢掉
    const startMin = busy ? s + Math.round(span * 0.55) : s
    const endMinRaw = e
    usable.push({ startMin, endMin: endMinRaw, source: busy ? 'dayplan-half' : 'dayplan', span: (endMinRaw > startMin ? endMinRaw - startMin : (1440 - startMin) + endMinRaw) })
  }

  const pool = []
  if (usable.length >= 2) {
    for (const u of usable) {
      if (u.span < 40) continue
      // 夹进清醒段
      for (const a of awake) {
        const s = Math.max(u.startMin, a.startMin)
        const e = Math.min(u.endMin === 0 ? 1440 : u.endMin, a.endMin)
        if (e - s >= 40) pool.push({ startMin: s, endMin: e, source: 'dayplan' })
      }
    }
  }
  if (!pool.length) for (const a of awake) if (a.endMin - a.startMin >= 60) pool.push({ startMin: a.startMin, endMin: a.endMin, source: 'sleepwindow' })
  pool.sort((x, y) => x.startMin - y.startMin)
  return pool
}

/**
 * 生成当天的时间点（纯函数，可单测）。
 * @param {{now?:number, date?:string, schedule?:object, dayplan?:object, count?:number, random?:Function}} opt
 * @returns {{times:string[], windows:object[], source:string}}
 */
export function generateTimes({ now = Date.now(), date = '', schedule = null, dayplan = null, count = 0, random = null } = {}) {
  const day = date || dateKey(now)
  const pool = awakeWindows({ schedule, dayplan })
  const want = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Number(count) || 0 || randomCount(day)))
  const seed = hash32('bili|' + day)
  const slots = []
  if (!pool.length) return { times: [], windows: pool, source: 'none' }

  // 把可用总时长切成 want 份，每份取中段（避开刚醒/刚要睡），再加按日期哈希的抖动
  const totalSpan = pool.reduce((acc, w) => acc + (w.endMin - w.startMin), 0)
  let cursor = 0
  for (let i = 0; i < want; i++) {
    const share = totalSpan / want
    const mid = cursor + share / 2
    cursor += share
    // mid（相对总轴的偏移）→ 落在哪个窗口
    let offset = mid
    let win = pool[pool.length - 1]
    for (const w of pool) {
      const len = w.endMin - w.startMin
      if (offset < len) { win = w; break }
      offset -= len
    }
    const len = Math.max(40, win.endMin - win.startMin)
    // 抖动：±(len/5)，由日期+序号决定，同一天重算稳定
    const jitterRange = Math.max(6, Math.floor(len / 5))
    const j = ((hash32(seed + '|' + i) % (jitterRange * 2 + 1)) - jitterRange)
    let at = Math.round(win.startMin + Math.min(len - 1, Math.max(0, offset)) + j)
    // 夹回窗口内侧，别贴边：起床后至少 25 分钟才开始刷（她刚醒还在迷糊），
    // 离窗口结束也留 15 分钟（免得正好卡在她要去干下一件事的时候）
    at = Math.max(win.startMin + 25, Math.min(win.endMin - 15, at))
    at = ((at % 1440) + 1440) % 1440
    slots.push(at)
  }
  // 去重 + 排序；太近（<25 分钟）的合并掉
  const uniq = []
  for (const s of slots.slice().sort((a, b) => a - b)) {
    if (uniq.length && s - uniq[uniq.length - 1] < 25) continue
    uniq.push(s)
  }
  const times = uniq.slice(0, MAX_SLOTS).map(hm)
  return { times, windows: pool, source: pool[0] ? pool[0].source : 'none' }
}

/** 当天该排几个点：4 个为主，按日期在 3~5 之间轻轻浮动 */
function randomCount(day) {
  const n = 3 + (hash32('cnt|' + day) % 3)
  return Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, n))
}

function dayplanPath(home, date) {
  // biliDir 的上一级就是状态目录本身，复用同一套 home 口径
  const stateDir = path.dirname(biliDir(home))
  return path.join(stateDir, 'dayplan', date + '.json')
}

/**
 * 确保今天的时间表存在（跨天自动重生成）。
 * @returns {{ok:boolean, regenerated:boolean, state:object, windows?:object[]}}
 */
export function ensureBiliSchedule({ now = Date.now(), home = null, schedule = null, dayplan = null, count = 0 } = {}) {
  const day = dateKey(now)
  const cur = loadBiliSchedule(home)
  if (cur.date === day && cur.times.length >= MIN_SLOTS) {
    return { ok: true, regenerated: false, state: cur }
  }
  const sch = schedule || (() => { try { return loadSchedule() } catch { return null } })()
  const dp = dayplan !== null ? dayplan : readJson(dayplanPath(home, day), null)
  const gen = generateTimes({ now, date: day, schedule: sch, dayplan: dp, count })
  const st = {
    date: day,
    times: gen.times,
    triggered: [],
    generatedAt: now,
    wakeHour: Number((sch && sch.wakeHour) ?? 9),
    sleepHour: Number((sch && sch.sleepHour) ?? 2),
    source: gen.source,
  }
  saveBiliSchedule(home, st)
  return { ok: true, regenerated: true, state: st, windows: gen.windows }
}

/** 这个时间点是不是「刚到点」（GRACE 之内），且今天还没触发过 */
export function slotDue({ now = Date.now(), time = '', triggered = [], graceMinutes = TRIGGER_GRACE_MINUTES } = {}) {
  const target = parseHM(time)
  if (target == null) return { due: false, reason: 'bad-time' }
  if ((triggered || []).includes(String(time))) return { due: false, reason: 'already' }
  const d = new Date(now)
  const minutes = d.getHours() * 60 + d.getMinutes()
  let elapsed = minutes - target
  // 跨午夜：目标在昨天最后几分钟
  if (elapsed < -720) elapsed += 1440
  if (elapsed < 0) return { due: false, reason: 'not-yet', waitMs: -elapsed * 60000 }
  if (elapsed >= graceMinutes) return { due: false, reason: 'missed' }
  return { due: true, reason: 'due' }
}

/** 挑出现在该触发的那一个时间点（没有就 null） */
export function dueSlot({ now = Date.now(), state = null } = {}) {
  const st = state || { date: dateKey(now), times: [], triggered: [] }
  if (st.date !== dateKey(now)) return null
  for (const t of st.times || []) {
    const r = slotDue({ now, time: t, triggered: st.triggered || [] })
    if (r.due) return { time: t, reason: r.reason }
  }
  return null
}

/** 标记某个时间点已触发（当天不再重复） */
export function markSlotTriggered({ now = Date.now(), home = null, time = '' } = {}) {
  const st = loadBiliSchedule(home)
  if (st.date !== dateKey(now)) return st
  const key = String(time || '')
  if (!key) return st
  if (!st.triggered.includes(key)) st.triggered = [...st.triggered, key].slice(-MAX_SLOTS * 2)
  saveBiliSchedule(home, st)
  return st
}

/** 面板/日志：今天的时间表长什么样 */
export function scheduleSnapshot({ now = Date.now(), home = null, schedule = null } = {}) {
  const st = loadBiliSchedule(home)
  const today = dateKey(now)
  // 表里没存作息时（老文件 / 别的模块写的）现读一次，别让面板显示 NaN
  const win = sleepWindowOf(schedule || null)
  const wakeHour = Number.isFinite(st.wakeHour) ? st.wakeHour : win.wakeHour
  const sleepHour = Number.isFinite(st.sleepHour) ? st.sleepHour : win.sleepHour
  return {
    date: st.date,
    today,
    fresh: st.date === today,
    times: st.times,
    triggered: st.triggered,
    pending: (st.times || []).filter((t) => !(st.triggered || []).includes(t)),
    generatedAt: st.generatedAt,
    wakeHour,
    sleepHour,
    source: st.source || 'unknown',
  }
}
