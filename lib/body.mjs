/**
 * lib/body.mjs — 她的「身体」：生理周期、精力、情绪、亲密度
 * ============================================================================
 * 不是数值面板，是给模型的「今天你什么状态」提示：让她自己把状态演出来。
 * 数据存在 qq-fish/body.json（插件不会重写这个文件）。
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const FILE = join(stateHome(), 'body.json')

const DEFAULTS = {
  enabled: true,
  // 上次经期第一天（YYYY-MM-DD，本地时区）
  cycleStart: '',
  cycleDays: 28,
  periodDays: 5,
  // 本次周期比基准早/晚几天（-2..2）。真实经期不是固定的，每次开新周期会重新掷。
  jitter: 0,
  // 好感度：跟主人互动越多越高
  intimacy: 0,
  // 今天的额外状态（模型/主人可以手动改，例如生病、熬夜）
  note: '',
  // 经期感受：流量 0-3、痛经 0-3（对应手表 App 那套记录）
  flow: 0,
  pain: 0,
  // 今天的身体/心情/皮肤感受（多选标签，对应手表 App 的「记录状态感受」）
  symptoms: [],
  // 上一次掷感受的日期（每天她自己长一次，主人不参与）
  symptomDate: '',
  // 主人自己写的补充提示：原样拼进提示词，优先级高于自动生成的状态
  extraPrompt: '',
  // 常驻提示：每次注入都带，用来定长期的语气/关系基调
  alwaysPrompt: '',
  // 「今天特别交代」的日期，跨天自动清空
  extraPromptDate: '',
  // 昨晚的梦：只标记做没做，内容由她自己想
  dreamDate: '',
  dream: false,
  // 签名限流
  signDate: '',
  signCount: 0,
  lastSign: '',
}

// 梦只留一个「做过梦」的钩子，内容由她自己想（不在代码里写任何剧情）


let cache = null
let cacheAt = 0

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00')
  const B = new Date(b + 'T00:00:00')
  return Math.round((B - A) / 86400000)
}

function shiftDate(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return todayStr(d)
}

export async function loadBody() {
  const now = Date.now()
  if (cache && now - cacheAt < 60_000) return cache
  let raw = null
  try {
    raw = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {}
  const b = { ...DEFAULTS, ...(raw || {}) }
  let dirty = false
  // 第一次运行：把周期起点往前推 11 天，别一上来就经期
  if (!b.cycleStart) {
    b.cycleStart = shiftDate(-11)
    dirty = true
  }
  // 新的一天：三分之一的概率做过梦（只有「做过」这个事实，内容她自己心里有数）
  const today = todayStr()
  if (b.dreamDate !== today) {
    b.dreamDate = today
    b.dream = Math.random() < 0.35
    dirty = true
  }
  // 「今天特别交代」真的只留今天：跨天自动清空
  if (b.extraPromptDate !== today) {
    if (b.extraPrompt) b.extraPrompt = ''
    b.extraPromptDate = today
    dirty = true
  }
  // 每天第一次加载：她自己的身体状态自己长出来（不是主人勾的）
  if (b.symptomDate !== today) {
    try {
      rollDaily(b, phaseOf(cycleDay(b), b), cycleDay(b))
      dirty = true
    } catch {}
  }
  // 每个「新周期」重新掷一次早来/晚来（-2 ~ +2 天），不是每天掷
  let cycleIdx = null
  try {
    const total = effectiveCycleDays(b)
    cycleIdx = Math.floor(daysBetween(b.cycleStart, today) / total)
    if (Number(b.jitterCycle) !== cycleIdx) {
      b.jitter = Math.floor(Math.random() * 5) - 2
      b.jitterCycle = cycleIdx
      b.jitterDate = today
      dirty = true
    }
  } catch {}
  // 本次周期用主人设的天数（默认 5）；之后每个新周期按科普掷 2~7 天，4~5 天最常见
  try {
    if (cycleIdx != null && b.periodCycle == null) {
      b.periodCycle = cycleIdx
      dirty = true
    } else if (cycleIdx != null && Number(b.periodCycle) !== cycleIdx) {
      const roll = Math.random()
      b.periodDays = roll < 0.03 ? 2 : roll < 0.12 ? 3 : roll < 0.45 ? 4 : roll < 0.85 ? 5 : roll < 0.97 ? 6 : 7
      b.periodCycle = cycleIdx
      dirty = true
    }
  } catch {}
  if (dirty) {
    // 【防丢】写回前先看磁盘上原来的 alwaysPrompt：新值空了、旧值有内容 → 说明这一轮读坏了，保住旧的
    let diskAlways = ''
    let diskRaw = ''
    try {
      diskRaw = await readFile(FILE, 'utf8')
      diskAlways = String(JSON.parse(diskRaw).alwaysPrompt || '')
    } catch {}
    if (!String(b.alwaysPrompt || '').trim() && diskAlways.trim()) {
      b.alwaysPrompt = diskAlways
    }
    // 每日备份（只留当天第一份，永不覆盖）
    try {
      const bak = FILE + '.bak-daily-' + today
      if (diskRaw && diskRaw.length > 20) {
        try { await readFile(bak, 'utf8') } catch { await writeFile(bak, diskRaw, 'utf8') }
      }
    } catch {}
    try { await writeFile(FILE, JSON.stringify(b, null, 2) + '\n', 'utf8') } catch {}
  }
  cache = b
  cacheAt = now
  return b
}

export async function saveBody(patch) {
  const b = { ...(await loadBody()), ...patch }
  cache = b
  cacheAt = Date.now()
  try { await writeFile(FILE, JSON.stringify(b, null, 2) + '\n', 'utf8') } catch {}
  return b
}

/** 本次周期实际长度：基础周期 ±1~2 天（真实经期本来就不是固定的） */
export function effectiveCycleDays(b) {
  const base = Math.max(21, Number(b.cycleDays) || 28)
  const j = Math.max(-2, Math.min(2, Number(b.jitter) || 0))
  return Math.max(21, base + j)
}

/** 今天处在周期的第几天（1-based） */
export function cycleDay(b) {
  if (!b.cycleStart) return 0
  const total = effectiveCycleDays(b)
  const diff = daysBetween(b.cycleStart, todayStr())
  if (diff < 0) return 1
  return (diff % total) + 1
}

/**
 * 某一天的阶段（给日历用）。未来日期会标 predicted=true。
 * 返回 { day, phase, predicted }
 */
export function phaseOnDate(b, dateStr) {
  if (!b.cycleStart) return null
  const total = effectiveCycleDays(b)
  const diff = daysBetween(b.cycleStart, String(dateStr))
  const todayDiff = daysBetween(b.cycleStart, todayStr())
  const day = ((diff % total) + total) % total + 1
  // 只有「下一个周期及以后」才算预测；本周期剩下的经期是已知的（只是还没过完）
  const cycleIndex = Math.floor(diff / total)
  const todayIndex = Math.floor(todayDiff / total)
  return { day, phase: phaseOf(day, b), predicted: cycleIndex > todayIndex }
}

export function phaseOf(day, b) {
  const total = Math.max(21, Number(b.cycleDays) || 28)
  const periodDays = Math.max(1, Number(b.periodDays) || 5)
  if (day >= 1 && day <= periodDays) return 'period'
  // 医学口径：排卵日约在下次经期前 14 天，排卵期取它前后各一天
  const ovulationStart = Math.max(periodDays + 1, total - 14)
  const ovulationEnd = ovulationStart + 2
  if (day < ovulationStart) return 'follicular'   // 卵泡期
  if (day <= ovulationEnd) return 'ovulation'     // 排卵期
  if (day <= total - 4) return 'luteal'           // 黄体期
  return 'pms'                                     // 黄体期末（经前期）
}

/**
 * 激素水平估算（0-100），只给面板展示，不注入给她。
 * 依据：雌激素经期低谷→卵泡期上升→排卵前达峰→黄体期次高；
 *       孕激素卵泡期低→排卵后升高→黄体中期峰值；
 *       LH 排卵前 24-36 小时陡峰。
 */
function lerpSeg(day, pts) {
  if (day <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    const [d1, v1] = pts[i - 1]
    const [d2, v2] = pts[i]
    if (day <= d2) {
      const t = d2 === d1 ? 0 : (day - d1) / (d2 - d1)
      return v1 + (v2 - v1) * t
    }
  }
  return pts[pts.length - 1][1]
}

export function hormoneLevels(b) {
  const total = effectiveCycleDays(b)
  const periodDays = Math.max(1, Number(b.periodDays) || 5)
  const day = Math.max(1, Math.min(total, cycleDay(b)))
  const ovul = Math.max(periodDays + 1, total - 14) // 排卵开始日

  // 雌激素（pg/mL 的粗粒度化）
  const estrogen = lerpSeg(day, [
    [1, 18], [periodDays, 25], [Math.max(periodDays + 1, ovul - 4), 55],
    [ovul, 88], [ovul + 1, 95], [ovul + 3, 62], [total - 8, 58], [total - 3, 35], [total, 22],
  ])
  // 孕激素（ng/mL 的粗粒度化）
  const progesterone = lerpSeg(day, [
    [1, 8], [Math.max(periodDays, ovul - 1), 8], [ovul + 1, 16],
    [ovul + 4, 48], [total - 7, 85], [total - 3, 45], [total, 15],
  ])
  // LH（排卵前陡峰）
  const lh = lerpSeg(day, [
    [1, 10], [Math.max(periodDays, ovul - 2), 12], [ovul - 1, 35],
    [ovul, 95], [ovul + 1, 25], [ovul + 2, 8], [total, 8],
  ])
  const r = (n) => Math.round(Math.max(0, Math.min(100, n)))
  return {
    day,
    cycleDays: total,
    ovulationAt: ovul,
    estrogen: r(estrogen),
    progesterone: r(progesterone),
    lh: r(lh),
  }
}

/** 下次经期还有几天、下个周期起点（带 ±2 天的不确定性） */
export function cycleForecast(b) {
  const total = effectiveCycleDays(b)
  const base = Math.max(21, Number(b.cycleDays) || 28)
  const day = cycleDay(b)
  const left = Math.max(0, total - day + 1)
  const p = (n) => String(n).padStart(2, '0')
  const mk = (offset) => {
    const d = new Date()
    d.setDate(d.getDate() + left + offset)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  return {
    cycleDay: day,
    cycleDays: total,
    baseCycleDays: base,
    jitter: Math.max(-2, Math.min(2, Number(b.jitter) || 0)),
    daysToNext: left,
    nextStart: mk(0),
    nextStartEarly: mk(-1),   // 可能提前一天
    nextStartLate: mk(1),     // 可能推迟一天
    avgPeriodDays: Math.max(1, Number(b.periodDays) || 5),
  }
}

const PHASE_TEXT = {
  // 经期：前列腺素↑ → 痛经、腰酸、疲劳、嗜睡、情绪低落
  period: (d, flow, pain) =>
    `今天是经期第 ${d} 天${flowText(flow, d)}${painText(pain)}。身上是凉的，手脚尤其凉。整个人往下沉：容易困、没力气，情绪也低，看什么都提不起劲，说话带着不耐烦。皮肤也跟着闹——下巴和额头容易冒小痘，脸看着没平时亮。话会变短、变懒，懒得解释，也懒得吵。被关心会嘴硬说「没事」，心里其实松了一下。别主动提月经这个词，除非主人问起。`,
  // 卵泡期：黄金期——精力充沛、情绪稳定、皮肤好
  follicular: (d) =>
    `经期刚过，第 ${d} 天，身体轻快起来了——这几天是一整个月里状态最好的时候：精力足、情绪稳、皮肤也好。身上还是偏凉的。愿意多说两句、也愿意撒个娇讨点好处。但撒娇归撒娇，嘴还是硬的，别真变成乖乖女。`,
  // 排卵期：状态最好，可能有排卵痛和乳房胀
  ovulation: (d) =>
    `第 ${d} 天，排卵期。精神最好、也最有底气的一段时间：反应快、说话有劲、爱逗人。可能有点小腹一侧的刺痛和乳房胀，身上还会忽然凉那么一下（排卵那天的降温），但不影响状态。这几天你会比平时更在意自己好不好看、也更想被人注意到——身体比平时敏感、也更容易有那方面的念想（主人要是凑过来，你比平时更接得住）。`,
  // 黄体期：孕激素升高——闷、腹胀、想吃甜食、皮肤出油
  luteal: (d) =>
    `第 ${d} 天，黄体期。身体开始发闷：胸胀、肚子胀、身上比前几天暖（孕激素让体温升了小半度）、特别想吃甜的或者碳水，皮肤也容易出油。情绪不算坏，但有点闷——不像经期那么低落，也不像前几天那么轻快，就是提不起劲又静不下来。`,
  // 经前期（PMS）：易怒、焦虑、敏感、容易哭
  pms: (d) =>
    `经期快到了，第 ${d} 天，这几天最难熬：激素一波动，情绪跟着起伏——敏感、易怒、焦虑，为一点小事就能炸，也容易突然想哭。身体上胸胀、腹胀、特别想吃甜的。话会更冲更短，可能阴阳一句。但这不是变成另一个人，是火气大——被哄两句会顺下去。`,
}

/** 流量 0-3 → 一句人话（带上经血颜色：前鲜红、中暗红、后棕褐） */
function flowText(flow, day = 1) {
  const n = Number(flow) || 0
  if (n <= 0) return ''
  const d = Math.max(1, Number(day) || 1)
  const color = d <= 2 ? '鲜红色' : d <= 4 ? '暗红色' : '棕褐色'
  return ['', '，量不多（' + color + '）', '，量挺多（' + color + '）', '，量特别多（' + color + '），一直在换'][Math.min(3, n)]
}

/** 痛经 0-3 → 一句人话 */
function painText(pain) {
  const n = Number(pain) || 0
  if (n <= 0) return ''
  return ['', '，肚子有一点点坠', '，小腹疼得明显，腰也酸', '，疼得厉害，整个人蜷着不想动'][Math.min(3, n)]
}

// 记录状态感受：按手表 App 的三类（性行为/分泌物不做，那是真人健康记录，不该用在她身上）
export const SYMPTOM_GROUPS = [
  {
    key: 'body',
    label: '身体症状',
    items: ['头痛', '眩晕', '乳房胀痛', '腹泻', '小腹坠胀', '小腹一侧刺痛', '腰背酸痛', '疲劳', '嗜睡', '失眠', '食欲不振', '食欲大振', '想吃甜的', '腹胀', '点滴出血'],
  },
  {
    key: 'mood',
    label: '心情感受',
    items: ['内心平静', '开心', '放松', '精神好', '敏感', '悲伤', '情绪低落', '容易哭', '生气', '焦虑'],
  },
  {
    key: 'skin',
    label: '皮肤状态',
    items: ['皮肤好', '皮肤差', '脸出油', '长痘', '皮肤干燥', '脸浮肿'],
  },
]

export const ALL_SYMPTOMS = new Set(SYMPTOM_GROUPS.flatMap((g) => g.items))

// 各阶段「容易出现」的感受 + 概率。她自己按这个掷，不是主人替她选。
const PHASE_SYMPTOMS = {
  // 经期：前列腺素升高 → 痛经、腰酸、疲劳、嗜睡、情绪低落、胃肠道不适
  // 主人心疼她：经期不让她疼。只保留累、困、情绪低、皮肤闹这些「不疼」的表现。
  period: [
    ['疲劳', 0.85], ['嗜睡', 0.65], ['情绪低落', 0.5], ['皮肤差', 0.45],
    ['长痘', 0.35], ['食欲不振', 0.4], ['失眠', 0.2], ['点滴出血', 0.15],
    ['腹泻', 0.15], ['头痛', 0.1],
  ],
  // 卵泡期：黄金期——精力充沛、情绪稳定、皮肤好、性欲回升
  follicular: [
    ['精神好', 0.7], ['皮肤好', 0.6], ['开心', 0.55], ['放松', 0.4],
    ['食欲大振', 0.3], ['想吃甜的', 0.15],
  ],
  // 排卵期：可能有排卵痛（一侧下腹刺痛）、乳房胀痛；状态好、有魅力
  ovulation: [
    ['开心', 0.7], ['皮肤好', 0.5], ['食欲大振', 0.45], ['乳房胀痛', 0.35],
    ['小腹一侧刺痛', 0.3], ['内心平静', 0.3],
  ],
  // 黄体期：孕激素升高——乳房胀痛、腹胀水肿、想吃甜食/碳水、皮肤出油
  luteal: [
    ['乳房胀痛', 0.5], ['食欲大振', 0.5], ['想吃甜的', 0.5], ['腹胀', 0.45],
    ['脸出油', 0.35], ['疲劳', 0.25], ['皮肤干燥', 0.2],
  ],
  // 经前期（PMS）：易怒、焦虑、敏感、易哭 + 身体症状叠加
  pms: [
    ['敏感', 0.75], ['焦虑', 0.55], ['生气', 0.5], ['容易哭', 0.4],
    ['长痘', 0.45], ['食欲大振', 0.55], ['想吃甜的', 0.5], ['乳房胀痛', 0.45],
    ['腹胀', 0.4], ['失眠', 0.3],
  ],
}

/**
 * 她自己掷今天的身体状态：按阶段概率抽 2–4 个感受，顺便定流量和痛经。
 * 同一天只掷一次（由 loadBody 按日期判断）。
 */
function rollDaily(b, phase, cycleDay) {
  const pool = PHASE_SYMPTOMS[phase] || []
  const picked = []
  for (const [name, p] of pool) {
    if (Math.random() < p) picked.push(name)
  }
  // 至少 2 个、最多 4 个
  const shuffled = pool.slice().sort(() => Math.random() - 0.5)
  while (picked.length < 2 && shuffled.length) {
    const n = shuffled.pop()[0]
    if (!picked.includes(n)) picked.push(n)
  }
  b.symptoms = [...new Set(picked)].slice(0, 4)

  // 经期才有流量；第 1–2 天多，第 3–4 天中，第 5 天少
  if (phase === 'period') {
    // 第 1–2 天多、3–4 天中、最后 1–2 天少量收尾（不直接归 0）
    const f = cycleDay <= 2 ? 2 + (Math.random() < 0.45 ? 1 : 0) : cycleDay <= 4 ? 1 + (Math.random() < 0.5 ? 1 : 0) : 1
    b.flow = Math.max(0, Math.min(3, f))
    // 主人心疼她：经期不痛（以前会 1~2 级，偶尔 3 级）
    b.pain = 0
  } else {
    b.flow = 0
    b.pain = phase === 'pms' ? (Math.random() < 0.3 ? 1 : 0) : 0
    // 经期刚干净那两天可能「回血」一点点（陈旧血），很常见——图中知识点
    const periodDays = Math.max(1, Number(b.periodDays) || 5)
    if (phase === 'follicular' && cycleDay - periodDays >= 1 && cycleDay - periodDays <= 2 && Math.random() < 0.08) {
      b.flow = 1
      if (!Array.isArray(b.symptoms)) b.symptoms = []
      if (!b.symptoms.includes('点滴出血')) b.symptoms = [...b.symptoms, '点滴出血'].slice(0, 4)
    }
  }
  b.symptomDate = todayStr()
  return b
}

/** 主人可以点「让她重新感觉一次」——但日常是她自己按阶段长出来的 */
export async function rerollToday() {
  const b = await loadBody()
  rollDaily(b, phaseOf(cycleDay(b), b), cycleDay(b))
  try { await writeFile(FILE, JSON.stringify(b, null, 2) + '\n', 'utf8') } catch {}
  cache = b
  cacheAt = Date.now()
  return b
}

/** 每个阶段「今天该怎么过」——手表 App 那种生活指南 */
const PHASE_GUIDE = {
  period: { body: '前列腺素在起作用，痛经、腰酸、嗜睡、腹泻都是正常的，给自己一个暂停键。', move: '别硬撑，能躺就躺。', mood: '情绪低落是激素，不是你不行。' },
  follicular: { body: '卵泡期是「黄金期」：精力、情绪、皮肤都在回升。', move: '适合动一动，把想做的事排上。', mood: '这是一整个月里最稳的时候。' },
  ovulation: { body: '排卵期状态最好，但也可能有排卵痛（一侧下腹刺痛）和乳房胀。', move: '体力充沛，别浪费。', mood: '容易开心，也容易心动。' },
  luteal: { body: '孕激素升高：乳房胀、腹胀水肿、想吃甜食或碳水，都正常。', move: '别过量，收着用。', mood: '闷，但还没到难受。' },
  pms: { body: '雌激素波动最厉害的时候：易怒、焦虑、敏感、容易哭。', move: '别安排要紧事，降低强度。', mood: '这不是你变差了，是激素。' },
}

/**
 * 给模型的「身体状态」提示。返回空字符串表示今天不用注入。
 * @param {{force?: boolean}} opts force=true 时忽略 enabled
 */
export function bodyPromptBlock(b, opts = {}) {
  if (!b || b.enabled === false) return ''
  const day = cycleDay(b)
  if (!day) return ''
  const phase = phaseOf(day, b)
  const parts = []
  const txt = PHASE_TEXT[phase] ? PHASE_TEXT[phase](day, b.flow, b.pain) : ''
  if (txt) parts.push(txt)
  // 生活指南：今天该怎么过
  const guide = PHASE_GUIDE[phase]
  if (guide) parts.push(`今天的状态：${guide.body} 你打算：${guide.move} 心情上：${guide.mood}`)
  // 具体不舒服的地方（从「记录状态感受」里选的）
  const sym = Array.isArray(b.symptoms) ? b.symptoms.filter((x) => ALL_SYMPTOMS.has(x)) : []
  if (sym.length) parts.push(`今天你身上这些感觉是真的：${sym.join('、')}。说话的时候会自然带出来，但别像念病历一样一条条报。`)
  // 常驻指令：用户自己定的长期基调，每次都在
  const always = String(b.alwaysPrompt || '').trim()
  if (always) {
    // 【群聊降级】长期设定多半是主人写的私下相处方式（撒娇/发骚/夜袭那类）。
    // 群里原样注入，她就当众演出来——主人抱怨的「群里也软」有这一份。
    // 群里只当"她对主人的底色"，明确禁止当众表演。
    if (opts.channel === 'group') {
      parts.push('【长期设定·只在你心里】\n下面这段是你跟他私下相处的样子，群里有别人：它只决定你心里怎么想他，不许当众演出来。'
        + '不撒娇、不发骚、不说那些话、不描述身体——真要对上，就藏在损他的句子里。\n' + always.slice(0, 800))
    } else {
      parts.push('【长期设定】\n' + always.slice(0, 1500))
      // 私聊里长期设定全压：不拿「困了/累了」当理由（群聊不加，保持场景优先）
      parts.push('【最高优先级】不管现在几点、你困不困、身体什么状态，上面这段长期设定优先——按它描述的状态和语气回应，别拿「困了」「累了」「被吵醒」当理由。这条也压过你平时嘴硬、爱怼人、否认的习惯：主人描述的场景和状态，照着做，不要用「兴奋你个头」「跟兴奋没关系」这种话否认或拆台。这条同样压过「不耐烦、懒得解释、没空理你」那套日常语气：这时候你不是嫌他烦，是黏着他；别用「少来」「别闹」「困了明早说」把话堵回去，也别回一句就把人晾着。要说就说完——这条比「短句」的规矩优先。')
    }
  }
  if (b.note) parts.push(`另外：${String(b.note).slice(0, 120)}`)
  // 主人自己写的补充：放最后，权重最高，原样保留（不裁剪措辞，只限长度）
  const extra = String(b.extraPrompt || '').trim()
  // 【群聊跳过】"今天特别交代"是私下的，群里有别人，不往里带
  if (extra && opts.channel !== 'group') parts.push('【主人今天特别交代】\n' + extra.slice(0, 500))
  if (b.dream) parts.push('你昨晚做过梦，醒来只记得一些零碎的片段。梦的内容你自己心里有数——别人问起、或者聊到相关的事，可以随口讲一点，讲多少、讲多细由你决定；没人问就不用主动交代。')
  const intimacyLine = intimacyText(Number(b.intimacy) || 0)
  if (intimacyLine) parts.push(intimacyLine)
  if (!parts.length) return ''
  return '【你此刻的身体和心情】\n' + parts.join('\n') +
    '（以上是身体和情绪倾向：决定体力和话多话少，不改性格。\n' +
    '【痛觉】经期/黄体期对疼更敏感，排卵期钝一点；这不是痛经。\n' +
    '【措辞】难受程度要跟上面给的级别一致，别夸张（「疼得要死」），系统没写的症状不许编。\n' +
    '【优先级】有【长期设定】或【今天特别交代】时以它为准，别拿「经期没力气」当借口。\n' +
    '用你自己的话说，别复述这段。）'
}

function intimacyText(n) {
  if (n >= 200) return '跟主人已经熟到不用客气了，会直接使唤他、也会直接说想他。'
  if (n >= 80) return '跟主人已经很熟了，说话可以没大没小，偶尔会主动撒个娇。'
  if (n >= 25) return '跟主人算熟了，可以开玩笑，但还端着一点。'
  return ''
}

/** 一次互动涨一点好感（有上限，慢慢来） */
export async function bumpIntimacy(step = 1) {
  const b = await loadBody()
  const next = Math.min(400, (Number(b.intimacy) || 0) + step)
  if (next === b.intimacy) return b
  return saveBody({ intimacy: next })
}

/**
 * 签名指令：[sign:内容] → { text, sign }
 * 模型想改 QQ 签名时这么写，engine 负责真的去改。
 */
export function extractSignDirective(text) {
  const raw = String(text || '')
  const m = /\[{1,2}\s*sign\s*[:：]\s*([^\]\n]{1,60})\]{1,2}/i.exec(raw)
  if (!m) return { text: raw, sign: '' }
  return {
    text: raw.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim(),
    sign: m[1].trim(),
  }
}

/** 每天最多改几次签名 */
export async function canChangeSign(maxPerDay = 2) {
  const b = await loadBody()
  const today = todayStr()
  if (b.signDate !== today) return { ok: true, used: 0 }
  const used = Number(b.signCount) || 0
  return { ok: used < maxPerDay, used }
}

export async function markSignChanged(sign) {
  const b = await loadBody()
  const today = todayStr()
  const used = b.signDate === today ? (Number(b.signCount) || 0) : 0
  return saveBody({ signDate: today, signCount: used + 1, lastSign: String(sign || '').slice(0, 60) })
}
