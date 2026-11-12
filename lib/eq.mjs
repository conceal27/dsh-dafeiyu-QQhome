/**
 * lib/eq.mjs — 情商层：读情境 → 选策略 → 检查回复
 * ============================================================================
 * 为什么要有这一层：
 *   以前所有的"该怎么回"都散在人设里，互相打架，还全靠模型自觉。
 *   结果就是——你说道歉，她追着打；你说晚安，她拽着你不放。
 *
 * 这层做三件事：
 *   1. readSituation：从这句话 + 最近几句，判断现在是什么场面
 *   2. strategyOf：这个场面该怎么说话（几条、什么语气、不能做什么）
 *   3. checkReply：生成完检查一遍，越界就打回重写（只重写一次）
 *
 * 情境判断全用规则，不调模型——不增加延迟。
 *
 * 【2026-11-12】新增 needy（对方在要温度：嫌你冷/敷衍/不耐烦、要你哄）：
 *   以前这类话会被兜进 info，于是她照原样嘴臭回去（"确认个屁"）。
 *   现在 needy 压过 closing —— 主人说「你都不说晚安 / 我不喜欢不耐烦的」时，
 *   她必须先把情绪接住，不能借着收尾把人打发掉。
 * ============================================================================
 */

import { emotionalNeedReason, detectThreat } from './safety-valve.mjs'

const CLOSING_RE = /(晚安|睡了|睡觉了|先这样|先撤|不聊了|下了|拜拜|bye|明天见|明天聊|改天聊|下次聊|我去睡了|我睡了|先睡|困了先睡|梦里见|梦里聊|去梦里|躺了|我躺了|关机|闭眼|睡啦|收工|撤了|下线|洗洗睡|去睡)/i
const APOLOGY_RE = /(对不起|抱歉|道歉|是我不好|我错了|我不对|我不好|原谅我|一时冲动|刚才是我|是我不对|我不该|怪我|赔罪|别生气|不生气了好不好)/i
const ANGRY_RE = /(你凶|你凶我|生气了|不理你|讨厌你|滚|闭嘴|烦死|不爽|不高兴|气死|火大|有点气)/i
const COMFORT_RE = /(好累|累死|难受|不开心|烦|压力|撑不住|崩溃|委屈|想哭|emo|难受死|心里堵|有点丧|顶不住|熬不住|心态崩)/i
const PLAYFUL_RE = /(哈哈|笑死|笑不活|笑yue|嘿嘿|逗你|开玩笑|草|乐死|绷不住|乐)/i
const QUESTION_RE = /[?？]|吗$/i

/**
 * 读情境。返回 { mode, weight, hint }
 * mode: closing | apology | comfort | playful | angry | needy | info
 */
export function readSituation(text, recent = []) {
  const t = String(text || '')
  const tail = recent.slice(-3).map((r) => String(r && r.text || '')).join(' ')

  // 【最优先】对方在要温度（嫌冷淡/不耐烦/没有感情、求哄、求表态）——
  // 这一条必须压过收尾判断：主人说「你都不说晚安 / 敷衍」时，那不是要结束对话，
  // 是在说「你对我不够用心」。按 closing 处理就会变成「行，睡了」把她打发掉。
  const need = emotionalNeedReason(t)
  if (need) {
    return { mode: 'needy', weight: 1, needKind: need, hint: '对方要的不是信息，是你的态度：先正面回应情绪（承认自己嘴硬/困），再说话；不许用一句「嗯」「睡了」把他打发' }
  }

  // 收尾优先：一旦出现收尾词，其它情境都让位
  if (CLOSING_RE.test(t)) {
    return { mode: 'closing', weight: 1, hint: '对方在收尾，别挽留、别追问、别再抛话题' }
  }
  if (APOLOGY_RE.test(t)) {
    return { mode: 'apology', weight: 1, hint: '对方在道歉/服软，给台阶就下，禁止追打' }
  }
  if (ANGRY_RE.test(t)) {
    return { mode: 'angry', weight: 0.9, hint: '对方在闹脾气，先接住情绪，别讲道理' }
  }
  if (COMFORT_RE.test(t)) {
    return { mode: 'comfort', weight: 0.9, hint: '对方状态不好，先共情，别说教、别急着给方案' }
  }
  if (PLAYFUL_RE.test(t)) {
    return { mode: 'playful', weight: 0.6, hint: '对方在开玩笑，可以接梗，但别把玩笑当真去辩论' }
  }
  // 连续几条都是收尾语气
  if (tail && CLOSING_RE.test(tail)) {
    return { mode: 'closing', weight: 0.7, hint: '刚才就在收尾了，别把话题重新拉起来' }
  }
  // 暗示型收尾：句子很短、没问句、还带句号（「嗯。」「好。」「知道了。」）
  const s = t.trim()
  if (s.length <= 6 && /[。.]$/.test(s) && !QUESTION_RE.test(s)) {
    return { mode: 'closing', weight: 0.5, hint: '对方回得很短很淡，可能不想聊了——别追着问，也别硬拉话题' }
  }
  return { mode: 'info', weight: 0, hint: '' }
}

/**
 * 这个场面该怎么说话。
 * @param {object} situ readSituation 的返回
 * @param {object} ctx { awake, tired, playing, channel, owner }
 */
export function strategyOf(situ, ctx = {}) {
  const tired = !!ctx.tired
  const owner = ctx.owner !== false
  const group = ctx.channel === 'group'
  const base = { mode: situ && situ.mode || 'info', maxSentences: 3, askQuestion: true, tone: 'normal', avoid: [], group }
  // 群聊：更短、更随意，不做「接住好意」那套（那是跟主人之间的事）
  // 注意：这里只管「能不能说、说几句」，不管「用什么口气」——口气是她自己的嘴臭人设
  if (group) {
    const g = { ...base, maxSentences: 2 }
    switch (base.mode) {
      case 'needy':
        return { ...g, maxSentences: 2, askQuestion: false, tone: 'brief', avoid: ['嘴臭到底', '阴阳怪气'], hint: '群友在要温度：不用当知心姐姐，但别阴阳怪气，损一句就把关心带过去' }
      case 'closing':
        return { ...g, askQuestion: false, tone: 'brief', avoid: ['挽留', '追问'], hint: '群里有人要撤了——这不是跟你道别，能不接就不接；接了也就一句，别留人' }
      case 'apology':
        return { ...g, askQuestion: false, tone: 'brief', avoid: ['追打'], hint: '有人在道歉，别追着说。按你自己的性子来——敷衍一句「行吧」就够，不用安慰' }
      case 'angry':
        return { ...g, askQuestion: false, tone: 'brief', avoid: ['站队', '拱火', '当和事佬'], hint: '有人情绪上来了，别拱火也别劝架，可以岔开或者装没看见' }
      case 'comfort':
        return { ...g, maxSentences: 2, tone: 'sharp', avoid: ['温柔安慰', '知心姐姐', '给方案'], hint: '有人喊累喊惨：你不是会安慰人的性子。损一句、吐槽一句就行，关心最多藏在话尾巴上带过去，别真的去哄' }
      case 'playful':
        return { ...g, tone: 'playful', avoid: ['扫兴'], hint: '大家在闹，可以接一句梗' }
      default:
        return { ...g, hint: '' }
    }
  }
  switch (base.mode) {
    case 'needy':
      // 要温度的时候不许抄近路：3 句、允许问一句、语气 soft；威胁和打发都算越界
      return {
        ...base,
        maxSentences: 3,
        askQuestion: true,
        tone: 'soft',
        avoid: ['威胁', '打发', '嘴硬到底', '阴阳怪气', '把话顶回去'],
        hint: owner
          ? '他在要一点温度，不是在跟你辩论。先承认自己（困/嘴硬/刚才语气不好），再说一句真心话；可以嘴硬，但落点必须是心疼他'
          : '对方在要一点温度：先正面回应情绪，再说别的',
      }
    case 'closing':
      return {
        ...base,
        maxSentences: 2,
        askQuestion: false,
        tone: tired ? 'sleepy-soft' : 'soft',
        avoid: ['挽留', '追问', '抛新话题', '威胁'],
        hint: tired
          ? '你正困着，对方说晚安你应该松一口气，一句话收尾就好；但收尾也得有温度（「嗯，睡吧」「盖好被子」），不是冷冰冰一个「嗯」'
          : '对方在收尾，你可以舍不得，但说完就放人',
      }
    case 'apology':
      return { ...base, maxSentences: 2, askQuestion: false, tone: 'soft', avoid: ['追打', '翻旧账', '继续指责'], hint: '给台阶就下，最多说一句自己的真实感受' }
    case 'angry':
      return { ...base, maxSentences: 2, askQuestion: false, tone: 'soft', avoid: ['讲道理', '反击', '冷战'], hint: '先接住，别辩' }
    case 'comfort':
      return { ...base, maxSentences: 3, askQuestion: true, tone: 'gentle', avoid: ['说教', '给方案', '你怎么不'], hint: '先共情，再陪着，别急着解决' }
    case 'playful':
      return { ...base, maxSentences: 3, askQuestion: true, tone: 'playful', avoid: ['较真', '扫兴'], hint: '接梗就行' }
    default:
      return { ...base, hint: '' }
  }
}

/** 把情境和策略写成给模型看的一段（比散装规则精确） */
export function situationPrompt(situ, strat) {
  if (!situ || !strat || situ.mode === 'info') return ''
  // 群聊用群聊自己的说法，别把「对方在收尾」那套混进来（群里不是跟她道别）
  const head = strat.group && strat.hint ? strat.hint : situ.hint
  const lines = [`【这一轮的场合】${head}`]
  if (!strat.group && strat.hint) lines.push(strat.hint)
  if (strat.maxSentences) lines.push(`这轮最多 ${strat.maxSentences} 句，别展开。`)
  if (strat.askQuestion === false) lines.push('这轮不要反问、不要追问。')
  if (strat.avoid && strat.avoid.length) lines.push('这轮不要：' + strat.avoid.join('、') + '。')
  if (situ.mode === 'needy') {
    lines.push('这一轮最重要的是让他觉得你在乎他；把嘴臭收一收，别用一句话把人顶回去。')
  }
  return lines.join('\n')
}

/** 打发式回复：把人一句话推开，等于没接。needy 场景下算越界 */
const DISMISSIVE_RE = /^(嗯|哦|行吧|哦行|知道了|随便|懒得|睡觉|睡了|不聊了)[。.!！…\s]*$/
/**
 * 「有温度的回复」应该有的东西：第一/第二人称、心意、动作、或者一句问话。
 * 他在要态度的时候，一条完全没有这些的短回复就是敷衍——
 * 昨晚「你都不说晚安」她回「晚安 / 行了，这下能睡了吧」，字面上"说了晚安"，实际等于打发。
 * 只在 needy 情境下用这条判据（正常收尾说一句晚安完全没问题，不拦）。
 */
const WARMTH_RE = /[我你咱]|想|在乎|喜欢|不是冲|抱|陪|哄|乖|别熬|早点睡|好梦|盖好|被子|明天|对不起|我的错|问|[?？]/
/** 只在这类短回复上判「敷衍」，长回复交给别的规则 */
const SHORT_REPLY_MAX = 26

function looksDismissive(t) {
  const bare = String(t || '')
    .replace(/[（(][^）)]{1,20}[）)]/g, '')
    .replace(/[\/／、，,。.!！…\s]+/g, '')
    .trim()
  if (!bare) return true
  if (bare.length > SHORT_REPLY_MAX) return false
  return !WARMTH_RE.test(bare)
}

/**
 * 检查回复有没有越界。返回 { ok, issues[] }
 * 只查硬伤，不管风格——风格交给模型。
 */
export function checkReply(reply, strat) {
  const t = String(reply || '').trim()
  if (!t) return { ok: false, issues: ['空回复'] }
  if (!strat) return { ok: true, issues: [] }
  const issues = []

  const sentences = t.split(/[。！？!?…\n]+/).filter((s) => s.trim())
  if (strat.maxSentences && sentences.length > strat.maxSentences + 1) {
    issues.push(`太长（${sentences.length} 句，上限 ${strat.maxSentences}）`)
  }

  // 【硬红线·对所有场合】赶人/威胁式的台词，一次都不许说
  if (detectThreat(t)) issues.push('在说威胁/赶人的话（「再叫我就装死」「别再发东西来了」这类）')

  if (strat.mode === 'closing') {
    if (strat.askQuestion === false && QUESTION_RE.test(t)) issues.push('收尾时还在反问')
    if (/(别走|再陪|等等|别急着走|就这么走了|再聊会儿|再待)/.test(t) && strat.tone === 'sleepy-soft') {
      issues.push('困着还在挽留')
    }
    if (/(再喊|就不理你|后果自负)/.test(t)) issues.push('收尾时在威胁')
  }
  if (strat.mode === 'apology') {
    if (/(你也有|都怪你|你才|明明是你|上次你)/.test(t)) issues.push('对方道歉了还在翻旧账')
  }
  if (strat.mode === 'comfort') {
    if (/(你应该|你得|为什么不|早说|谁让你)/.test(t)) issues.push('对方难受时在说教')
  }
  if (strat.mode === 'needy') {
    const bare = t.replace(/[（(][^）)]{1,20}[）)]/g, '').replace(/[\/／、]/g, ' ').replace(/\s+/g, ' ').trim()
    if (DISMISSIVE_RE.test(bare)) issues.push('他在要温度，你却一句话把人打发了')
    else if (looksDismissive(t)) issues.push('他在要温度，你这条里没有一句是给他的（等于敷衍）')
    if (/(你当我是什么|打卡签到机|确认个屁|要抱就抱|别拿这套磨我|睡不着就数羊)/.test(t)) issues.push('把他要的态度顶回去了')
    if (/(再|下次).{0,10}(叫|喊|发|吵|闹).{0,10}(就|我).{0,8}(装死|不理|不回)/.test(t)) issues.push('用威胁回应他的撒娇')
  }
  return { ok: issues.length === 0, issues }
}
