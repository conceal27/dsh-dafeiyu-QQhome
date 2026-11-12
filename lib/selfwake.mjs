/**
 * lib/selfwake.mjs — 她自己给未来的自己留一句话
 * ============================================================================
 * 借 not-zai/self-nudge 的思路：agent 不能凭空醒来，那就让它在还有意识的时候，
 * 给未来的自己留一句话和一个时间。到点把它当成"她自己想起来了"，不是"闹钟响了"。
 *
 * 她说的话里写 [wake:23:40:想问问他今天面试怎么样]，这里负责落盘；
 * push 的 tick 到点取出来，用「这会儿 23:40，你之前想过：… 说与不说你自己定」唤醒。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'selfwake.json'
const MAX = 40

const pathOf = (home) => join(home, FILE)

export function loadWakes(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { items: [] }
  }
}

function saveWakes(home, st) {
  try {
    mkdirSync(home, { recursive: true })
    const tmp = pathOf(home) + '.tmp'
    // 写 .tmp 再 rename：别让隔壁心跳读到半个文件
    writeFileSync(tmp, JSON.stringify({ items: st.items.slice(-MAX) }, null, 1), 'utf8')
    renameSync(tmp, pathOf(home))
  } catch {}
}

/** 从她的话里解析 [wake:HH:MM:理由] */
export function parseWakeMarkers(text) {
  const out = []
  const re = /\[wake:(\d{1,2}):(\d{2}):([^\]]{1,200})\]/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const hh = Number(m[1])
    const mm = Number(m[2])
    if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) continue
    const note = m[3].trim()
    if (!note) continue
    out.push({ hh, mm, note })
  }
  return out
}

/** 下一次这个钟点；已经开始的那一分钟算今天，过了就明天 */
export function nextOccurrence(hh, mm, now = Date.now()) {
  const d = new Date(now)
  d.setHours(hh, mm, 0, 0)
  if (d.getTime() <= now + 30_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 直接按绝对时间登记一条（主人原话兜底解析时用；at = 毫秒时间戳） */
export function addWakeAt(home, at, note = '') {
  const st = loadWakes(home)
  const d = new Date(at)
  const now = Date.now()
  const item = {
    id: String(now) + '-' + Math.random().toString(36).slice(2, 6),
    at,
    hhmm: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
    note: String(note || '').slice(0, 200),
    createdAt: now,
  }
  st.items.push(item)
  saveWakes(home, st)
  return item
}

/** 从中文原话里解析“几点提醒”（兜底用）：返回 { hh, mm, dayOffset } 或 null */
export function parseChineseWhen(text) {
  const s = String(text || '')
  const dayOffset = /明天|明早|明晚|次日/.test(s) ? 1 : 0
  const cn = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
  const num = (t) => {
    const x = String(t)
    if (/^\d+$/.test(x)) return Number(x)
    if (x === '十一') return 11
    if (x === '十二') return 12
    if (x.length === 1) return cn[x] === undefined ? NaN : cn[x]
    return NaN
  }
  let m = s.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  if (m) {
    let hh = Number(m[1])
    const mm = Number(m[2])
    if (/下午|晚上|傍晚|夜里|今晚|晚/.test(s) && hh < 12) hh += 12
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return { hh, mm, dayOffset }
  }
  m = s.match(/((?:[零一二三四五六七八九十]|\d){1,3})\s*点\s*(半|(\d{1,2})\s*分?)?/)
  if (m) {
    let hh = num(m[1])
    if (!Number.isFinite(hh)) return null
    let mm = 0
    if (m[2] === '半') mm = 30
    else if (m[3]) mm = Number(m[3])
    if (/下午|晚上|傍晚|夜里|今晚|晚/.test(s) && hh < 12) hh += 12
    if (/凌晨|早上|早晨|上午/.test(s) && hh === 12) hh = 0
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return { hh, mm, dayOffset }
  }
  return null
}

/** 登记一条（她刚说完） */
export function addWakes(home, rawText, now = Date.now()) {
  const found = parseWakeMarkers(rawText)
  if (!found.length) return []
  const st = loadWakes(home)
  const created = []
  for (const f of found) {
    const at = nextOccurrence(f.hh, f.mm, now)
    const item = {
      id: String(now) + '-' + Math.random().toString(36).slice(2, 6),
      at,
      hhmm: String(f.hh).padStart(2, '0') + ':' + String(f.mm).padStart(2, '0'),
      note: f.note,
      createdAt: now,
    }
    st.items.push(item)
    created.push(item)
  }
  saveWakes(home, st)
  return created
}

/** 到点的（不改动） */
export function dueWakes(home, now = Date.now()) {
  return loadWakes(home).items.filter((x) => Number(x.at) <= now)
}

/** 取走一条到点的（取完删掉，跟 self-nudge 一样：先写回、再投递） */
export function takeOneDue(home, now = Date.now()) {
  const st = loadWakes(home)
  const idx = st.items.findIndex((x) => Number(x.at) <= now)
  if (idx < 0) return null
  const [item] = st.items.splice(idx, 1)
  saveWakes(home, st)
  return item
}

/**
 * 唤醒用语。这条比代码重要：
 * 不能写成「闹钟响了」或「你挂的钟到点了」——那样她第一句往往是"闹钟响了"。
 * 要给"处境"，不给"台词"，更不要给"这是一次定时任务"这个事实。
 */
export function wakePrompt(item) {
  const hhmm = String(item.hhmm || '').trim()
  return (
    '这会儿' + (hhmm || '到点了') + '，你之前想着：「' + String(item.note || '').slice(0, 120) + '」正合适。\n' +
    '说与不说你自己定；真不想说就别开口，没什么必须完成的。'
  )
}

export function status(home) {
  const items = loadWakes(home).items
  const now = Date.now()
  return {
    total: items.length,
    pending: items.filter((x) => Number(x.at) > now).length,
    items: items.slice().sort((a, b) => a.at - b.at).slice(0, 10),
  }
}
