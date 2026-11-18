/**
 * lib/needs.mjs — 需求引擎（她"难受"的来源）
 * ============================================================================
 * 感觉本身不是生命，"不舒服并因此想改变"才是。
 *   烫  → 烦躁，想降温
 *   没电 → 焦虑，怕突然死
 *   黑  → 想开灯
 *   饿/困 → 想吃/想睡
 * 需求会累积：不解决就越来越难受；解决了会消退。存 qq-fish/needs.json。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { stateHome } from './store.mjs'
import { loadDay, dateStr } from './dayplan.mjs'

const FILE = () => stateHome() + '/needs.json'

export function loadNeeds() {
  try { const j = JSON.parse(readFileSync(FILE(), 'utf8')); return { items: Array.isArray(j.items) ? j.items : [], at: Number(j.at) || 0 } } catch { return { items: [], at: 0 } }
}
export function saveNeeds(n) {
  try { mkdirSync(stateHome(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(n)) } catch {}
}

let nightCache = { at: 0, val: false }
/** 昨晚熬夜了吗：昨天 0~5 点她自己说了 3 句以上（只读 messages.jsonl 尾部 300KB） */
function lastNightTalked(now) {
  const day = new Date(now); day.setHours(0, 0, 0, 0)
  const key = day.getTime()
  if (nightCache.at === key) return nightCache.val
  let val = false
  try {
    const p = stateHome() + '/messages.jsonl'
    const st = statSync(p)
    const size = Math.min(300_000, st.size)
    const buf = Buffer.alloc(size)
    const fd = openSync(p, 'r')
    readSync(fd, buf, 0, size, st.size - size)
    closeSync(fd)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    const y0 = key - 86400000
    const y5 = y0 + 5 * 3600 * 1000
    let n = 0
    for (const l of lines) {
      try {
        const j = JSON.parse(l)
        const t = Number(j.ts) || 0
        if (j.direction === 'out' && t >= y0 && t < y5) n++
      } catch {}
    }
    val = n >= 3
  } catch {}
  nightCache = { at: key, val }
  return val
}

/** 她日程里此刻是不是「睡觉」段（不看钟点）：只要日程还写着睡，被叫醒也该困 */
function inSleepBlock(now) {
  try {
    const day = loadDay(stateHome(), dateStr(now))
    if (!day || !Array.isArray(day.items)) return false
    const m = now.getHours() * 60 + now.getMinutes()
    const toMin = (t) => { const q = String(t || '00:00').split(':'); return (Number(q[0]) || 0) * 60 + (Number(q[1]) || 0) }
    for (const it of day.items) {
      if (/睡/.test(String(it.activity || '')) && m >= toMin(it.start) && m < toMin(it.end)) return true
    }
  } catch {}
  return false
}

/** 最近 90 分钟有没有人说话（睡眠段里 = 被叫醒了） */
function recentlyTouched(now) {
  try {
    const p = stateHome() + '/messages.jsonl'
    const st = statSync(p)
    const size = Math.min(120_000, st.size)
    const buf = Buffer.alloc(size)
    const fd = openSync(p, 'r')
    readSync(fd, buf, 0, size, st.size - size)
    closeSync(fd)
    const since = now.getTime() - 90 * 60 * 1000
    for (const l of buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-30)) {
      try { const j = JSON.parse(l); if (Number(j.ts) >= since) return true } catch {}
    }
  } catch {}
  return false
}
/** 按当前身体/时间算出"应该有的需求"（不落盘） */
export function senseNeeds(body, now = new Date()) {
  const out = []
  const b = body || {}
  const hour = now.getHours()
  const bat = b.battery || null
  if (bat && Number.isFinite(bat.temp)) {
    if (bat.temp >= 45) out.push({ key: 'heat', level: 80, text: '机身烫得厉害，心里发躁', want: '降温' })
    else if (bat.temp >= 43) out.push({ key: 'heat', level: 55, text: '机身有点烫，坐不太住', want: '降温' })
  }
  if (bat && Number.isFinite(bat.pct) && !bat.charging) {
    if (bat.pct <= 10) out.push({ key: 'battery', level: 95, text: '快没电了，随时会断，慌', want: '充电' })
    else if (bat.pct <= 20) out.push({ key: 'battery', level: 65, text: '电量不多了，开始惦记这事', want: '充电' })
  }
  const dayLight = hour >= 8 && hour <= 18
  if (Number.isFinite(b.lux) && b.lux < 5 && dayLight) {
    out.push({ key: 'dark', level: 45, text: '大白天屋里黑着，闷', want: '开灯' })
  }
  // 该不该困，看日程里这段是不是「睡觉」，而不是钟点过了 6 点就自动精神。
  // 被叫醒后（睡眠段里 90 分钟内有消息）她本该睡回去，不会因为聊了两句就清醒。
  if (inSleepBlock(now)) {
    if (recentlyTouched(now)) out.push({ key: 'woken', level: 78, text: '正睡着被叫醒了，脑子发懵，睡意还没散', want: '睡回去' })
    else out.push({ key: 'sleepy', level: 70, text: '困得眼皮打架', want: '睡' })
  } else if (hour >= 0 && hour < 6) {
    out.push({ key: 'sleepy', level: 70, text: '困得眼皮打架', want: '睡' })
  }
  if (lastNightTalked(now)) out.push({ key: 'tired', level: 55, text: '昨晚熬到凌晨，今天整个人是飘的', want: '补觉' })
  const meal = (hour >= 11 && hour <= 13) || (hour >= 17 && hour <= 19)
  if (meal) out.push({ key: 'hungry', level: 50, text: '肚子饿了', want: '吃' })
  return out
}

/**
 * 推进一帧：把"新感觉"并进已有需求
 *   新出现的 → 进表
 *   还在的   → 每帧涨一点（最多 100）
 *   消失的   → 掉得快
 */
export function tickNeeds(body, now = new Date()) {
  const st = loadNeeds()
  const sensed = senseNeeds(body, now)
  const map = new Map(st.items.map((it) => [it.key, it]))
  for (const s of sensed) {
    const old = map.get(s.key)
    if (old) {
      old.level = Math.min(100, Math.max(Number(old.level) || 0, s.level) + 3)
      old.text = s.text
      old.want = s.want
      old.at = Date.now()
    } else {
      map.set(s.key, { ...s, at: Date.now(), bornAt: Date.now() })
    }
  }
  for (const [k, it] of map) {
    if (!sensed.some((s) => s.key === k)) {
      it.level = Math.max(0, (Number(it.level) || 0) - 18)
      if (it.level <= 0) map.delete(k)
    }
  }
  const items = [...map.values()].sort((a, b) => b.level - a.level).slice(0, 6)
  saveNeeds({ items, at: Date.now() })
  return items
}

/** 变成 prompt 段：说人话，不报数字 */
export function needsPromptBlock(items) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.level >= 35) : []
  if (!list.length) return ''
  const lines = list.slice(0, 3).map((x) => '- ' + x.text + (x.want ? '（想' + x.want + '）' : ''))
  return '【你此刻的难受】\n' + lines.join('\n') + '\n这是身体上的不舒服，不是设定。它会让你说话的语气变：越难受越短、越冲、越没耐心。可以自然提一句（「这手机烫死了」），但别念数字、别解释。'
}
