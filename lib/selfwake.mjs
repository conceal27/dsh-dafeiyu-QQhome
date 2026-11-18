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


/**
 * 直接按绝对时间点登记一条（不经过 [wake:] 文本解析）。
 * 供 engine 的「主人说到点提醒我」兜底、以及 lib/memo.mjs 的定时任务使用。
 * 返回登记进去的那条（含 hhmm），失败返回 null。
 */
export function addWakeAt(home, at, note, now = Date.now()) {
  const atMs = Number(at)
  if (!Number.isFinite(atMs) || atMs <= 0) return null
  const d = new Date(atMs)
  const st = loadWakes(home)
  const item = {
    id: String(now) + '-' + Math.random().toString(36).slice(2, 6),
    at: atMs,
    hhmm: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
    note: String(note || '').slice(0, 200),
    createdAt: now,
  }
  st.items.push(item)
  saveWakes(home, st)
  return item
}

/**
 * 从主人的原话里解析「几点提醒我」（中文口语）。
 * 只负责时间，不负责登记——登记走 addWakeAt。
 * 返回 { hh, mm, dayOffset } 或 null；dayOffset 0=今天 1=明天 2=后天。
 * 解析不出来就返回 null，让调用方当作「没有可登记的时间」。
 */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function cnNumber(raw) {
  const s = String(raw || '').trim()
  if (!s) return NaN
  if (/^\d+$/.test(s)) return Number(s)
  // 十 / 十一 / 二十 / 二十三 / 三
  if (s === '十') return 10
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGIT[s[1]]
  if (/^[一二两三四五六七八九]十$/.test(s)) return CN_DIGIT[s[0]] * 10
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]]
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s]
  return NaN
}

export function parseChineseWhen(text, now = Date.now()) {
  const raw = String(text || '').replace(/\s+/g, '')
  if (!raw) return null

  // 日期偏移：后天 2 / 明天 明日 明早 明晚 1 / 今天 今日 今早 今晚 0
  let dayOffset = 0
  if (/后天/.test(raw)) dayOffset = 2
  else if (/明天|明日|明早|明晚|明儿/.test(raw)) dayOffset = 1

  // 时段词 → 是否给 12 小时制加 12
  const afternoon = /下午|傍晚|晚上|今晚|明晚|夜里|夜间|晚点|晚间/.test(raw)
  const noon = /中午|正午/.test(raw)
  const earlyMorning = /凌晨|半夜/.test(raw)
  const morning = /早上|早晨|上午|清晨|一早|明早|今早/.test(raw)

  let hh = NaN
  let mm = 0

  // 形状一：HH:MM 或 HH：MM
  let m = raw.match(/(\d{1,2})[:：](\d{2})/)
  if (m) {
    hh = Number(m[1])
    mm = Number(m[2])
  }

  // 形状二：N点半 / N点 / N点M分
  if (!Number.isFinite(hh)) {
    m = raw.match(/([0-9]{1,2}|[一二两三四五六七八九十]{1,3})点(半|[0-9]{1,2}分|[一二三四五六七八九十]{1,2}分)?/)
    if (m) {
      hh = cnNumber(m[1])
      if (m[2] === '半') mm = 30
      else if (m[2]) mm = cnNumber(String(m[2]).replace('分', '')) || 0
    }
  }

  // 形状三：只有「7:30」没有点字，上面形状一已覆盖；还有「23点45」
  if (!Number.isFinite(hh)) {
    // 兜底：单独的 1-2 位数字 + 时段词（「下午3」这种口语）
    m = raw.match(/(?:下午|晚上|早上|上午|中午|凌晨|半夜)([0-9]{1,2})(?![点:：])/)
    if (m) hh = Number(m[1])
  }

  if (!Number.isFinite(hh) || hh < 0 || hh > 24 || mm < 0 || mm > 59) return null

  // 12 小时制换算
  if (hh <= 12) {
    if (afternoon && hh < 12) hh += 12
    else if (noon && hh < 11) hh += 12
    else if (earlyMorning && hh === 12) hh = 0
    else if (morning && hh === 12) hh = 0
  } else if (hh === 24) {
    hh = 0
  }

  // 「凌晨」说的 12 点其实是 0 点之外的 12 点？不折腾，保持 12:00。
  if (hh === 24) hh = 0
  if (hh < 0 || hh > 23) return null
  return { hh, mm, dayOffset }
}
