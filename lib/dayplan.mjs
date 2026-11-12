/**
 * lib/dayplan.mjs — 每日日程（抄 dsh-daily-schedule 的核心思路，去掉生图/穿搭）
 * ============================================================================
 * 她有自己的日子：每晚排第二天 —— 几点在哪、做什么、和谁。
 * 聊天时按「此刻」知道自己正在干嘛，说话像回忆而不是念时间表。
 *
 * 数据：qq-fish/dayplan/YYYY-MM-DD.json
 *   { date, dayType, title, mood, items: [{start, end, activity, location, detail, with}] }
 *
 * 和现有 life.mjs / schedule.mjs 的分工：
 *   schedule.mjs  作息（几点睡、几点醒）
 *   life.mjs      当前状态（在做啥、心情）
 *   dayplan.mjs   一整天的细日程（新增，和上面互补）
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadSchedule } from './schedule.mjs'
import { loadBody, cycleDay, phaseOf } from './body.mjs'

const pad = (n) => String(n).padStart(2, '0')
const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

export function dayplanDir(home) {
  const d = join(home, 'dayplan')
  try { mkdirSync(d, { recursive: true }) } catch {}
  return d
}
function dayPath(home, date) { return join(dayplanDir(home), date + '.json') }

export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function loadDay(home, date) {
  try { return JSON.parse(readFileSync(dayPath(home, date), 'utf8')) } catch { return null }
}

export function saveDay(home, day) {
  try {
    writeFileSync(dayPath(home, day.date + '.json'.replace('.json', '')), '', 'utf8')
  } catch {}
  try {
    writeFileSync(dayPath(home, day.date), JSON.stringify(day, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 最近的日程摘要（避免每天一样） */
export function recentSummary(home, beforeDate, n = 3) {
  const lines = []
  const base = new Date(beforeDate + 'T00:00:00')
  for (let i = n; i >= 1; i--) {
    const d = new Date(base.getTime() - i * 86400000)
    const day = loadDay(home, dateStr(d))
    if (!day) continue
    const main = (day.items || []).filter((it) => !/睡/.test(it.activity)).map((it) => it.activity).slice(0, 6).join('、')
    lines.push(`- ${day.date}（${day.dayType || ''}）：${day.title || ''}${main ? '。做了：' + main : ''}`)
  }
  return lines.join('\n')
}

/** 默认日程类型：她不上班，日子就是吃喝玩乐睡（可被 config.dayTypes 覆盖） */
const DEFAULT_TYPES = [
  { id: 'lazy', name: '赖床日', guide: '睡到自然醒，一整天都懒懒的，能躺着绝不坐着。' },
  { id: 'home', name: '宅家日', guide: '不出门，在家刷手机、看剧、煮点吃的，偶尔发呆。' },
  { id: 'wander', name: '逛街日', guide: '出门走走：老街、小店、江边、咖啡馆，看到什么有意思就停下来。' },
  { id: 'food', name: '觅食日', guide: '这一天围着吃的转：想吃的东西排在前面，边走边吃。' },
  { id: 'lazy2', name: '晒太阳日', guide: '找个有太阳的地方待着，什么都不想干。' },
]

export function pickDayType(config, date) {
  const types = Array.isArray(config.dayTypes) && config.dayTypes.length ? config.dayTypes : DEFAULT_TYPES
  return types[Math.floor(Math.random() * types.length)]
}

/** 拼生成提示词 */
export function buildPrompt({ config = {}, date, type, hint = '', home, bodyInfo = '', weather = '' }) {
  const name = String(config.personaName || config.botName || '她')
  const partner = String(config.ownerName || '主人')
  const personal = String(config.persona || '').slice(0, 1500)
  const recent = recentSummary(home, date)
  const example = { start: '00:00', end: '07:30', activity: '睡觉', location: '主卧', detail: '', with: '', indoor: true }
  const lines = [
    `你在为「${name}」安排 ${date} 这一整天的生活。这份日程会作为她当天的背景，聊天时她按它知道自己此刻在做什么。`,
    personal ? `【她是谁】\n${personal}` : '',
    `【用户】她称呼用户为「${partner}」。`,
    `【这一天】${type.name}：${type.guide || ''}`,
    recent ? `【最近几天】\n${recent}\n这一天不要和最近几天重复。` : '',
    hint ? `【特别要求】${hint}` : '',
    '【作息】' + (() => {
      try {
        const sch = loadSchedule()
        const wake = Number(sch.wakeHour)
        const sleep = Number(sch.sleepHour)
        if (Number.isFinite(wake) && Number.isFinite(sleep) && wake !== sleep) {
          const z = (n) => String(n).padStart(2, '0') + ':00'
          return '她每天 ' + z(sleep) + ' 睡、' + z(wake) + ' 醒。睡眠段必须和这个一致：从 00:00 到 ' + z(wake) + ' 都是睡觉（' + z(sleep) + ' 左右入睡），' + z(wake) + ' 之后才安排白天活动，不要提前起床，也不要拖到更晚。'
        }
      } catch {}
      return ''
    })(),
    bodyInfo,
    weather ? `【今天天气】${String(weather).replace(/^【[^】]*】\s*/, '').slice(0, 240)}\n排的时候必须贴合天气：下雨/下雪/打雷/大风就别安排出门，也别写「在露台晒太阳」「去阳台吹风」这种跟天气打架的安排；天气好可以多安排户外。每条 item 额外带 "indoor": true/false（true=在屋里）。` : '',
    '【她的家】四房两卫一厨一厅一阳台一露台：客厅（沙发/落地窗）、厨房（灶台/碗柜）、主卧（床/台灯/小鲸鱼玩偶）、次卧（小床）、书房（书桌）、主人房（主人的床，留给主人——她平时不睡那里，最多进去打扫/放东西）、主卫（淋浴）、客卫（浴缸）、阳台（绿萝）、露台（躺椅）。在家时 location 必须写这些房间名之一（如「客厅」「厨房」「露台」）；只有出门才写外面的地点（公园/街/店）。出门和回家要有过渡（如「出门去超市」「回家了，瘫在客厅」）。',
    '【要求】',
    '- 从 00:00 排到 24:00，时间连续不重叠，24 小时制 HH:MM，最后一段 end 写 24:00，一般 12–18 段。',
    '- activity 写在做什么（具体，10 字以内，比如「挤地铁去公司」「在茶水间偷吃饼干」）',
    '- location 写在哪；detail 写一两句当时的状态或小插曲（心情、吃了什么、碰到什么事）',
    '- 她不上班、没有工作要干。日子就是吃喝玩乐睡：逛街、找吃的、赖床、刷手机、看剧、出门晃。',
    '- 符合她的性格和习惯，但别夸张成闹剧；起床睡觉时间可以晚一点。',
    '- 每条必须带 indoor 字段：在屋里 true，出门 false。',
    '- location 字段：在家必须写具体房间（客厅/厨房/主卧/次卧/书房/主人房/主卫/客卫/阳台/露台），不要写「家」；出门才写外部地点。',
    '只输出一个 JSON 对象，不要任何其他文字：',
    JSON.stringify({ title: '一句话概括这一天', mood: '这一天整体的心情', items: [example] }),
  ]
  return lines.filter(Boolean).join('\n')
}

/** 解析模型输出 */
export function parseSchedule(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('模型没返回 JSON')
  const j = JSON.parse(s.slice(a, b + 1))
  const items = normalizeItems(j.items)
  if (items.length < 4) throw new Error('日程太短')
  return {
    title: String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    mood: String(j.mood || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    items,
  }
}

const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 规范化：排序、去重叠、补空档、保证 00:00-24:00 */
export function normalizeItems(raw) {
  const list = []
  for (const it of Array.isArray(raw) ? raw : []) {
    const a = toMin(it && it.start)
    let b = toMin(it && it.end)
    if (a === null) continue
    if (b === null || b <= a) b = Math.min(1440, a + 60)
    list.push({
      start: a, end: Math.min(1440, b),
      activity: String(it.activity || '').slice(0, 40) || '发呆',
      location: String(it.location || '').slice(0, 40),
      detail: String(it.detail || '').slice(0, 160),
      with: String(it.with || '').slice(0, 40),
    })
  }
  list.sort((x, y) => x.start - y.start)
  const out = []
  let cursor = 0
  for (const it of list) {
    if (it.start < cursor) it.start = cursor
    if (it.end <= it.start) continue
    if (it.start > cursor) {
      out.push({ start: cursor, end: it.start, activity: cursor === 0 ? '还在睡' : '空档', location: '家', detail: '', with: '' })
    }
    out.push(it)
    cursor = it.end
  }
  if (cursor < 1440) out.push({ start: cursor, end: 1440, activity: cursor === 0 ? '还在睡' : '睡前发呆', location: '家', detail: '', with: '' })
  return out.map((x) => ({ ...x, start: clock(x.start), end: clock(x.end) }))
}

/** 找此刻在哪个时段 */
export function findItem(day, minute) {
  if (!day || !Array.isArray(day.items)) return -1
  for (let i = 0; i < day.items.length; i++) {
    const a = toMin(day.items[i].start)
    const b = toMin(day.items[i].end)
    if (a !== null && b !== null && minute >= a && minute < b) return i
  }
  return day.items.length - 1
}

/** 生成某一天的日程（调 LLM） */
export async function generateDay({ generateText, ctx, config, home, date, hint = '', fallback = true, weather = '' }) {
  const type = pickDayType(config, date)
  const base = { date, dayType: type.name, hint, generatedAt: new Date().toISOString(), changes: [] }
  try {
    let bodyInfo = ''
    try {
      const b = await loadBody()
      const cd = cycleDay(b)
      const ph = cd ? phaseOf(cd, b) : ''
      const names = { period: '经期', follicular: '卵泡期', ovulation: '排卵期', luteal: '黄体期', pms: '经前期' }
      const feel = { period: '身上没力气、容易累', follicular: '精神不错', ovulation: '状态最好', luteal: '有点闷、容易累', pms: '情绪容易起伏' }
      bodyInfo = '【她今天的身体】' + (names[ph] || '普通') + (cd ? '（第 ' + cd + ' 天）' : '') + (feel[ph] ? '：' + feel[ph] : '') + '；疲惫 ' + Math.round(Number(b.fatigue || 0) * 100) + '/100。安排时避开她扛不住的强度：经期或疲惫高就多安排宅家/躺着，精神好再出门。'
    } catch {}
    const prompt = buildPrompt({ config, date, type, hint, home, bodyInfo, weather })
    const r = await generateText(ctx, {
      system: '你是一个日程规划器。只输出 JSON，不要别的。',
      messages: [{ role: 'user', text: prompt }],
      config,
      temperature: 1.0,
      maxTokens: 4000,
      timeoutMs: 90_000,
    })
    const text = typeof r === 'string' ? r : (r && (r.text || r.content)) || ''
    const parsed = parseSchedule(text)
    const day = { ...base, ...parsed, source: 'llm' }
    saveDay(home, day)
    return { ok: true, day }
  } catch (e) {
    if (!fallback) return { ok: false, error: String((e && e.message) || e) }
    const day = { ...base, title: type.name, mood: '', items: normalizeItems(templateItems(type)), source: 'template', error: String((e && e.message) || e) }
    saveDay(home, day)
    return { ok: true, day, template: true }
  }
}

/** 模板兜底（模型失败时保证有日程） */
export function templateItems(type) {
  return normalizeItems([
    { start: '00:00', end: '09:30', activity: '睡觉', location: '家' },
    { start: '09:30', end: '10:10', activity: '赖床不肯起', location: '家' },
    { start: '10:10', end: '11:00', activity: '煮点吃的', location: '家' },
    { start: '11:00', end: '13:00', activity: '窝着刷手机', location: '家' },
    { start: '13:00', end: '14:30', activity: '吃午饭', location: '家' },
    { start: '14:30', end: '16:30', activity: '出门走走', location: '附近' },
    { start: '16:30', end: '17:30', activity: '买杯喝的', location: '街角' },
    { start: '17:30', end: '19:30', activity: '回家瘫着', location: '家' },
    { start: '19:30', end: '21:00', activity: '弄点好吃的', location: '家' },
    { start: '21:00', end: '24:00', activity: '看剧聊天', location: '家' },
  ])
}

/** 注入给模型的文本（"此刻"） */
export function injectionText(home, config = {}, now = new Date(), weather = "") {
  const date = dateStr(now)
  const minute = now.getHours() * 60 + now.getMinutes()
  const day = loadDay(home, date)
  const name = String(config.personaName || config.botName || '她')

  const out = ['【她此刻的生活（这是背景，别在回复里提到这段说明本身）】']
  out.push(`现在：${date} ${clock(minute)}`)
  if (weather) out.push('【外面天气】' + String(weather).replace(/^【[^】]*】\s*/, '').slice(0, 240))

  if (!day || !Array.isArray(day.items) || !day.items.length) {
    out.push('她今天过得怎样还没想好，按常理推断她此刻在做什么。')
    return out.join('\n')
  }

  out.push(`今天：${day.dayType || '普通的一天'}${day.title ? '——' + day.title : ''}${day.mood ? '（心情：' + day.mood + '）' : ''}`)
  const i = findItem(day, minute)
  const cur = day.items[i]
  if (cur) {
    out.push(`她正在：${cur.activity}${cur.location ? '（' + cur.location + '）' : ''}，从 ${cur.start} 到 ${cur.end} 左右${cur.detail ? '——' + cur.detail : ''}`)
    if (/睡/.test(cur.activity)) {
      out.push(`${name}这会儿睡着了，被叫醒会迷迷糊糊、想接着睡，回复短、带困意。`)
    }
  }
  const next = day.items.slice(i + 1, i + 4)
  if (next.length) out.push(`她待会儿想做：${next.map((it) => `${it.start} ${it.activity}`).join('；')}`)
  const past = day.items.slice(0, Math.max(0, i)).filter((it) => !/睡/.test(it.activity)).slice(-4)
  if (past.length) out.push(`她今天早些时候：${past.map((it) => it.activity).join(' → ')}`)

  out.push('【身体优先】如果她今天身体不舒服、很累或经期，可以临时改主意、不出门，不用硬撑着按日程来；改主意就直接说。')
  out.push('【天气别穿帮】外面在下雨/打雷/下雪时，别说「太阳挺好」「出去晒晒」这种跟天气打架的话；日程里要出门的安排碰上坏天气，就直接改成待在屋里，可以抱怨一句「雨这么大，不去了」。')
  out.push('【说话方式】这些是她自己的打算，不是时间表。用「刚煮完泡面，烫死我了」「等会儿想去便利店」这种口吻说；不要说「按照日程」「按计划」「日程上写着」，不报时间段、不列清单。她可以临时改主意，直接说决定就行。')
  return out.join('\n')
}

/** 她临时改主意 */
export function adjustDay(home, date, { activity, detail } = {}) {
  const day = loadDay(home, date)
  if (!day) return { ok: false, error: '今天还没有日程' }
  const now = new Date()
  const minute = now.getHours() * 60 + now.getMinutes()
  const i = findItem(day, minute)
  if (i < 0) return { ok: false, error: '找不到当前时段' }
  if (activity) day.items[i].activity = String(activity).slice(0, 40)
  if (detail) day.items[i].detail = String(detail).slice(0, 160)
  day.changes = [...(day.changes || []), { at: now.toISOString(), note: (activity || '') + (detail ? '：' + detail : '') }].slice(-20)
  saveDay(home, day)
  return { ok: true, item: day.items[i] }
}

/** 面板快照 */
export function dayplanSnapshot(home, date) {
  const today = loadDay(home, date || dateStr())
  const tomorrow = loadDay(home, dateStr(new Date(Date.now() + 86400000)))
  let files = []
  try { files = readdirSync(dayplanDir(home)).filter((f) => f.endsWith('.json')).sort().slice(-7) } catch {}
  const days = files.map((f) => {
    const d = f.replace('.json', '')
    const day = loadDay(home, d)
    return {
      date: d,
      dayType: (day && day.dayType) || '',
      title: (day && day.title) || '',
      mood: (day && day.mood) || '',
      items: day && Array.isArray(day.items) ? day.items.length : 0,
    }
  })
  return {
    today,
    tomorrow,
    recent: files.map((f) => f.replace('.json', '')),
    days,
  }
}

// __wx1
