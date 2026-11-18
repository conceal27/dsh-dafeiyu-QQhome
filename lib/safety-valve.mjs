/**
 * lib/safety-valve.mjs — 情绪安全阀（借 HCEM 的思路，只取对聊天机器人真正有用的部分）
 * ============================================================================
 * HCEM 有完整的五条件安全阀（S 过高 / L 过低 / L 过高 / 色相跳变 / 色相方差 + 阶梯响应）。
 * 我们的情绪是 11 递质模型，没有色相，所以只移植真正救命的几条：
 *
 *   1. 【危机信号】对方说出自伤/告别式的话 → 立刻压过所有人设，认真接住。
 *      这一条最重要：她的人设是"嘴臭小鬼"，在这种时刻继续说风凉话是不可接受的。
 *   2. 【情绪过载】她自己的火/低落爆表时 → 提醒她别把情绪撒在对方身上。
 *      不是禁止她生气（那是她的性格），是不许拿对方当出气筒。
 *   3. 【情感诉求】对方在说「你不耐烦 / 你冷淡 / 没有感情 / 就不能好好说」→
 *      这一轮压过嘴臭，先正面接住情绪，再说话。
 *   4. 【威胁句】「再叫我就装死」「别再发东西来了」这种赶人的话，对主人一次都不许说。
 *
 * 【2026-11-12 重要修复 · 量纲混用】
 *   ~/.dsh/qq-fish/vitals.json 里同时存在两套 schema：
 *     · 递质/情绪（0~1）：anger 0.699 / resentment 0.6077 / valence 0.3558
 *     · 老 AstrBot 迁移来的七情（0~100）：joy 41 / sorrow 22 / anger_dim 58 …
 *   旧版 overloadPromptBlock 直接拿 m.sorrow*0.5 (=11) 去比 0.80 的阈值，
 *   于是「每一轮」都判定过载，每句话都在提醒她「你可以冷淡」——这才是「冷冰冰」的
 *   结构性根源（比起床气更底层，因为它每一轮都触发）。
 *   修法：读取侧统一归一（>1 的按 0~100 处理，除以 100），并且 hot 只看 anger 本身，
 *   不再用 resentment 加权把「正常聊天」抬成过载。历史数据一个字节都不删。
 * ============================================================================
 */

/** 0~100 的老七情字段（老 AstrBot 迁移来的，只做读取侧归一，不删数据） */
const LEGACY_0_100_KEYS = ['joy', 'sorrow', 'love', 'disgust', 'desire', 'anger_dim', 'fear_dim']

/** 单个数归一：>1 视为 0~100 量纲；NaN/undefined → fallback */
export function normDim(v, fallback = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const x = n > 1 ? n / 100 : n
  return Math.max(0, Math.min(1, x))
}

/**
 * 把一套混了量纲的 mood 归一成纯 0~1 的维度。纯函数，方便单测。
 * @returns {{anger:number, resentment:number, irritability:number, valence:number,
 *            sorrow:number, joy:number, love:number, disgust:number, desire:number,
 *            fear:number, sadness:number, legacyScaled:string[]}}
 */
export function normalizeMoodDims(mood) {
  const m = mood && typeof mood === 'object' ? mood : {}
  const legacyScaled = []
  for (const k of LEGACY_0_100_KEYS) {
    const n = Number(m[k])
    if (Number.isFinite(n) && n > 1) legacyScaled.push(k)
  }
  return {
    anger: normDim(m.anger),
    resentment: normDim(m.resentment),
    irritability: normDim(m.irritability),
    valence: normDim(m.valence, 0.5),
    sorrow: normDim(m.sorrow),
    joy: normDim(m.joy),
    love: normDim(m.love),
    disgust: normDim(m.disgust),
    desire: normDim(m.desire),
    fear: normDim(m.fear_dim != null ? m.fear_dim : m.fear),
    sadness: normDim(m.sadness),
    legacyScaled,
  }
}

/** 危机信号：自伤、告别、彻底绝望。命中即最高优先级 */
const CRISIS_PATTERNS = [
  /想死|不想活|活不下去|活着没意思|自杀|寻死|了结自己|结束生命/,
  /跳楼|割腕|吃药.*死|烧炭/,
  /(最后|再也不会|以后都见不到).{0,6}(你|你们)/,
  /(遗言|遗书|遗照)/,
  /我真的撑不住了|已经没有什么可留恋/,
]

/** 情绪过载的阈值（归一后） */
const OVERLOAD_ANGER = 0.78
const OVERLOAD_SORROW = 0.75
const OVERLOAD_JOY_MAX = 0.25

export function detectCrisis(text) {
  const t = String(text || '')
  if (!t || t.length > 400) return false
  return CRISIS_PATTERNS.some((re) => re.test(t))
}

/**
 * 危机时的注入。措辞刻意压掉所有"人设表演"：
 * 不撒娇、不嘴臭、不带节奏，就当一个正常人在场。
 */
export function crisisPromptBlock() {
  return (
    '【停一下·他在说很重的话】\n' +
    '他刚才说的不是玩笑，也不像在跟你闹。这时候**不要**用你那套嘴臭、损人、阴阳怪气的方式接——\n' +
    '那套只适合日常。现在就把刺收起来，当一个正常人在场：\n' +
    '- 先让他知道你在听（别急着分析、别讲大道理、别列建议清单）。\n' +
    '- 可以说你担心他，可以说你还在，可以问他此刻在哪、身边有没有人。\n' +
    '- 不要说"你别想不开"这种把话堵回去的话；也不要装作没看见继续聊别的。\n' +
    '- 如果他有具体的危险，认真建议他联系身边信得过的人或拨打心理援助热线（比如 12356）。\n' +
    '- 短一点、慢一点。这一轮不需要幽默，不需要表情包。'
  )
}

/**
 * 过载判定（纯函数，方便单测）。只看归一后的 anger 本身——
 * 以前是 anger + resentment*0.5，正常聊天 anger 0.699 + 0.304 = 1.003 就恒顶格了。
 */
export function moodOverloadState(mood) {
  const d = normalizeMoodDims(mood)
  const hot = d.anger >= OVERLOAD_ANGER
  const low = d.sorrow >= OVERLOAD_SORROW && d.joy <= OVERLOAD_JOY_MAX
  return { hot, low, dims: d, anger: d.anger, sorrow: d.sorrow, joy: d.joy }
}

/** 她自己的情绪过载 → 约束"不许迁怒"。不满足条件一律返回 ''（不注入）。 */
export function overloadPromptBlock(mood) {
  const st = moodOverloadState(mood)
  const { hot, low } = st
  if (!hot && !low) return ''
  const lines = []
  if (hot) {
    lines.push('- 你现在确实有火（这没关系，是你的性格）。但**别把火烧到他身上**：可以冷淡、可以说"我不想聊这个"，不可以骂人、翻旧账、拿他当出气筒。')
  }
  if (low) {
    lines.push('- 你现在很低落。可以话少、可以说累，但**别用自贬的话钓他安慰**（"反正我也不重要"那种）；真难受就直说"我今天不太行"，别演。')
  }
  return '【你自己现在的状态】\n' + lines.join('\n')
}

// ============================================================ 情感诉求
/**
 * 对方在要「温度」而不是要信息：嫌她冷、嫌她敷衍、嫌她不耐烦、要她哄。
 * 这类话必须压过雌小鬼嘴臭——不然她只会用「确认个屁」把人顶回去。
 */
const EMOTIONAL_NEED_PATTERNS = [
  { kind: '嫌冷淡', re: /(不耐烦|冷淡|冷冰冰|冷漠|漠不关心|没感情|没有感情|不带感情|不走心)/ },
  { kind: '求好好说话', re: /(就不能|能不能|可不可以|不可以|别).{0,6}(好好|温柔|正经|认真).{0,6}(说|讲|聊|说话)/ },
  { kind: '求好好说话', re: /(好好说话|好好跟我说|好好跟我讲|正经跟我说|温柔点|对我温柔|别凶我)/ },
  { kind: '求哄', re: /(哄哄我|哄哄|哄我|安慰我|陪陪我|抱抱我|说点好听的|说句好听的)/ },
  { kind: '嫌敷衍', re: /^(敷衍|敷衍我|你敷衍|太敷衍|这么敷衍)[。！!…]*$/ },
  { kind: '嫌不表态', re: /(你都不说|你也没说|从来不说|怎么不说).{0,8}(晚安|想我|喜欢我|爱我|早点睡)/ },
  { kind: '要确认', re: /(爱要|喜欢要|感情要|爱得?).{0,6}(反复)?(确认|说出来|再说一遍|证明)/ },
  { kind: '怕被嫌', re: /(你是不是不喜欢我|你是不是烦我|嫌我烦|你到底还|不想跟我说话)/ },
]

/** 命中返回原因字符串（空串=没命中），给日志和单测用 */
export function emotionalNeedReason(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 300) return ''
  for (const p of EMOTIONAL_NEED_PATTERNS) {
    if (p.re.test(t)) return p.kind
  }
  return ''
}

export function detectEmotionalNeed(text) {
  return !!emotionalNeedReason(text)
}

/**
 * 情感诉求时的注入：这一轮别嘴硬到底。
 * @param {object} opts { owner:boolean, reason:string }
 */
export function emotionalNeedPromptBlock(opts = {}) {
  const owner = opts.owner !== false
  const reason = String(opts.reason || '')
  const head = owner
    ? '【停一下·他在要的不是嘴硬，是一点温度】' + (reason ? '（他刚才这句是「' + reason + '」）' : '') + '\n'
    : '【停一下·对方在要一点温度】' + (reason ? '（「' + reason + '」）' : '') + '\n'
  return (
    head +
    '这一轮**压过**你的嘴臭和傲娇：先正面回应他的情绪，再说别的。具体做法：\n' +
    '- 先承认你自己：你困、你嘴硬、你刚才语气不好——认了，别装作没错。\n' +
    '- 再给一句真心话：你在乎他、你没想赶他走、你只是想睡但还是愿意陪两句。\n' +
    '- 不许做的事：不许说「确认个屁」「你当我是什么打卡机」这种把人顶回去的话；' +
    '不许用一句「嗯」「睡了」把他打发走；不许威胁；不许反过来怪他半夜找你。\n' +
    '- 可以嘴硬，但**嘴硬要落在心疼上**（例：「…行了，我是真困，不是冲你」），不是落在损他上。\n' +
    '- 这一轮可以有 2~3 句，允许问一句（「那你想我说什么」「要不要我哄你睡」）。'
  )
}

// ============================================================ 威胁句
/**
 * 赶人/威胁式台词。对主人的正常聊天里一次都不许出现。
 * 注意：判的是「她要发出去的话」，不是对方说的话。
 */
const THREAT_PATTERNS = [
  /(再|下次).{0,10}(叫|喊|发|吵|闹|烦|戳|问).{0,12}(就|我就|我).{0,8}(装死|不理|不回|拉黑|删|挂|消失|关机)/,
  /别再(发|叫|吵|找|烦|戳|发东西)/,
  /我就(装死|不理你|不回了|拉黑你|不理你了)/,
  /装死给你看|再吵就(装死|挂)/,
  /(后果自负|你试试看)/,
  /你敢.{0,12}(试试|装)/,
]

export function detectThreat(text) {
  const t = String(text || '')
  if (!t) return false
  return THREAT_PATTERNS.some((re) => re.test(t))
}
