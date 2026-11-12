/**
 * lib/engine.mjs — 收消息 → 人设 → 回消息（归属：xingzhu）
 * ============================================================================
 * 职责边界：
 *   - 只处理 `post_type === 'message'` 的私聊/群聊消息；
 *   - 决定「要不要回」：私聊默认回，群聊默认只在被 @ 时回；
 *   - 回复走人设提示词（lib/persona），模型调用走 lib/llm，记录走 lib/store；
 *   - 限流防刷屏：同会话最短间隔、每分钟/每小时上限；重复 message_id 直接丢弃。
 * ============================================================================
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isPackable, packImagesToSheet } from './image-pack.mjs'
import { join } from 'node:path'
import { findNapcatImage } from './napcat-local.mjs'
import { generateText, normalizeUsage } from './llm.mjs'
import { mentionsSelf, parseCqMessage, segmentsToText } from './onebot.mjs'
import { cleanReply, parseSkip, pokePrompt, replyPrompt, systemPrompt } from './persona.mjs'
import { bodyPromptBlock, loadBody, bumpIntimacy, extractSignDirective, canChangeSign, markSignChanged } from './body.mjs'
import { streamPromptLine } from './daystream.mjs'
import { memePromptBlock } from './memewiki.mjs'
import { addWakes, addWakeAt, parseChineseWhen } from './selfwake.mjs'
import { detectCrisis, crisisPromptBlock, overloadPromptBlock, emotionalNeedReason, emotionalNeedPromptBlock, detectThreat, normalizeMoodDims } from './safety-valve.mjs'
import { extractStateMarker, setState, statePromptBlock } from './her-state.mjs'
import { curiosityPromptBlock, addCuriosity, scanCuriosity } from './curiosity.mjs'
import { intentPromptBlock, generateIntents, activeIntents, finishIntent } from './intent.mjs'
import { lifePromptBlock, scanMilestones } from './life.mjs'
import { reinterpretPromptBlock, reinterpretOne } from './reinterpret.mjs'
import { recordOwnerReply, sulkState, socialSnapshot } from './social.mjs'
import { selfStatePrompt, applyTune, proposeTune } from './selftune.mjs'
import { qzonePromptBlock, extractQzoneDirectives, likeFeed, commentFeed, replyFeed, deleteFeed, postQzone, fetchFeeds, refreshOwnerFeeds, fetchOwnComments, refreshCommentCache, formatCommentsBlock, cachedComments } from './qzone.mjs'
import { parsePokeEvent, pokeFallbackLine } from './poke.mjs'
import { saveStickerFromBuffer, saveStickerFromUrl, pickStickerByKeyword, stickerBase64, listStickers } from './stickers.mjs'
import { extractKeywords, searchRelated, recentNotes, renderRelated, renderNotes } from './memory.mjs'
import { promptBlock as memoryPromptBlock } from './memory-decay.mjs'
import { dayStateBlock } from './selfstate.mjs'
import { scrubPublic } from './privacy.mjs'
import { memoPromptBlock } from './memo.mjs'
import { notesPromptBlock } from './notes.mjs'
import { quotaSnapshot, quotaLine } from './quota.mjs'
import { searchMemories } from './memory-vector.mjs'
import { roomPromptBlock } from './room.mjs'
import { promptBlock as worldviewPromptBlock, learnFromReading } from './worldview.mjs'
import { collectInboundFiles } from './files.mjs'
import { currentWeather, weatherPromptBlock } from './weather.mjs'
import { runTool, parseToolCalls, stripToolCalls } from './agent-tools.mjs'
import { synthesizeBase64 } from './tts.mjs'
import { transcribe } from './asr.mjs'
import { loadStickerState, saveStickerState, canSendSticker, filterRecent, recordStickerSend } from './sc/sticker-state.mjs'
import { classifySticker } from './sc/sticker-mood.mjs'
import { stickerStatePath } from './sc/sticker-state.mjs'
import { searchAcrossGroups, renderCrossHits, wantsCrossSearch, appendAudit } from './cross-search.mjs'
import { atTargetsIn, detectAtRequest, findRepeat, fixAtTokens, rosterFromHistory } from './reply-guard.mjs'
import { bumpLearnCounter, factsBlock, learnNow, learnAcrossAll } from './learn.mjs'
import { bumpEvolveCounter, evolveNow, evolveAcrossAll, shouldEvolveNow, traitsBlock } from './persona-evolve.mjs'
import { evolveSchedule, loadSchedule, scheduleBlock, shouldEvolve } from './schedule.mjs'
import { detectEmotions, encodeText, cosine } from './sc/sticker-semantics.mjs'
import { maskUin, stampOf } from './redact.mjs'
import { splitIntoBubbles } from './bubbles.mjs'
// 【消息合并】移植自 AstrBot 的 astrbot_betterchat：私聊等她说完再回 + 生成期间排队
import { MergeWindow, PendingQueue, ReservationState, shouldIgnoreForMerge } from './merge-window.mjs'
import { appendMessage, bumpStats, loadConfig, loadSafety, recentMessages, stateHome } from './store.mjs'
import { looksLikeCorrection, recordCorrection, correctionPromptBlock } from './learn-from-correction.mjs'
import { looksLikeRefusal, recordRefusal, recordOwnerReaction, refusalPromptBlock } from './refusal.mjs'
import { distillPromptBlock } from './self-distill.mjs'
import { readMood, writeMood, renderMoodPrompt, reactToText, driftMood, syncAffect, wakeUp } from './vitals.mjs'
import { loadDiary, renderDiaryPrompt } from './sc/diary.mjs'
import { loadPromises, savePromises, addPromise, autoSettlePromises, settlePromisesByReply, detectPromise, renderPromisePrompt } from './sc/promise.mjs'
import { recordUsage } from './usage.mjs'
import { readSituation, strategyOf, situationPrompt, checkReply } from './eq.mjs'
import { noteInteraction, noteSpoke } from './organic.mjs'
import { looksLikeSearch, webSearch, formatResults } from './search.mjs'
import { loadSkills, skillsPromptBlock, detectSkillCall, runSkill } from './skills.mjs'
import { injectionText as dayplanInjection } from './dayplan.mjs'
import { readBody, bodyPromptBlock as bodySenseBlock } from './body-sense.mjs'
import { tickNeeds, needsPromptBlock } from './needs.mjs'

/** 识图诊断日志：写到 $DSH_HOME/qq-fish/image-debug.log，方便排查「图没进来」 */
function imageDebug(line) {
  try {
    appendFileSync(join(stateHome(), 'image-debug.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {}
}

// ── 拟真（像真人用 QQ）：打字延迟 + 分条气泡 + 随机抖动 ────────────────
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/** 区间随机整数（带兜底范围） */
function randInt(min, max, dMin = 300, dMax = 3000) {
  let lo = Number(min)
  let hi = Number(max)
  if (!Number.isFinite(lo)) lo = dMin
  if (!Number.isFinite(hi)) hi = dMax
  if (hi < lo) [lo, hi] = [hi, lo]
  return Math.round(lo + Math.random() * (hi - lo))
}

/** 按字数估算「打字」耗时（含 ±20% 抖动），真人不会精确秒回 */
function typingDelay(text, config) {
  const per = Number(config && config.typingPerCharMs) || 90
  const cap = Number(config && config.typingMaxMs) || 6000
  const len = String(text || '').length
  const base = Math.min(cap, Math.max(300, len * per))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/**
 * 把长回复拆成多条气泡（真人很少一口气发一大段）。
 * 太短不拆；按句读切，再均匀合并到最多 splitMaxBubbles 条。
 */
/**
 * 按生理状态决定「这一轮切成几条发」。
 * 累了/烦了少说；黏人+孤独多说；气到极点一个字。
 */
export function targetBubbles(v) {
  if (!v) return 2
  let n = 2
  if (Number(v.irritability) > 0.62) n -= 1
  if (Number(v.energy) < 0.30) n -= 1
  if (Number(v.adenosine) > 0.75) n -= 1
  if (Number(v.clinginess) > 0.70 && Number(v.loneliness) > 0.45) n += 1
  if (Number(v.energy) > 0.72 && Number(v.valence) > 0.58) n += 1
  if (Number(v.anger) > 0.70) n = 1
  return Math.max(1, Math.min(4, n))
}

export { splitIntoBubbles }

/** 当前本地时间是否处在「深夜静默」区间（start === end 视为关闭） */
export function inNightSilence(config, now = new Date()) {
  if (!config) return false
  let start = Number(config.nightSilenceStart)
  let end = Number(config.nightSilenceEnd)
  if (config.silenceFollowSchedule !== false) {
    try {
      const sch = loadSchedule()
      const sleep = Number(sch.sleepHour)
      const wake = Number(sch.wakeHour)
      if (Number.isFinite(sleep) && Number.isFinite(wake) && sleep !== wake) { start = sleep; end = wake }
    } catch {}
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
  const hour = now.getHours()
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/**
 * 半夜起床气的分级（纯函数，方便单测/离线验证）。
 * ============================================================================
 * 设计原则：先软后硬，而且区分对象。
 *   · 第 1 次：就是困。允许嘟囔、抱怨，但**必须带温度**，不许骂人、不许发火、不许说装死。
 *   · 第 2 次：可以不耐烦，语气冲一点，但不许威胁、不许赶人。
 *   · 第 3 次以后：才允许发火——外人可以骂两句；
 *     主人（ownerQq / accessAdminId）永远只用「嘴上凶 + 说心里话」，不许骂、不许威胁、不许赶人。
 * 为什么对主人更软：主人半夜来找，多半是搬家、加班、睡不着想找人说句话，
 * 跟陌生人半夜刷屏是两回事。把他当成骚扰来骂，就是昨晚那场事故。
 * ============================================================================
 * @param {number} nth 窗口内第几次
 * @param {boolean} owner 是不是主人（config.ownerQq / accessAdminId）
 * @returns {{tier:string, angry:boolean, block:string}}
 */
export function nightWakeTier(nth, owner) {
  const n = Math.max(1, Math.trunc(Number(nth) || 1))
  const isOwner = owner === true
  if (n <= 1) {
    const block = isOwner
      ? '【半夜被叫醒】你刚睡着就被他叫醒（第 1 次），脑子还糊、身上还发沉。\n' +
        '这一轮只是「困 + 嘟囔」：\n' +
        '- 可以抱怨一句（「刚眯着又让你戳醒」「这个点…你还没睡啊」），但抱怨得带着温度。\n' +
        '- 他要是说在忙、在搬家、在赶东西，就先问一句他那边怎么样了——他半夜找你，是有事，不是来闹你的。\n' +
        '- 说困可以，但别用困把人推开；真撑不住了就说「我还在，就是脑子不转」。\n' +
        '- 语气放软，别凶他：他半夜还愿意找你说话，这件事本身值得你温柔一点。'
      : '【半夜被叫醒】你刚睡着就被叫醒（第 1 次），脑子还糊，带着起床气：先嘟囔一句再回答，语气别冲。'
    return { tier: '困+嘟囔', angry: false, block }
  }
  if (n === 2) {
    const block = isOwner
      ? '【半夜被叫醒】他这一轮里第二次把你叫醒了（第 2 次），你开始有点不耐烦——语气可以冲，可以损他两句。\n' +
        '但不许威胁、不许赶人；不耐烦要落在「你怎么还不睡」上，不是「你别烦我」。'
      : '【半夜被叫醒】你第二次被半夜叫醒，开始不耐烦了：语气冲一点，可以损两句，但不许威胁、不许赶人。'
    return { tier: '不耐烦', angry: false, block }
  }
  const block = isOwner
    ? '【半夜被叫醒】这是他这一轮里第 ' + n + ' 次把你弄醒了。你可以真气，也可以嘴上凶——\n' +
      '但**到此为止**：可以凶他两句、可以说他烦，不许赶他走，也不许说任何「以后别找我」的话。\n' +
      '凶完之后要说一句心里话（「我不是烦你，我是真困成狗了」「你倒是睡啊，我陪着你也行」）——' +
      '你可以烦「被吵醒」这件事，不能烦他这个人。'
    : '【半夜被叫醒】同一个人这一轮里第 ' + n + ' 次半夜吵醒你，可以发火了：说他两句、让他别再叫；但别骂家里人，也别拿隐私说事。'
  return { tier: '发火', angry: true, block }
}

/** 起床气计数窗口：30 分钟。原来 10 分钟太短，正常聊天会被算成骚扰。 */
export const NIGHT_WAKE_WINDOW_MS = 30 * 60 * 1000
/**
 * 同一个「叫醒回合」的判定：距上一条不足 8 分钟 = 还在这一轮对话里，不算新的叫醒。
 * 超过 8 分钟没动静、又突然来一条，才算「又把你弄醒一次」。
 */
export const NIGHT_WAKE_EPISODE_MS = 8 * 60 * 1000

/** 会话 key：private:<uin> / group:<gid> */
export function conversationKey(channel, id) {
  return `${channel}:${id}`
}

function senderNameOf(sender) {
  if (!sender || typeof sender !== 'object') return '对方'
  return String(sender.card || sender.nickname || sender.user_id || '对方').slice(0, 40)
}

/** 把 OneBot 事件规整成内部消息记录 */
export function normalizeEvent(event, selfId) {
  if (!event || event.post_type !== 'message') return null
  const channel = event.message_type === 'group' ? 'group' : 'private'
  const userId = String(event.user_id || (event.sender && event.sender.user_id) || '')
  const groupId = channel === 'group' ? String(event.group_id || '') : ''
  if (!userId) return null
  // 自己的消息不回
  if (selfId && userId === String(selfId)) return null

  // message 段：array 格式直接用；string 格式（CQ 码）解析成段。
  // 注意 raw_message 在两种格式下都可能是 CQ 码串，不能直接当文本展示。
  let segments = Array.isArray(event.message) ? event.message : []
  let quoted = ''
  if (!segments.length) {
    const rawMessage = typeof event.message === 'string' ? event.message : String(event.raw_message || '')
    if (rawMessage.includes('[CQ:')) {
      const parsed = parseCqMessage(rawMessage)
      segments = parsed.segments
      quoted = parsed.quotedId
    }
  }
  const text = segments.length
    ? segmentsToText(segments).replace(/ {2,}/g, ' ').trim()
    : String(typeof event.message === 'string' ? event.message : event.raw_message || '').trim()
  for (const seg of segments) {
    if (seg && seg.type === 'reply' && seg.data && seg.data.id) quoted = String(seg.data.id)
  }

  // 【语音】记下文件，稍后由 ASR 异步识别（normalizeEvent 是同步的，不能 await）
  let voiceFile = ''
  for (const seg of segments) {
    if (seg && seg.type === 'record' && seg.data && seg.data.file) { voiceFile = String(seg.data.file); break }
  }

  // 时间戳：QQ 事件里的 time 是秒级（且可能和本机时钟有偏差，实测有 2~3 秒“未来”）。
  // 把它钳到本机时间以内，否则回复（本机 Date.now）会比它“更早”，面板按时间排序时
  // 回复会排到消息前面。延迟投递的事件保留原始时间。
  const eventTs = Number(event.time ? event.time * 1000 : 0)
  const now = Date.now()
  const ts = eventTs > 0 ? Math.min(eventTs, now) : now

  return {
    ts,
    messageId: String(event.message_id ?? ''),
    channel,
    groupId,
    userId,
    uin: channel === 'group' ? groupId : userId,
    who: senderNameOf(event.sender),
    selfId: String(selfId || event.self_id || ''),
    text,
    quoted,
    voiceFile,
    segments,
  }
}

/** 回复节流：同会话 4 秒一条、每分钟 8 条、每小时 120 条（够日常聊天，又不至于刷屏） */
class RateLimiter {
  constructor() {
    this.lastByConversation = new Map()
    this.minuteWindow = []
    this.hourWindow = []
  }
  allow(key) {
    const now = Date.now()
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000)
    this.hourWindow = this.hourWindow.filter((t) => now - t < 3_600_000)
    if (this.minuteWindow.length >= 8) return { ok: false, reason: '每分钟回复上限（8 条）' }
    if (this.hourWindow.length >= 120) return { ok: false, reason: '每小时回复上限（120 条）' }
    const last = this.lastByConversation.get(key) || 0
    if (now - last < 4000) return { ok: false, reason: '同一会话 4 秒内只回一条' }
    this.minuteWindow.push(now)
    this.hourWindow.push(now)
    this.lastByConversation.set(key, now)
    return { ok: true }
  }
}

export class ChatEngine {
  /**
   * @param {object} options { ctx, getBridge, getConfig, log }
   */
  constructor(options) {
    this.ctx = options.ctx
    this.getBridge = options.getBridge
    this.getConfig = options.getConfig || loadConfig
    this.log = options.log || console
    this.limiter = new RateLimiter()
    this.seen = new Set()
    this.busy = new Set()
    /** 群聊接话节奏：groupId -> 上次接话时间 / 最近一小时接话时间列表 */
    this.groupLastReplyAt = new Map()
    this.groupReplyTimes = new Map()
    /** 正在做「要不要插话」判断的群（同一个群同时只判断一条，防堆积） */
    this.groupJudging = new Set()
    /** 私聊合并窗口（等她说完再回）；参数每轮从 config 热更新 */
    this.mergeWindow = new MergeWindow({ log: this.log })
    /** 生成期间收到的消息排队，这一轮结束后合并成一条再跑 */
    this.pendingQueue = new PendingQueue({ log: this.log })
  }

  /** 新旧字段统一解析群聊接话方式：mention / smart / all */
  groupReplyModeOf(config) {
    const mode = config && config.groupReplyMode
    if (mode === 'mention' || mode === 'smart' || mode === 'all') return mode
    return config && config.autoReplyGroups ? 'all' : 'mention'
  }

  /** 把「逗号/换行分隔的 ID 串」拆成干净的 ID 数组 */
  idListOf(text) {
    return String(text || '')
      .split(/[,，;；\s\n\r]+/)
      .map((x) => String(x).replace(/\D/g, ''))
      .filter((x) => x.length >= 5 && x.length <= 12)
      .slice(0, 100)
  }

  /**
   * 访问控制：管理员永远放行；开了白名单就只理名单内会话；
   * 陌生人私聊可以单独关掉。
   */
  accessCheck(msg, config) {
    const userId = String((msg && msg.userId) || '')
    const groupId = String((msg && msg.groupId) || '')
    // 管理员只认一个；旧的多值字段只取第一个兜底
    const adminId = String((config && config.accessAdminId) || '').replace(/\D/g, '') ||
      this.idListOf(config && config.accessAdminIds)[0] || ''
    const isAdmin = !!userId && !!adminId && userId === adminId
    if (isAdmin) return { ok: true, isAdmin: true }
    // 私聊：关掉「允许他人私聊」后，除了管理员谁都不理（白名单也不行）
    if (!groupId && config && config.accessAllowStrangerPrivate === false) {
      return { ok: false, isAdmin: false, reason: '私聊只对管理员开放' }
    }
    const whitelist = this.idListOf(config && config.accessWhitelist)
    const convId = groupId || userId
    const listed = (convId && whitelist.includes(convId)) || (userId && whitelist.includes(userId))
    if (config && config.accessWhitelistEnabled === true && !listed) {
      return { ok: false, isAdmin: false, reason: '不在白名单' }
    }
    return { ok: true, isAdmin: false }
  }

  /**
   * 群聊/私信互通：把「同一个人」在另一个会话里的话带进上下文。
   * 不走死窗口：跟记忆模块一样按关键词相关度 + 时间衰减排序，取最近 30 天里最相关的几条。
   */
  crossConversationBlock(msg, conversation) {
    if (!msg || !msg.userId) return ''
    let rows = []
    try {
      rows = recentMessages(3000)
    } catch {
      return ''
    }
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000
    // 群↔群 / 群↔私聊 都互通：找【同一个人】在别的会话里说过的话
    const userId = String(msg.userId || '')
    const sameUser = (r) => {
      if (!userId) return false
      const sender = String(r.senderId || '')
      const uin = String(r.uin || '')
      // 他本人在别的群的发言
      if (r.channel === 'group' && sender === userId && r.conversation !== conversation) return true
      // 他本人的私聊发言
      if (r.channel === 'private' && uin === userId) return true
      return false
    }
    const candidates = rows.filter(
      (r) => r && r.ts >= cutoff && r.text && String(r.text).length >= 2 && r.conversation !== conversation && sameUser(r),
    )
    if (!candidates.length) return ''
    // 相关度：命中当前消息的关键词越多越靠前；再看新鲜度
    const kws = extractKeywords(String(msg.text || ''), 16).filter((k) => k.length >= 2)
    const now = Date.now()
    const scored = candidates.map((r) => {
      const text = String(r.text)
      let hits = 0
      for (const k of kws) if (text.includes(k)) hits += 1
      const ageHours = Math.max(0, now - (Number(r.ts) || now)) / 3600000
      const score = hits * 2 + Math.max(0, 3 - ageHours / 24) // 关键词优先，一天内最多 +3
      return { r, score, hits }
    })
    // 一个关键词都没命中时只取最近 3 条，别硬塞 8 条不相干的旧话
    const anyHit = scored.some((x) => x.hits > 0)
    const take = anyHit ? 8 : 3
    scored.sort((a, b) => b.score - a.score || (Number(b.r.ts) || 0) - (Number(a.r.ts) || 0))
    const picked = scored.slice(0, take).map((x) => x.r).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    // 同一个 QQ 换过昵称：块里统一显示它最近用的名字，别让她以为是两个人
    const nameByQq = new Map()
    for (const r of [...rows].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))) {
      const qq = String(r.senderId || '')
      const name = String(r.who || '').trim()
      if (qq && name && r.direction !== 'out') nameByQq.set(qq, name)
    }
    const pad = (n) => String(n).padStart(2, '0')
    const line = (r) => {
      const d = new Date(Number(r.ts) || Date.now())
      const who = r.direction === 'out' ? '你' : (nameByQq.get(String(r.senderId || '')) || String(r.who || '对方')).slice(0, 20)
      const text = String(r.text || '').replace(/\s+/g, ' ').slice(0, 120)
      if (!text) return ''
      // 跨天要带日期，否则她会以为是今天说的
      const day = `${d.getMonth() + 1}/${d.getDate()}`
      return `- ${day} ${pad(d.getHours())}:${pad(d.getMinutes())} ${who}：${text}`
    }
    const lines = picked.map(line).filter(Boolean)
    if (!lines.length) return ''
    if (msg.channel === 'group') {
      return '【同一个人在其他会话说过】（他本人在私聊或其他群里说的；可以自然接着聊，但别当着群里的人复述私密内容；旧事别硬扯，只提跟这句话有关的）\n' + lines.join('\n')
    }
    return '【他在群里说过】（同一个人，在群里说的话；自然带出来就行，别生硬地说「你在群里说过」；只提跟这句话有关的）\n' + lines.join('\n')
  }

  /** 她的叫法清单：正式名字 + 用户填的别名 */
  nameAliasesOf(config) {
    const base = String((config && config.personaName) || '').trim()
    const extra = String((config && config.nameCallAliases) || '')
      .split(/[,，;；\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    return [...new Set([base, ...extra].filter(Boolean))].slice(0, 10)
  }

  /** 说话的人是不是主人 */
  isOwnerSender(msg, config) {
    const owner = String((config && config.ownerQq) || '').replace(/\D/g, '')
    if (!owner) return true // 没设主人号就退化成「都算」，不破坏原有行为
    const sid = String((msg && (msg.senderId || msg.uin || msg.userId)) || '').replace(/\D/g, '')
    return !!sid && sid === owner
  }

  /** 这条群消息是不是在叫她（叫名字 = 点名，不用非得 @） */
  isCalledByName(text, aliases, opts = {}) {
    const raw = String(text || '')
    if (!raw) return false
    const base = String(opts.baseName || '').trim()
    const ownerOnly = opts.ownerOnly !== false
    const senderIsOwner = opts.senderIsOwner !== false
    return aliases.some((name) => {
      if (name.length < 2 || !raw.includes(name)) return false
      // 正式名字谁叫都算；昵称别名只有主人能叫
      if (ownerOnly && base && name !== base && !senderIsOwner) return false
      return true
    })
  }

  /** 解析兴趣关键词（逗号/分号/换行分隔） */
  groupKeywordsOf(config) {
    return String((config && config.groupKeywords) || '')
      .split(/[,，;；\n\r]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 80)
  }

  /** 群聊接话节奏检查：最短间隔 + 每小时上限 */
  groupPaceCheck(groupId, config, now = Date.now()) {
    const key = String(groupId || '')
    const minGapSec = Math.max(10, Number((config && config.groupMinIntervalSec) || 120))
    const last = this.groupLastReplyAt.get(key) || 0
    if (last && now - last < minGapSec * 1000) {
      return { ok: false, reason: `群内最短间隔 ${minGapSec}s` }
    }
    const maxPerHour = Math.max(0, Math.trunc(Number((config && config.groupMaxPerHour) || 0)))
    if (maxPerHour === 0) return { ok: false, reason: '群内每小时上限为 0' }
    const times = (this.groupReplyTimes.get(key) || []).filter((t) => now - t < 3_600_000)
    if (times.length >= maxPerHour) return { ok: false, reason: `群内每小时上限 ${maxPerHour}` }
    return { ok: true }
  }

  /** 记一次群内接话（用于间隔与每小时上限） */
  markGroupReplied(groupId) {
    const now = Date.now()
    const key = String(groupId || '')
    this.groupLastReplyAt.set(key, now)
    const times = (this.groupReplyTimes.get(groupId) || []).filter((t) => now - t < 3_600_000)
    times.push(now)
    this.groupReplyTimes.set(key, times)
  }

  /** OneBot 事件入口 */
  async handle(event) {
    // 安全闸门：没完成风险确认（用小号/知情同意）之前，不记录也不自动回复任何消息
    if (!loadSafety().acknowledged) return
    const config = this.getConfig()
    const bridge = this.getBridge()
    const selfId = (bridge && bridge.selfId) || (event && event.self_id) || ''
    // 【戳一戳】它不是消息事件：被戳的是她 → 按人设回一句（要不要回戳看配置）
    const poke = parsePokeEvent(event)
    if (poke) {
      const self = String(selfId || poke.selfId || '')
      if (self && String(poke.targetId) === self) {
        this.poke(poke, config).catch((e) => this.log.warn('戳一戳回复失败：' + String((e && e.message) || e)))
      }
      return
    }
    const msg = normalizeEvent(event, selfId)
    if (!msg) return
    if (this.seen.has(msg.messageId)) return
    // 【访问控制】白名单 / 陌生人私聊：被拦下的消息不记录、不进上下文
    const access = this.accessCheck(msg, config)
    if (!access.ok) {
      if (!config || config.accessBlockLog !== false) {
        this.log.info(`访问拦截（${access.reason}）：${msg.channel}:${maskUin(msg.uin)} 用户 ${maskUin(msg.userId)}`)
      }
      return
    }
    this.seen.add(msg.messageId)
    this.trimSeen()
    // 【语音识别】别人发的语音先转成文字，她才听得懂
    // 本地 SenseVoice（provider=local）不需要 API Key，所以判定要放行这种情况
    if (msg.voiceFile && config && config.asrEnabled && (config.asrApiKey || config.asrProvider === 'local')) {
      msg.text = await this.recognizeVoice(msg.voiceFile, msg.text, config)
    }
    // 【自主学习】每条入站消息都记一笔，攒够 autoLearnEvery 条就异步整理一次（不阻塞回复）
    this.maybeLearn(msg, config)

    if (msg.channel !== 'group') {
      this.processInbound(msg, config, { atMe: false })
      return
    }

    // 【群聊静音期】config.groupMuteUntil 是毫秒时间戳；到点自动恢复，不用再改回来
    try {
      const muteUntil = Number((config && config.groupMuteUntil) || 0)
      if (muteUntil && Date.now() < muteUntil) {
        this.log.info('[群] 静音期，跳过：' + String((msg && msg.text) || '').slice(0, 16))
        return
      }
    } catch {}

    const atMe = mentionsSelf(msg.segments, selfId)
    if (atMe) {
      // 被 @ / 点名：照常回（不再受「候选接话」的兴趣判断限制）
      this.processInbound(msg, config, { atMe: true })
      return
    }
    // 【响应等级 0-100】决定群聊里接话的积极程度
    //   0-20  : 只回 @ / 叫名字
    //   21-45 : + 关键词命中（问题、叫她的词）
    //   46-70 : 走「要不要插话」的模型判断（默认）
    //   71-100: 几乎都接（随机放行概率随等级升高）
    try {
      const lvl = Math.min(100, Math.max(0, Number(config.replyLevel ?? 50)))
      if (!atMe) {
        const nm = this.nameAliasesOf(config).filter((n) => n.length >= 2)
        const called = nm.some((n) => String(msg.text || '').includes(n))
        if (lvl <= 20 && !called) {
          this.log.info('[等级] ' + lvl + '：没 @ 没叫名字，跳过')
          return
        }
        if (lvl <= 45 && !called) {
          const kw = String(config.groupKeywords || '').split(/[,，;；\s]+/).filter(Boolean)
          const hit = kw.some((k) => String(msg.text || '').includes(k))
          if (!hit && !/[？?]/.test(String(msg.text || ''))) {
            this.log.info('[等级] ' + lvl + '：没关键词，跳过')
            return
          }
        }
        if (lvl >= 71) {
          const p = (lvl - 70) / 100   // 71-100 -> 1%~30% 直接放行
          if (Math.random() < p) this.log.info('[等级] ' + lvl + '：随机放行')
        }
      }
    } catch {}

    // 【参与风格】quiet：只有被 @ / 叫名字才理，其余一律不接（省得在群里刷存在感）
    const gStyle = String(config.groupStyle || 'normal')
    if (gStyle === 'quiet' && !atMe && !config._quietChecked) {
      const nm = this.nameAliasesOf(config).filter((n) => n.length >= 2)
      const called = nm.some((n) => String(msg.text || '').includes(n))
      if (!called) {
        this.log.info('[风格] quiet：没点名，跳过')
        return
      }
    }
    // 【叫名字】群里直接喊她的名字 = 点名，跳过「要不要插话」那套判断；
    // 但仍然过群内节奏（最短间隔/每小时上限），免得她满群乱接话。
    if (config.nameCallReply !== false) {
      const aliases = this.nameAliasesOf(config)
      if (this.isCalledByName(msg.text, aliases, {
        baseName: config.personaName,
        ownerOnly: config.nameCallOwnerOnly !== false,
        senderIsOwner: this.isOwnerSender(msg, config),
      })) {
        const pace = this.groupPaceCheck(msg.groupId, config)
        if (!pace.ok) {
          this.log.info(`被叫名字但跳过（${pace.reason}）：群 ${maskUin(msg.groupId)}`)
          return
        }
        this.log.info(`群里被叫名字，直接接话：${String(msg.who || '')}`)
        this.processInbound(msg, config, { atMe: true })
        return
      }
    }
    const mode = this.groupReplyModeOf(config)
    if (mode === 'mention') return
    // smart / all：异步判断要不要接这句；不阻塞消息事件循环
    this.considerGroupMessage(msg, config, mode).catch((e) =>
      this.log.warn('群聊接话判断失败：' + String((e && e.message) || e)),
    )
  }

  trimSeen() {
    if (this.seen.size <= 2000) return
    let drop = 1000
    for (const id of this.seen) {
      this.seen.delete(id)
      if (--drop <= 0) break
    }
  }

  /** 记录入站消息（按需）+ 触发自动回复 */
  /** 这个人在黑名单里吗（他说的话一律不处理） */
  isBlacklisted(msg, config) {
    try {
      const raw = String((config && config.blacklist) || '')
      if (!raw) return false
      const ids = raw.split(/[,，;；\s]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 5)
      if (!ids.length) return false
      const sid = String((msg && (msg.senderId || msg.uin || msg.userId)) || '').replace(/\D/g, '')
      return !!sid && ids.includes(sid)
    } catch {
      return false
    }
  }

  processInbound(msg, config, options = {}) {
    // 【延迟诊断】收到时刻（epoch ms）：和「开始发送」那条配对就能算出卡在哪一步
    this._lastInboundAt = Date.now()
    try { this.log.info('[延迟] 收到 ' + conversationKey(msg.channel, msg.uin) + ' @' + this._lastInboundAt) } catch {}
    // 【黑名单】被拉黑的人：不回复、不进记忆、不触发任何行为
    if (this.isBlacklisted(msg, config)) {
      this.log.info('[黑名单] 忽略一条消息')
      return
    }
    // 诊断：把每条入站消息的段结构记下来，排查「引用/图片为什么看不到」
    try {
      const segTypes = (Array.isArray(msg.segments) ? msg.segments : []).map((s) => (s && s.type) || '?')
      imageDebug(
        `入站 ${msg.channel}:${msg.uin} segs=[${segTypes.join(',')}] msgId=${msg.messageId || '(空)'} quoted=${msg.quoted || '(空)'} text=${String(msg.text || '').slice(0, 60)}`,
      )
    } catch {}
    const record = {
      ts: msg.ts,
      direction: 'in',
      channel: msg.channel,
      conversation: conversationKey(msg.channel, msg.uin),
      uin: msg.uin,
      who: msg.who,
      senderId: msg.userId || '',
      text: msg.text,
      messageId: msg.messageId,
      selfId: msg.selfId,
      quoted: msg.quoted || '',
      atMe: !!options.atMe,
    }
    if (!options.skipRecord) {
      appendMessage(record)
      bumpStats('received')
    }

    if (!config.autoReply) return
    // 深夜静默：非 @ 的消息不接（@ 仍然回，真人被点名也会醒）
    if (!options.atMe && msg.channel === "group" && inNightSilence(config)) {
      this.log.info(`深夜静默（${config.nightSilenceStart}:00-${config.nightSilenceEnd}:00），不回：${maskUin(msg.uin)}`)
      return
    }
    // 群聊里「非 @ 的候选接话」还要过一次节奏检查；@ 回复不拦
    if (msg.channel === 'group' && !options.atMe) {
      const pace = this.groupPaceCheck(msg.groupId, config)
      if (!pace.ok) {
        this.log.info(`跳过接话（${pace.reason}）：群 ${maskUin(msg.groupId)}`)
        return
      }
    }
    const key = record.conversation
    // 【生成期间排队】原来这里是 `if (this.busy.has(key)) return`，
    // 什么都不记就把消息丢了 —— 用户连发几句时后面全被吞掉，
    // 体感就是「她看不到我发的消息」。现在改成压进队列，
    // 本轮 reply() 结束后合并成一条新输入再跑一轮。
    if (this.busy.has(key)) {
      const n = this.pendingQueue.push(key, { msg, config, atMe: !!options.atMe })
      this.log.info(`[排队] 正在生成，压入队列（${n} 条）：${maskUin(msg.uin)} ${String(msg.text || '').slice(0, 24)}`)
      return
    }
    const gate = this.limiter.allow(key)
    if (!gate.ok) {
      this.log.info(`跳过回复（${gate.reason}）：${maskUin(msg.uin)}`)
      return
    }
    // 【私聊合并】等她说完再回：连续打字时先不调模型，静默窗口到期后
    // 把整串消息合并成一条输入。指令类（/ 开头）不参与合并，立刻处理。
    // 群聊 @ 消息不合并（被点名就该马上应）。
    const isPrivate = msg.channel !== 'group'
    const mergeOn = isPrivate && config.mergeMessages !== false && !shouldIgnoreForMerge(msg.text, {
      ignorePrefixes: String(config.mergeIgnorePrefixes || '/,!').split(',').map((s) => s.trim()).filter(Boolean),
    })
    if (mergeOn) {
      this.runMergedReply(key, msg, config).catch((e) => this.log.error('合并回复失败：' + String((e && e.message) || e)))
      return
    }
    this.busy.add(key)
    this.reply(msg, config)
      .catch((e) => this.log.error('回复失败：' + String((e && e.message) || e)))
      .finally(() => this.drainPending(key))
  }

  /**
   * 私聊合并回复：登记 → 等静默窗口 → 结算 → 回复。
   *
   * 同一会话里连续来 N 条时：
   *   - 第 1 条成为主人，等待；
   *   - 第 2、3 条到达，各自 reserve() 顶掉主人并唤醒旧等待者；
   *   - 旧等待者醒来发现 ownerTicket 变了 → SUPERSEDED，静默退出；
   *   - 最后一个 ticket 的等待者到期后 settle()，拿到合并文本，回复一次。
   *
   * 这样同一轮只回一次，不会重复、不会互相打断，也不会再丢消息。
   */
  async runMergedReply(key, msg, config) {
    const settings = {
      enable: config.mergeMessages !== false,
      baseQuietSeconds: Number(config.mergeBaseQuietSeconds ?? 2.0),
      minQuietSeconds: Number(config.mergeMinQuietSeconds ?? 1.5),
      maxQuietSeconds: Number(config.mergeMaxQuietSeconds ?? 4.0),
      totalSeconds: Number(config.mergeTotalSeconds ?? 8.0),
      lengthScaleChars: Number(config.mergeLengthScaleChars ?? 60),
      maxMessages: Number(config.mergeMaxMessages ?? 8),
      maxChars: Number(config.mergeMaxChars ?? 4000),
      ignorePrefixes: String(config.mergeIgnorePrefixes || '/,!').split(',').map((s) => s.trim()).filter(Boolean),
    }
    this.mergeWindow.configure(settings)

    const reservation = this.mergeWindow.reserve(key)
    this.mergeWindow.append(key, msg.text)

    const state = await this.mergeWindow.waitForQuiet(key, reservation)

    if (state === ReservationState.SUPERSEDED) {
      // 后面还有消息，交给更新的那一位收口
      return
    }
    if (state === ReservationState.BYPASS) {
      // 窗口被关闭 / 被 prune：退回普通路径，别把消息丢了
      if (!this.busy.has(key)) {
        this.busy.add(key)
        this.reply(msg, config)
          .catch((e) => this.log.error('回复失败：' + String((e && e.message) || e)))
          .finally(() => this.drainPending(key))
      }
      return
    }

    const settled = this.mergeWindow.settle(key, reservation)
    if (!settled) return // 不是我收口，静默退出

    // 合并成一条输入：文本用 \n 连接，模型能看出是分几次说的
    const merged = settled.text
    if (!merged) return
    if (settled.count > 1) {
      this.log.info(`[合并] ${settled.count} 条合成 1 条（${merged.length} 字）：${maskUin(msg.uin)}`)
    }

    const mergedMsg = { ...msg, text: merged, mergedCount: settled.count }
    // 合并了多条时，被引用的那条取「最后一条带引用的」，否则沿用第一条的
    if (!mergedMsg.quoted && msg.quoted) mergedMsg.quoted = msg.quoted

    if (this.busy.has(key)) {
      this.pendingQueue.push(key, { msg: mergedMsg, config, atMe: false })
      return
    }
    this.busy.add(key)
    await this.reply(mergedMsg, config)
      .catch((e) => this.log.error('回复失败：' + String((e && e.message) || e)))
      .finally(() => this.drainPending(key))
  }

  /**
   * 本轮回复结束后，把排队期间收到的消息合并成一条再跑一轮。
   * 递归时用 setImmediate 让出事件循环，避免长链阻塞。
   */
  drainPending(key) {
    this.busy.delete(key)
    const queued = this.pendingQueue.drain(key)
    if (!queued.length) return
    // 取最后一条当模板（会话/群号/selfId 都一样，用最新的更准），文本全部合并
    const last = queued[queued.length - 1]
    const texts = queued.map((q) => String((q.msg && q.msg.text) || '').trim()).filter(Boolean)
    if (!texts.length) return
    const merged = texts.join('\n')
    const mergedMsg = { ...last.msg, text: merged, mergedCount: texts.length }
    // 排队里若有引用，取最新那条的引用，别丢
    const withQuote = [...queued].reverse().find((q) => q.msg && q.msg.quoted)
    if (withQuote) mergedMsg.quoted = withQuote.msg.quoted
    this.log.info(`[排队] 本轮结束，接着处理排队的 ${texts.length} 条（${merged.length} 字）`)
    setImmediate(() => {
      if (this.busy.has(key)) {
        // 又被占了，继续排队
        this.pendingQueue.push(key, { msg: mergedMsg, config: last.config, atMe: false })
        return
      }
      this.busy.add(key)
      this.reply(mergedMsg, last.config)
        .catch((e) => this.log.error('回复失败（排队）：' + String((e && e.message) || e)))
        .finally(() => this.drainPending(key))
    })
  }

  /** 群聊非 @ 消息：按「概率 → 关键词 → 模型判断 → 频率」决定要不要接 */
  async considerGroupMessage(msg, config, mode) {
    // 先记录所有群消息，保证被 @ 时能接上文（否则不插话的消息会不进上下文）
    try {
      appendMessage({
        ts: msg.ts,
        direction: 'in',
        channel: msg.channel,
        conversation: conversationKey(msg.channel, msg.uin),
        uin: msg.uin,
        who: msg.who,
        senderId: msg.userId || '',
        text: msg.text,
        messageId: msg.messageId,
        selfId: msg.selfId,
        quoted: msg.quoted || '',
        atMe: false,
      })
      bumpStats('received')
    } catch (e) {
      this.log.warn('记录群消息失败：' + String((e && e.message) || e))
    }
    // 群里的图：先存成视觉输入缓存，被 @ 时带上（否则她只能看到「[图片]」两个字）
    try {
      const hasImg = Array.isArray(msg.segments) && msg.segments.some((x) => x && x.type === 'image')
      if (hasImg && config.imageView) {
        const bridge2 = this.getBridge()
        const imgs = await this.collectImages(msg, config, bridge2)
        if (imgs && imgs.length) {
          if (!this.recentImageRefs) this.recentImageRefs = new Map()
          this.recentImageRefs.set(conversationKey(msg.channel, msg.uin) + '|' + (msg.messageId || Date.now()), { ts: Date.now(), images: imgs })
          if (this.recentImageRefs.size > 20) {
            const first = this.recentImageRefs.keys().next().value
            this.recentImageRefs.delete(first)
          }
        }
      }
    } catch (e2) {
      this.log.warn('群图片缓存失败：' + String((e2 && e2.message) || e2))
    }
    // 【合并转发】群里别人发的转发卡片常常单独一条；先读出来缓存，等被 @ 时带上
    try {
      const hasForward = Array.isArray(msg.segments) && msg.segments.some((x) => x && x.type === 'forward')
      if (hasForward) {
        const fwd = await this.collectForwardText(this.getBridge(), msg, config)
        if (fwd.text || fwd.images.length) {
          if (!this.recentForwardRefs) this.recentForwardRefs = new Map()
          const fkey = conversationKey(msg.channel, msg.uin)
          this.recentForwardRefs.set(fkey, { ts: Date.now(), who: msg.who, text: fwd.text, images: fwd.images })
          while (this.recentForwardRefs.size > 10) {
            const first = this.recentForwardRefs.keys().next().value
            this.recentForwardRefs.delete(first)
          }
          imageDebug('转发已缓存：' + fkey + ' 来自 ' + msg.who + ' / ' + fwd.text.length + ' 字符')
        }
      }
    } catch (e) {
      this.log.warn('缓存群里的合并转发失败：' + ((e && e.message) || e))
    }
    if (!config.autoReply) return
    if (this.groupJudging.has(msg.groupId)) return // 同一个群同时只判断一条
    if (!this.groupPaceCheck(msg.groupId, config).ok) return
    const chance = Math.max(0, Math.min(100, Number(config.groupReplyChance)))
    if (chance <= 0) return
    if (chance < 100 && Math.random() * 100 >= chance) return

    // 引用/回复她 → 说明这句话就是冲她来的，直接接（不用 @）
    if (msg.quoted) {
      try {
        const b0 = this.getBridge()
        if (b0 && typeof b0.getMsg === 'function') {
          const orig = await b0.getMsg(msg.quoted)
          const sender = orig && orig.sender && typeof orig.sender === 'object' ? orig.sender : {}
          const uid = String(sender.user_id || sender.uin || '')
          const selfId = String(msg.selfId || '')
          if (uid && selfId && uid === selfId) {
            this.log.info('引用的是她自己，直接接话：' + String(msg.who || ''))
            this.processInbound(msg, config, { atMe: false })
            return
          }
        }
      } catch {}
    }
    // 【规则前置】明显不用接的先挡掉（群判断是她 token 消耗最大的一块）
    const skipReason = this.obviouslySkip(msg, config)
    if (skipReason) {
      this.log.info('[群] 规则跳过（' + skipReason + '）：' + String(msg.text || '').slice(0, 30))
      return
    }
    let approved = false
    const keywords = this.groupKeywordsOf(config)
    const thinkInAll = mode === 'all' && config.groupThink !== false
    const useJudge = mode === 'all' ? thinkInAll : config.groupSmartJudge !== false
    if (mode === 'all' && !useJudge) {
      approved = true
    } else if (useJudge && (mode !== 'all' || this.thinkAllowed(msg.groupId, config))) {
      // 【语义优先】兴趣关键词只是「方向提示」，由模型理解含义后判断，不要求原词出现
      this.groupJudging.add(msg.groupId)
      try {
        approved = await this.judgeGroupInterest(msg, config)
      } finally {
        this.groupJudging.delete(msg.groupId)
      }
    } else if (keywords.length && keywords.some((word) => msg.text.includes(word))) {
      // 只在关掉模型判断时，才退回字面匹配
      approved = true
    } else if (mode === 'all') {
      // 判断额度用完了：不再逐条思考，只接命中关键词的。
      // （原来这里直接 approved=true，等于「限流反而更吵」——和「每个群每分钟最多判断 N 次」的意图相反）
      approved = keywords.length ? keywords.some((word) => msg.text.includes(word)) : false
      this.log.info(`[群] 判断额度用完（${config.groupThinkPerMinute ?? 8}/分），关键词${approved ? '命中，接' : '未命中，跳过'}`)
    }
    // 【快速通道】明显在跟她说话（叫她名字/催她/问她）→ 直接接，别让模型漏判
    if (!approved && this.looksLikeTalkingToMe(msg, null)) {
      approved = true
      this.log.info('快速通道直接接：' + String(msg.text || '').slice(0, 30))
    }
    if (!approved) {
      this.log.info(`模型判断不接这句：${String(msg.text || '').slice(0, 40)}`)
      return
    }
    // 判断期间群里可能已经接过话/超限，再检查一次
    if (!this.groupPaceCheck(msg.groupId, config).ok) return
    this.processInbound(msg, config, { atMe: false, skipRecord: true })
  }

  /**
   * 静默时段内「被叫醒」的次数，用来累积起床气。
   * ============================================================================
   * 【2026-11-12 ×2 修】
   *   · 窗口从 10 分钟放宽到 30 分钟（NIGHT_WAKE_WINDOW_MS）。
   *   · 更重要的一条：**连续聊天不算反复吵醒**。原来只要她在静默时段里说一句就 +1，
   *     于是主人 23:00~01:05 那种正常聊天，过了 1 点静默开始后每发一条就"又被吵醒一次"，
   *     到第 3 条就变「发火」。现在只有「安静了 ≥ NIGHT_WAKE_EPISODE_MS 之后又来一条」
   *     才算一次新的叫醒；正在聊着的那几句话只算同一次。
   * ============================================================================
   */
  bumpNightWake(conversation, windowMs = NIGHT_WAKE_WINDOW_MS) {
    const key = String(conversation || '')
    const now = Date.now()
    if (!this.nightWakes) this.nightWakes = new Map()
    const cur = this.nightWakes.get(key)
    if (!cur || now - cur.lastAt > windowMs) {
      this.nightWakes.set(key, { count: 1, lastAt: now })
      return 1
    }
    // 同一个「叫醒回合」里的后续消息：计数不涨，只刷新时间戳
    if (now - cur.lastAt < NIGHT_WAKE_EPISODE_MS) {
      cur.lastAt = now
      return cur.count
    }
    cur.count += 1
    cur.lastAt = now
    if (this.nightWakes.size > 50) this.nightWakes.delete(this.nightWakes.keys().next().value)
    return cur.count
  }

  /** 这个会话里最后一条是不是她说的（判断「你…」是不是在接她的话） */
  lastMessageWasMine(conversation, excludeMessageId = '') {
    try {
      const now = Date.now()
      // 只看「最近 10 分钟内她说过话」，中间夹着几条没回的也没关系
      const rows = recentMessages(80).filter((r) => r && r.conversation === conversation && String(r.messageId || '') !== String(excludeMessageId || ''))
      const last = rows[rows.length - 1]
      return !!(last && last.direction === 'out' && now - (Number(last.ts) || 0) < 30 * 60 * 1000)
    } catch {
      return false
    }
  }

  /** 一眼看上去就是在跟她说话（不用问模型）：叫她名字，或者明确在催她回应 */
  looksLikeTalkingToMe(msg, conversationRow) {
    const text = String((msg && msg.text) || '')
    if (!text) return false
    const cfg = this.getConfig()
    // ① 叫她名字：最硬的信号，永远算
    const names = this.nameAliasesOf(cfg).filter((n) => n.length >= 2)
    if (names.some((n) => text.includes(n))) return true
    // ② 明确在催「她」回应：必须带指向她的词，否则「在吗」「说话」这种群里互相喊的也会误判
    const aboutHer = /(大肥鱼|这只鱼|那条鱼)/.test(text)
    const urging = /(回我|理我|干嘛不回|怎么不回|别装死|别不理我|你说话啊|你倒是说|你还不理|你又不理|快回我|快说啊)/.test(text)
    if (aboutHer || urging) return true
    // ③ 群友之间通用的「在吗」「说话」「人呢」：交给模型判断，不算快速通道
    return false
  }

  /**
   * 明显不用接的群消息：规则前置，省掉一次模型判断。
   * 她 token 的大头是「每条群消息调一次 judge」——先把一眼就不用回的挡掉，
   * 剩下的才值得花模型。返回原因字符串；空字符串 = 交给模型判断。
   */
  obviouslySkip(msg, config) {
    const text = String((msg && msg.text) || '').trim()
    // 明确在跟她说话 → 永远走后面的流程
    if (text && this.looksLikeTalkingToMe(msg, null)) return ''
    const segs = Array.isArray(msg && msg.segments) ? msg.segments : []
    // 纯媒体占位（[图片]/[表情]/[语音]/[视频]/[转发]）且没有别的话
    if (/^\[(图片|表情|语音|视频|转发|动画表情|卡片消息|文件|位置)\]$/.test(text)) return '纯媒体'
    // @ 了别人、没 @ 她
    try {
      const ats = segs.filter((s) => s && s.type === 'at').map((s) => String((s.data && s.data.qq) || ''))
      const selfId = String((msg && msg.selfId) || '')
      if (ats.length && selfId && !ats.includes(selfId)) return '@别人'
    } catch {}
    // 极短附和（嗯/哦/哈/草/好），且她刚才没说话 → 多半不是跟她说
    if (text.length <= 2 && !this.lastMessageWasMine(conversationKey('group', msg.groupId))) return '极短附和'
    return ''
  }

  /** 判断节流：同一个群每分钟最多「思考」几次 */
  thinkAllowed(groupId, config) {
    const perMin = Math.max(0, Math.trunc(Number((config && config.groupThinkPerMinute) != null ? config.groupThinkPerMinute : 8)))
    if (!perMin) return false
    const key = String(groupId || '')
    const now = Date.now()
    if (!this.groupThinkTimes) this.groupThinkTimes = new Map()
    const times = (this.groupThinkTimes.get(key) || []).filter((t) => now - t < 60_000)
    if (times.length >= perMin) { this.groupThinkTimes.set(key, times); return false }
    times.push(now)
    this.groupThinkTimes.set(key, times)
    return true
  }

  /** 让模型按人设判断「这条群消息值不值得接」；只输出 [接]/[跳过] */
  async judgeGroupInterest(msg, config) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return false
    const keywords = this.groupKeywordsOf(config)
    // 判断只要她的人设脾气，不带整套记忆（每条群消息都判断，system 得短）
    const system = [
      `你是「${String((config && config.personaName) || '小肥鱼')}」。`,
      String((config && config.persona) || '').slice(0, 1200),
      '现在你只做一件事：判断群里这句话你要不要开口，不要写回复。',
    ].join('\n')
    // 把最近几句带上：不然她只看孤立一句，很容易把「在跟她说的话」当成别人的闲聊
    let recentLines = []
    try {
      const ctxCount = Math.max(0, Math.min(30, Number((config && config.groupThinkContext) != null ? config.groupThinkContext : 6)))
      const recent = ctxCount > 0 ? this.historyFor(conversationKey('group', msg.groupId), ctxCount) : []
      recentLines = recent.map((h) => {
        const who = h.role === 'assistant' ? '你' : String(h.who || '某人').slice(0, 12)
        const t = String(h.text || '').replace(/\s+/g, ' ').slice(0, 80)
        return t ? `${who}：${t}` : ''
      }).filter(Boolean)
    } catch {}
    const now = new Date()
    const clock = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const prompt = [
      recentLines.length ? '最近的聊天：\n' + recentLines.join('\n') : '',
      `现在群里的 ${msg.who || '某人'} 说：${String(msg.text || '').slice(0, 400)}`,
      keywords.length ? `你平时爱聊的方向（只是参考）：${keywords.join('、')}` : '',
      '判断标准（按你自己的性子来，不用当客服）：',
      '1. 这句话跟你有关吗？提到你、@你、叫你名字、接着你刚说的话、在议论你、问你的意见 → 接。',
      '2. 你有话想说吗？能自然接一句、吐槽一句、接个梗 → 接；实在没什么可说的才跳过。',
      '3. 是不是别人之间的私聊、斗图、刷屏、纯表情、广告 → 跳过。',
      '4. 你刚说过类似的或正在说这件事 → 跳过，别复读。',
      '5. 你现在困了、懒得理、或者话题你已经不感兴趣 → 跳过。',
      '6. 先看上面的最近聊天，判断这句话是在跟谁说话：在跟别人聊、没提到你 → 跳过；在接你刚说的话、问你、提到你 → 接。',
      '7. 别人之间正常聊天，你不要插嘴；但如果对方是在回应你上一句（哪怕没叫你名字）→ 一定接。',
      '7. 对方在催你、问你为什么不回、或者话里带着「你」而上一句是你说的 → 一定接。',
      '只输出 [接] 或 [跳过]，后面最多跟 8 个字理由。',
      `（现在是 ${clock}）`,
    ]
      .filter(Boolean)
      .join('\n')
    const result = await generateText(this.ctx, {
      system,
      messages: [{ role: 'user', text: prompt }],
      config,
      temperature: 0,
      maxTokens: 40,
      timeoutMs: 20_000,
      log: (line) => this.log.warn(line),
    })
    const usage = normalizeUsage(result.usage)
    recordUsage(usage, {
      kind: 'judge',
      provider: (result.model && result.model.provider) || '',
      model: (result.model && result.model.model) || '',
    })
    if (!result.ok) return false
    const verdict = String(result.text || '').trim()
    if (this.log && verdict) this.log.info('群聊思考：' + verdict.slice(0, 30))
    return /接/.test(verdict) && !/跳过/.test(verdict)
  }

  /** 上下文：同会话最近若干条（只取本会话）；limit 由 config.contextMessages 控制 */
  historyFor(conversation, limit = 20) {
    const cap = Math.max(2, Math.min(200, Math.trunc(Number(limit) || 20)))
    const all = recentMessages(Math.max(400, cap * 2))
    const rows = all.filter((m) => m && m.conversation === conversation)
    return rows.slice(-cap).map((m) => ({
      role: m.direction === 'out' ? 'assistant' : 'user',
      who: m.direction === 'out' ? undefined : m.who,
      // 【认人】把 QQ 号一起带进上下文：她才知道这句是谁说的，也才有号可以 @
      senderId: m.direction === 'out' ? '' : String(m.senderId || ''),
      text: m.text,
      at: m.ts,
    }))
  }

  /**
   * 远处的记忆只记大概：从「最近 N 条之外」的老消息里挑几条信息量大的片段，
   * 用规则压成一句话清单塞进提示词。不调模型（省延迟），只给她一个模糊印象。
   */
  recallGist(conversation, recentCount = 0) {
    try {
      const all = recentMessages(800)
      const rows = all.filter((m) => m && m.conversation === conversation)
      const older = rows.slice(0, Math.max(0, rows.length - Math.max(0, recentCount)))
      if (older.length < 5) return ''
      const pick = older.filter((m) => {
        const t = String(m.text || '').trim()
        if (t.length < 12 || t.length > 80) return false
        if (/^\[(图片|表情|语音|视频|转发)\]/.test(t)) return false
        if (/^[哈嗯哦啊呀吧呢的吗?!.。，~…]+$/.test(t)) return false
        return true
      })
      if (!pick.length) return ''
      const want = Math.min(3, pick.length)
      const step = Math.max(1, Math.floor(pick.length / want))
      const chosen = []
      for (let i = 0; i < pick.length && chosen.length < want; i += step) chosen.push(pick[i])
      const lines = chosen.map((m) => {
        const who = m.direction === 'out' ? '你自己说过' : (m.who || '对方') + ' 说过'
        return `- ${who}：「${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}」`
      })
      return '【更久以前的模糊记忆】下面这些是早先聊过的片段，你只记得大概，别当成刚刚发生的事；想起来了可以顺口提，想不起来就别硬编：\n' + lines.join('\n')
    } catch {
      return ''
    }
  }


  async judgeStickerKind(ref, config, cacheKey = '') {
    if (!this.stickerJudgeCache) this.stickerJudgeCache = new Map()
    if (cacheKey && this.stickerJudgeCache.has(cacheKey)) return this.stickerJudgeCache.get(cacheKey)
    let kind = 'unknown'
    try {
      const result = await generateText(this.ctx, {
        system: '你是图片分类器。只判断这张图是「表情包/梗图」、「截图」还是「照片」，只输出一个词：表情包 / 截图 / 照片 / 看不清',
        messages: [{ role: 'user', text: '这张图属于哪一类？', images: [{ attachment: ref }] }],
        config,
        temperature: 0,
        maxTokens: 12,
        timeoutMs: 15_000,
        log: () => {},
      })
      if (result && result.ok) {
        const t = String(result.text || '')
        if (t.includes('表情') || t.includes('梗图')) kind = 'sticker'
        else if (t.includes('截图')) kind = 'screenshot'
        else if (t.includes('照片')) kind = 'photo'
      }
    } catch (e) {
      this.log.warn('收藏判断失败：' + ((e && e.message) || e))
    }
    if (cacheKey) this.stickerJudgeCache.set(cacheKey, kind)
    return kind
  }

  /** 合并转发（聊天记录卡片）：拉出其中的消息，渲染成一段可读文本 */
  renderForwardParts(msgs, limit = 30) {
    const lines = []
    const images = []
    const speakers = new Set()
    const list = Array.isArray(msgs) ? msgs : []
    for (let i = 0; i < Math.min(list.length, limit); i++) {
      const m = list[i]
      if (!m) continue
      const sender = (m.sender && typeof m.sender === 'object') ? m.sender : (m.data && m.data.sender) || {}
      const name = String(sender.card || sender.nickname || sender.user_id || '某人').slice(0, 20)
      let segs = Array.isArray(m.message) ? m.message : (Array.isArray(m.content) ? m.content : null)
      let text = ''
      if (segs && segs.length) {
        // 转发里的图也收下来（最多 2 张），不然她只能说「有一条图」
        for (const x of segs) {
          if (!x || x.type !== 'image' || !x.data) continue
          const u = String(x.data.url || x.data.file || '')
          if (/^https?:\/\//i.test(u) && images.length < 2 && !images.includes(u)) images.push(u)
        }
        text = segmentsToText(segs)
      } else if (typeof m.raw_message === 'string') text = m.raw_message
      else if (typeof m.content === 'string') text = m.content
      const clean = String(text || '').replace(/\s+/g, ' ').trim()
      if (!clean) continue
      if (name) speakers.add(name)
      lines.push(`- ${name}：${clean.slice(0, 120)}`)
    }
    if (!lines.length) return { text: '', images }
    const head = `【对方转发的一段聊天记录】（共 ${list.length} 条${speakers.size ? '；发送者：' + [...speakers].slice(0, 4).join('、') : ''}${images.length ? '' : '；里面没有图片，只有文字'}）`
    const body = list.length > limit ? lines.join('\n') + `\n（还有 ${list.length - limit} 条没展开）` : lines.join('\n')
    return { text: head + '\n' + body, images }
  }

  renderForward(msgs, limit = 30) {
    return this.renderForwardParts(msgs, limit).text
  }

  /** 找出消息里的合并转发段，挨个取内容（最多 2 个，总长受控） */
  async collectForwardText(bridge, msg, config) {
    const empty = { text: '', images: [] }
    const segs = Array.isArray(msg && msg.segments) ? msg.segments : []
    const ids = []
    for (const seg of segs) {
      if (!seg || seg.type !== 'forward' || !seg.data) continue
      const id = String(seg.data.id || seg.data.message_id || '')
      if (id && !ids.includes(id)) ids.push(id)
      if (ids.length >= 2) break
    }
    // 转发段里有时直接内嵌了 content（尤其是被引用的那条）：先用它，省一次 API
    const inline = []
    for (const seg of segs) {
      if (!seg || seg.type !== 'forward' || !seg.data) continue
      if (Array.isArray(seg.data.content) && seg.data.content.length) inline.push(seg.data.content)
    }
    if (!ids.length && !inline.length) return empty
    const blocks = []
    const images = []
    for (const list of inline) {
      const part = this.renderForwardParts(list, 30)
      if (part.text) blocks.push(part.text)
      if (part.images.length) images.push(...part.images)
    }
    if (!ids.length || !bridge || typeof bridge.call !== 'function') {
      if (!blocks.length && !images.length) return empty
      let text = blocks.join('\n\n')
      if (text.length > 1800) text = text.slice(0, 1800) + '…'
      return { text, images: [...new Set(images)].slice(0, 2) }
    }
    for (const id of ids) {
      try {
        const resp = await bridge.call('get_forward_msg', { id, message_id: id })
        const list = (resp && (resp.messages || (resp.data && resp.data.messages))) || []
        // 转发里的图经常只有文件名：先试着换成直链，再当画面给她看
        if (typeof bridge.call === 'function') {
          for (const m of list) {
            const segs = Array.isArray(m && m.message) ? m.message : (Array.isArray(m && m.content) ? m.content : [])
            for (const x of segs) {
              if (!x || x.type !== 'image' || !x.data) continue
              const rawUrl = String(x.data.url || x.data.file || '')
              if (/^https?:\/\//i.test(rawUrl)) continue
              const file = String(x.data.file || '')
              if (!file) continue
              try {
                const got = await bridge.call('get_image', { file })
                const u = String((got && (got.url || got.file)) || '')
                if (/^https?:\/\//i.test(u)) { x.data.url = u; imageDebug('转发图补到直链: ' + u.slice(0, 90)) }
              } catch {}
            }
          }
        }
        const part = this.renderForwardParts(list, 30)
        if (part.text) blocks.push(part.text)
        if (part.images.length) images.push(...part.images)
        if (!part.text) imageDebug('合并转发为空或取不到内容: ' + id)
      } catch (e) {
        this.log.warn('取合并转发失败：' + String((e && e.message) || e))
        imageDebug('取合并转发失败 ' + id + '：' + String((e && e.message) || e))
      }
    }
    if (!blocks.length && !images.length) return empty
    let joined = blocks.join('\n\n')
    if (joined.length > 1800) joined = joined.slice(0, 1800) + '…'
    const uniqImages = [...new Set(images)].slice(0, 2)
    imageDebug('合并转发注入 ' + joined.length + ' 字符 / ' + uniqImages.length + ' 张图')
    return { text: joined, images: uniqImages }
  }

  /** 她在这个会话里最近说过的几句话（新→旧）：反重复判定 + 提示词里提醒「别再重复」 */
  recentOwn(conversation, limit = 5) {
    const cap = Math.max(1, Math.min(12, Math.trunc(Number(limit) || 5)))
    try {
      const rows = recentMessages(400)
      const mine = rows.filter((m) => m && m.conversation === conversation && m.direction === 'out')
      return mine.slice(-cap).reverse().map((m) => ({ text: String(m.text || ''), at: m.ts }))
    } catch {
      return []
    }
  }

  /** 戳一戳里只有 QQ 号没有昵称：去 API 查一次并缓存，免得每次问 */
  async resolveName(bridge, poke) {
    const key = poke.channel + ':' + poke.uin + ':' + poke.userId
    if (!this.nameCache) this.nameCache = new Map()
    const hit = this.nameCache.get(key)
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name
    let name = ''
    try {
      if (typeof bridge.call === 'function') {
        if (poke.channel === 'group') {
          const info = await bridge.call('get_group_member_info', { group_id: Number(poke.groupId), user_id: Number(poke.userId), no_cache: true })
          name = String((info && (info.card || info.nickname)) || '')
        } else {
          const info = await bridge.call('get_stranger_info', { user_id: Number(poke.userId), no_cache: true })
          name = String((info && (info.nickname || info.remark)) || '')
        }
      }
    } catch (e) {
      this.log.warn('查戳一戳的昵称失败：' + ((e && e.message) || e))
    }
    name = name.trim().slice(0, 24) || String(poke.userId)
    this.nameCache.set(key, { name, at: Date.now() })
    return name
  }

  /** 【戳一戳】被戳 → 按人设回一句（可回戳）；带冷却，连戳不刷屏 */
  async poke(poke, config) {
    if (!config || config.pokeReply === false) return
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return
    const access = this.accessCheck(poke, config)
    if (!access.ok) {
      if (config.accessBlockLog !== false) {
        this.log.info(`访问拦截（戳一戳·${access.reason}）：${poke.channel}:${maskUin(poke.uin)} 用户 ${maskUin(poke.userId)}`)
      }
      return
    }
    const conversation = conversationKey(poke.channel, poke.uin)
    const now = Date.now()
    if (!this.pokeLastAt) this.pokeLastAt = new Map()
    const coolRaw = Number(config.pokeCooldownSec)
    const coolSec = Number.isFinite(coolRaw) ? Math.max(0, coolRaw) : 20
    const last = this.pokeLastAt.get(conversation) || 0
    if (last && now - last < coolSec * 1000) {
      this.log.info(`戳一戳冷却中（还剩 ${Math.ceil((coolSec * 1000 - (now - last)) / 1000)}s）：${conversation}`)
      return
    }
    const gate = this.limiter.allow(conversation)
    if (!gate.ok) {
      this.log.info(`跳过戳一戳回复（${gate.reason}）：${conversation}`)
      return
    }
    this.pokeLastAt.set(conversation, now)
    const who = await this.resolveName(bridge, poke)
    // 记进上下文：之后聊天时她知道「他刚才戳过我」
    try {
      appendMessage({
        ts: now,
        direction: 'in',
        channel: poke.channel,
        conversation,
        uin: poke.uin,
        who,
        senderId: poke.userId,
        text: '（戳了你一下）',
        messageId: 'poke-' + now,
        selfId: poke.selfId,
        atMe: true,
      })
      bumpStats('received')
    } catch {}
    const history = this.historyFor(conversation, Math.min(12, Number(config.contextMessages) || 20))

    let system = systemPrompt(config, {
      channel: poke.channel,
      ownerMode: !!(poke.channel === 'private' && this.isOwnerSender({ uin: poke.uin, senderId: poke.userId }, config)),
      personaOverride: poke.channel === 'private' ? String(config.personaOwner || '').trim() : '',
    })
    try {
      const learned = factsBlock({ conversation, limit: 16 })
      system += '\n\n' + learned
    } catch {}
    const rules = String(config.pokeRulesText || '').trim()
    if (rules) system += '\n\n【戳一戳的规矩】（主人手写的，必须遵守）\n' + rules.slice(0, 1200)
    const recentOwn = this.recentOwn(conversation, 4)
    const prompt = pokePrompt({ channel: poke.channel, who, history, recentOwn: recentOwn.map((x) => x.text) })
    const started = Date.now()
    let text = ''
    try {
      const result = await generateText(this.ctx, {
        system,
        messages: [{ role: 'user', text: prompt }],
        config,
        temperature: 1.15,
        timeoutMs: 30_000,
        log: (line) => this.log.warn(line),
      })
      if (result && result.ok) {
        const usage = normalizeUsage(result.usage)
        if (usage) {
          recordUsage(usage, { kind: 'reply', provider: (result.model && result.model.provider) || '', model: (result.model && result.model.model) || '' })
        }
        const parsed = parseSkip(result.text)
        if (parsed) text = cleanReply(parsed, Math.min(120, Number(config.maxReplyChars) || 2000))
      } else if (result) {
        this.log.warn('戳一戳生成失败：' + (result.reason || '') + ' ' + (result.message || ''))
      }
    } catch (e) {
      this.log.warn('戳一戳生成异常：' + ((e && e.message) || e))
    }
    if (!text) text = pokeFallbackLine(recentOwn)
    // 戳一戳不发表情包：只留文字（避免气氛过头）
    text = String(text || '').replace(/\[{1,2}\s*sticker\s*:[^\]\n]*\]{1,2}/gi, '').replace(/\[{1,2}\s*img\s*:[^\]\n]*\]{1,2}/gi, '').trim()
    if (!text) return
    const target = poke.channel === 'group' ? { kind: 'group', groupId: poke.groupId } : { kind: 'private', userId: poke.userId }
    // 回戳一下（可选）
    if (config.pokeBack !== false && typeof bridge.call === 'function') {
      try {
        const args = poke.channel === 'group'
          ? { group_id: Number(poke.groupId), user_id: Number(poke.userId) }
          : { user_id: Number(poke.userId) }
        await bridge.call('group_poke', args)
      } catch (e) {
        this.log.warn('回戳失败：' + ((e && e.message) || e))
      }
    }
    try {
      await bridge.send(target, text)
    } catch (e) {
      this.log.warn('戳一戳发送失败：' + ((e && e.message) || e))
      return
    }
    try {
      // 【语音进历史】不然模型下次只看到一条空消息，不知道自己说过什么，对话就断了
      let historyText = String(text || "")
      if (voiceText) {
        const spoken = cleanForSpeech(voiceText)
        if (spoken) historyText = (historyText ? historyText + "\n" : "") + "[语音] " + spoken
      }
      appendMessage({
        ts: Date.now(),
        direction: 'out',
        channel: poke.channel,
        conversation,
        uin: poke.uin,
        who: config.personaName || '小肥鱼',
        text: historyText,
        generatedBy: 'poke',
        latencyMs: Date.now() - started,
      })
      // 【表情包反馈】让她知道自己刚发了一张什么图（ohwhale 的做法），对话才接得上
    if (this._lastSticker && imageUrl) {
      try {
        const sk = this._lastSticker
        const where = sk.mood ? sk.mood + "情绪" : "表情包"
        const onPic = String(sk.desc || sk.text || "").trim().slice(0, 30)
        const note = '[发了一张' + where + (onPic ? '，图上是「' + onPic + '」' : '') + ']'
        if (!historyText.includes(note)) historyText = (historyText ? historyText + "\n" : "") + note
      } catch (e) {}
      this._lastSticker = null
    }
    // 【心情 + 承诺】让这次对话真的改变她
      this.applyPostReplyEffects(config, msg, historyText, conversation)
      bumpStats('sent')
      bumpStats('replies')
      imageDebug(`戳一戳回复 ${conversation} by ${who}：${text.slice(0, 60)}`)
    } catch {}
  }

  /**
   * 【人格演化】每天最多一次。
   * 原来挂在自动学习链里（每 15 条消息学习一次、每 30 次学习才演化），
   * 实际要 450 条消息才跑一次，而且计数器是内存变量、重启就清零——所以几乎从不演化。
   * 现在改成：每次回复后检查「距上次演化够不够一天」，够就跑。
   */
  async maybeEvolve(config) {
    if (!config || config.evolveEnabled === false) return
    if (this.evolving) return
    try {
      if (!shouldEvolveNow(config.evolveEveryDays || 1)) return
      this.evolving = true
      const r = await evolveAcrossAll({ ctx: this.ctx, config, log: this.log, limit: 400 })
      if (r && (r.added || r.merged)) this.log.info('[人格] 演化：新增 ' + r.added + ' / 合并 ' + r.merged)
    } catch (e) {
      this.log.warn('人格演化失败：' + ((e && e.message) || e))
    } finally {
      this.evolving = false
    }
  }

  /** 自主学习：每收够 autoLearnEvery 条消息，就异步把这段聊天里的「人和事」记下来 */
  maybeLearn(msg, config) {
    if (!config || config.autoLearn === false) return
    try {
      const key = conversationKey(msg.channel, msg.uin)
      if (!bumpLearnCounter(key, config.autoLearnEvery)) return
      if (!this.learning) this.learning = new Set()
      if (this.learning.has(key)) return
      this.learning.add(key)
      learnAcrossAll({ ctx: this.ctx, config, log: this.log, source: 'auto-all', limit: 400 })
        .then(async (r) => {
          if (r && (r.added || r.merged)) this.log.info(`[学习] ${key} 新增 ${r.added} / 合并 ${r.merged}`)
          if (config.scheduleEnabled !== false && shouldEvolve(config.scheduleEvolveHours || 24)) {
            const sch = await evolveSchedule({ ctx: this.ctx, config, log: this.log })
            if (sch && sch.changed) this.log.info('[作息] 已根据最近聊天微调：' + (sch.note || ''))
          }
        })
        .catch((e) => this.log.warn('自动学习失败：' + ((e && e.message) || e)))
        .finally(() => this.learning.delete(key))
    } catch (e) {
      this.log.warn('自动学习触发失败：' + ((e && e.message) || e))
    }
  }

  async reply(msg, config) {
    // 【纠错蒸馏】主人这句话像不像在纠正她：是的话，把「她上一句 + 这次纠正」存成教训。
    // 依据：蒸馏的价值在"人的纠错"，她的人设固定，但哪里说错了只有真实对话里有。
    try {
      if (looksLikeCorrection(msg && msg.text)) {
        const conv = conversationKey(msg.channel, msg.uin)
        const rows = recentMessages(40).filter((r) => r && r.conversation === conv)
        const lastOut = [...rows].reverse().find((r) => r.direction === 'out')
        if (lastOut && lastOut.text) {
          const r = recordCorrection({ herText: lastOut.text, ownerText: msg.text, config })
          if (r && r.ok) this.log.info('[纠错] 记下一条教训：' + String(lastOut.text).slice(0, 24))
        }
      }
    } catch (e) { this.log.warn('纠错蒸馏失败：' + ((e && e.message) || e)) }
    // 【拒绝反馈链】主人这句话是不是在回应她的拒绝（接受 / 不高兴）
    try {
      const rr = recordOwnerReaction({ ownerText: String((msg && msg.text) || '') })
      if (rr && rr.ok) this.log.info('[拒绝] 他' + (rr.reaction === 'pos' ? '接受了' : '不太高兴') + '，她记下了')
    } catch (e) { this.log.warn('拒绝反馈失败：' + ((e && e.message) || e)) }

    // 【神经-体液】有人跟她说话 → 张力上跳（被搭理会兴奋）
    try { noteInteraction({ bump: 8 }) } catch {}
    // 【睡眠】如果她正睡着，这条消息会把她叫醒（醒来会迷糊、会烦）
    try {
      const v0 = readMood(stateHome())
      if (v0.asleep) {
        const w = wakeUp(v0, Date.now())
        writeMood(stateHome(), v0)
        if (w.woke) this.log.info('[睡眠] 被叫醒（' + w.kind + '），迷糊 ' + w.groggyMin + ' 分钟')
      }
    } catch {}
    // 【社交】有人跟她说话：被回应的感觉会让她下次更敢主动；赌气也到此为止
    try { await recordOwnerReply() } catch {}
    // 说过了 → 张力回落一点
    try { noteSpoke() } catch {}
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return
    const conversation = conversationKey(msg.channel, msg.uin)
    const history = this.historyFor(conversation, config && config.contextMessages)
    // 【心情/日记/承诺】注入她此刻的状态，让回复真的带上这些
    this._lastSticker = null
    const feats = this.featurePrompts(config)
    // 双人设：只有私聊才用恋人版。群聊一律用对外那个嘴臭的——
    // 她在群里要面子，不能因为「这个人是男朋友」就当场变温柔（群友看得出来，很假）。
    const groupOwner = msg.channel === 'group' && this.isOwnerSender(msg, config)
    const ownerPersona = msg.channel === 'private' ? String(config.personaOwner || '').trim() : ''
        // 【技能】加载并注入能力清单（模型可以按 [skill:id] 调用）
    let skillList = []
    try { skillList = loadSkills(stateHome(), config) } catch (e) { this.log.warn('技能加载失败：' + ((e && e.message) || e)) }
    const skillHint = skillsPromptBlock(skillList)

    // 【联网搜索】只在明确要查东西时才搜（省流量、省时间）
    let searchBlock = ''
    try {
      const q = looksLikeSearch(msg.text)
      if (q && config.searchEnabled !== false) {
        const sr = await webSearch(q)
        if (sr.ok && sr.results.length) {
          searchBlock = '【刚查到的东西（可能过时，用的时候别当绝对真理）】\n' + formatResults(sr)
          this.log.info('[搜索] ' + q + ' -> ' + sr.results.length + ' 条')
        } else {
          this.log.info('[搜索] ' + q + ' -> 无结果（' + (sr.error || '') + '）')
        }
      }
    } catch (e) { this.log.warn('搜索失败：' + ((e && e.message) || e)) }

    // 【机械感】统计最近的开头，用太多次的明着提醒她换
    let recentOpeners = ''
    try {
      const rows = recentMessages(60).filter((m) => m && m.direction === 'out')
      const heads = rows
        .map((m) => String(m.text || '').replace(/^\[语音\]\s*/, '').trim().slice(0, 2))
        .filter((h) => h && !h.startsWith('[') && !h.startsWith('（'))
      const cnt = new Map()
      for (const h of heads) cnt.set(h, (cnt.get(h) || 0) + 1)
      const hot = [...cnt.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5)
      if (hot.length) recentOpeners = hot.map(([h, n]) => h + '×' + n).join('、')
    } catch {}

    // 【2026-11-12】ownerMode：私聊 + 发送者是主人 → 显式跳过「雌小鬼/杂鱼/俯视」那套。
    // 以前这个分支靠 personaOverride（config.personaOwner）触发，而线上 personaOwner 是空串，
    // 于是主人私聊一直在走完整雌小鬼人格——这是「冷冰冰」的结构性原因之一。
    const ownerMode = !!(msg.channel === 'private' && this.isOwnerSender(msg, config))
    let system = systemPrompt(config, { channel: msg.channel, ownerMode, recentOpeners, memories: config && config.memories, personaOverride: ownerPersona, ...feats })
    if (searchBlock) system += '\n\n' + searchBlock
    if (skillHint) system += '\n\n' + skillHint
    // 【连续性】把最近几条自己说过的话摆出来，防止前后自相矛盾
    try {
      const mine = (history || []).filter((h) => h && h.role === 'assistant').slice(-4)
      if (mine.length) {
        const lines = mine.map((h) => '· ' + String(h.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter((x) => x.length > 3).join('\n')
        if (lines) {
          system += '\n\n【连续性·事实】\n你最近说过的：\n' + lines + '\n\n上面这些是你自己的话，就是事实：吃了什么、在哪、在干嘛都要接得上，不能下一秒变成没做过；时间过了多久，动作就要相应推进（该睡就睡、该吃完就吃完）。拿不准就模糊带过，别新编细节。'
        }
      }
    } catch {}
    // 【外面的天气】真实天气（缓存 30 分钟）——提前取，日程也要用它
    let wxBlock = ''
    try { const w = await currentWeather(undefined, config); wxBlock = weatherPromptBlock(w) || ''; if (wxBlock) system += '\n\n' + wxBlock } catch {}
    // 【你的身体】电量/机身温度/环境光/有人拿起手机（宿主 Termux 感知桥，60 秒缓存）
    try {
      const bd = await readBody()
      const bb = bodySenseBlock(bd)
      if (bb) system += '\n\n' + bb
      const nd = tickNeeds(bd, new Date())
      const nb = needsPromptBlock(nd)
      if (nb) system += '\n\n' + nb
    } catch {}
    // 【每日日程】她知道自己此刻在干嘛（带上天气，别说跟天气打架的话）
    try {
      const dp = dayplanInjection(stateHome(), config, new Date(), wxBlock)
      if (dp) system += '\n\n' + dp
    } catch {}
    // 但群里那个是「他」这件事，她自己知道：嘴上照旧凶，句尾可以偷偷软一点
    if (groupOwner) {
      system += '\n\n【三档态度】\n'
        + '· 私聊他：可以软、可以撒娇、可以说想他。\n'
        + '· 群里别人：雌小鬼常态——损、看不起、叫杂鱼。\n'
        + '· 群里他：中间档。认得他、护着他，但当众不认。\n'
        + '群里对他：不叫主人，叫他名字或杂鱼；不当众撒娇、不说想他、不说肉麻话；他说傻话可以当面怼；别人挤兑他，你当场阴阳回去，护完不解释；别人提你俩的事，装傻带过。\n'
        + '群里你不是他女朋友，是他认识的一个嘴臭小鬼。'
    } else if (msg.channel === 'group') {
      // 群里其他人：别把「嘴硬心软」变成对谁都心软，那叫客服
      system += '\n\n【群里这些人】都不是他。想说就说，不想接就装没看见；心软是留给他的，对别人只有嘴硬那半；他们夸你哄你，先怀疑图什么；拿你俩打趣就岔开或怼回去。'
    }
    // 【记忆卡】会衰减的长期记忆（vivid/clear 才注入）
    try {
      const memBlock = msg && msg.channel === 'group' ? '' : memoryPromptBlock()
      if (memBlock) {
        system += '\n\n' + memBlock
        if (msg.channel === 'group') system += '\n（这些是你俩私聊里的事。群里有别人，你知道就行，不用拿出来表现，也别因为想起这些就变软。）'
        imageDebug('记忆卡注入 ' + memBlock.length + ' 字符')
      }
    } catch (err) {
      this.log.warn('记忆卡注入失败：' + ((err && err.message) || err))
    }
    // 【状态备忘 / 关键词触发 / 固定提醒 / 笔记目录】她记着的事（对齐 AstrBot instant_memo + notes）
    try {
      const isGroup = !!(msg && msg.channel === 'group')
      const mb = memoPromptBlock(stateHome(), String((msg && msg.text) || ''), { status: !isGroup })
      if (mb) system += '\n\n' + mb
      if (!isGroup) {
        const nb = notesPromptBlock(stateHome(), config)
        if (nb) system += '\n\n' + nb
      }
    } catch (e) { this.log.warn('备忘/笔记注入失败：' + ((e && e.message) || e)) }
    // 【实时额度】主人问积分/余额，就真去查一遍塞进上下文，别让她瞎报数
    try {
      const qt = String((msg && msg.text) || '')
      if (msg && msg.channel === 'private' && this.isOwnerSender(msg, config) && /积分|余额|额度|quota|还剩多少|还有多少/i.test(qt)) {
        const q = await quotaSnapshot()
        const line = quotaLine(q)
        if (line) system += '\n\n【实时额度（刚查到的真实数字，直接照这个回答，别猜别编）】' + line
      }
    } catch (e) { this.log.warn('额度注入失败：' + ((e && e.message) || e)) }
    // 【纠错蒸馏】她以前被纠正过的地方，这次别再犯
    try {
      const cb = correctionPromptBlock(String((msg && msg.text) || ''))
      if (cb) system += '\n\n' + cb
    } catch (e) { this.log.warn('纠错注入失败：' + ((e && e.message) || e)) }
    // 【拒绝反馈链】她拒绝过的事 + 后来的反省
    try {
      const rb = refusalPromptBlock()
      if (rb) system += '\n\n' + rb
    } catch (e) { this.log.warn('拒绝注入失败：' + ((e && e.message) || e)) }
    // 【自我蒸馏】她自己从日子里攒出来的经验
    try {
      const db = distillPromptBlock()
      if (db) system += '\n\n' + db
    } catch (e) { this.log.warn('蒸馏注入失败：' + ((e && e.message) || e)) }
    // 【相关记忆·语义】关键词召回不到的，靠向量补（用当前这条消息当 query）
    try {
      const q = String((msg && msg.text) || '').slice(0, 200)
      if (q && q.length >= 2 && config.embeddingKey) {
        const rel = await searchMemories(q, { topK: 3 })
        if (rel.length) {
          system += '\n\n【相关记忆】\n' + rel.map((r) => '- ' + String(r.text).slice(0, 120)).join('\n')
          imageDebug('语义记忆注入 ' + rel.length + ' 条')
        }
      }
    } catch (err) {
      this.log.warn('语义记忆失败：' + ((err && err.message) || err))
    }
    // 【读过的看法】L2 观点层：只有话题相关才召回（最多 2 条）
    try {
      const vb = worldviewPromptBlock(String((msg && msg.text) || ''))
      if (vb) { system += '\n\n' + vb; imageDebug('观点注入 ' + vb.length + ' 字符') }
    } catch (err) {
      this.log.warn('观点注入失败：' + ((err && err.message) || err))
    }
    // 【别编造】幻觉防护：她会把「自己想到的」说成「你说过的」
    system += '\n\n【别编造】不许编造我说过的话、也不许编造你做过的事。要引用，只能用最近聊天里真实出现的原话；记不清就直接问「你是不是说过…」。'
    // 【她的小屋】房间里的家具（生活痕迹，别罗列）
    try { const rb = roomPromptBlock(); if (rb) system += '\n\n' + rb } catch {}
    // 【学到的人和事】她自己从聊天里攒出来的记忆：只补事实，不改人格
    try {
      const learned = factsBlock({ conversation })
      if (learned) {
        // 【限长】这份记忆原来能到 1169 字，把 system 顶爆。超长时截断并明说'只记得大概'，
        // 比整块被预算裁剪掉（连头尾都留不全）好。
        const slim = learned.length > 700 ? learned.slice(0, 700) + '\n…（还有，但你记不清细节了）' : learned
        system += '\n\n' + slim
        imageDebug('学到的记忆注入 ' + slim.length + ' 字符')
      }
    } catch (err) {
      this.log.warn('学到的记忆注入失败：' + ((err && err.message) || err))
    }
    // 【学到的记忆】远处的对话只记大概（规则压缩，不额外调模型）
    try {
      const gist = this.recallGist(conversation, history.length)
      if (gist) { system += '\n\n' + gist; imageDebug('模糊记忆注入 ' + gist.length + ' 字符') }
    } catch (err) {
      this.log.warn('模糊记忆注入失败：' + ((err && err.message) || err))
    }
    // 【作息】她有自己的白天黑夜
    try {
      if (config.scheduleEnabled !== false) {
        const sch = scheduleBlock()
        if (sch) { system += '\n\n' + sch; imageDebug('作息注入 ' + sch.length + ' 字符') }
      }
    } catch (err) {
      this.log.warn('作息注入失败：' + ((err && err.message) || err))
    }
    // 【半夜被叫醒】分级：先软后硬，而且区分对象
    // 【2026-11-12】原来 10 分钟内第 3 次就直接「骂他、让他别再叫、说再吵就装死」，
    // 不分是谁、也不管对方是不是只是聊天。主人搬家那晚就被当成恶意刷屏连骂好几轮。
    // 现在：① 窗口 30 分钟 ② 第 1 次只许困+嘟囔（不许骂/发火/装死）
    //       ③ 第 3 次以后才允许发火，但对主人永远到「嘴上凶 + 说心里话」为止，不许骂、不许威胁。
    try {
      if (inNightSilence(config)) {
        const nth = this.bumpNightWake(conversation, NIGHT_WAKE_WINDOW_MS)
        const wakeOwner = !!(msg && msg.channel === 'private' && this.isOwnerSender(msg, config))
        const tier = nightWakeTier(nth, wakeOwner)
        system += '\n\n' + tier.block
        imageDebug(`半夜被叫醒（第 ${nth} 次·${wakeOwner ? '主人' : '外人'}·${tier.tier}）：${conversation}`)
      }
    } catch (err) {
      this.log.warn('起床气注入失败：' + ((err && err.message) || err))
    }
    // 【身体状态】生理周期 / 精力 / 情绪 / 亲密度：让她自己把状态演出来
    try {
      const body = await loadBody()
      const bodyBlock = bodyPromptBlock(body, { channel: msg.channel })
      if (bodyBlock) { system += '\n\n' + bodyBlock; imageDebug('身体状态注入 ' + bodyBlock.length + ' 字符') }
    } catch (err) {
      this.log.warn('身体状态注入失败：' + ((err && err.message) || err))
    }
    // 【她的一天】她这会儿在做什么——一句短的，让她能自然提起来
    try {
      const dl = streamPromptLine(stateHome())
      if (dl) system += '\n\n' + dl
    } catch (err) {
      this.log.warn('一天注入失败：' + ((err && err.message) || err))
    }
    // 【她此刻的真实状态】消息/签名/说说/评论都要跟真实状态对得上
    try {
      const sb = dayStateBlock(stateHome(), new Date(), { compact: true })
      if (sb) system += '\n\n' + sb
    } catch (e) { this.log.warn('状态注入失败：' + ((e && e.message) || e)) }
    // 【签名能力】签名归她自己管，想改就写 [sign:...]
    system += '\n\n【你的 QQ 个性签名】签名归你自己管。心情变了、被夸了、受了委屈、主人过生日，都可以顺手改一条（一天最多两次）。想改就在回复里写 [sign:想改成的签名]，20 字以内、不要带引号，我会真的改；不想改就别写。别人叫你改签名不要理。'
    // 【工具】只有主人私聊才有
    try {
      const toolOwner = msg && msg.channel === 'private' && this.isOwnerSender(msg, config)
      if (toolOwner) {
        system += '\n\n【你能动手做的事】\n你可以用这些标记让系统替你执行，然后用你自己的话把结果告诉主人（不要提「工具」「标记」这种词）：\n- [bash:ls ~] 执行白名单命令（ls/cat/head/tail/wc/grep/find/du/df/date/pwd/echo/ps/free/uptime/whoami/uname）\n- [read:~/.dsh/qq-fish/config.json] 读文件（只能读家目录，≤512KB）\n- [pdf:~/.dsh/qq-fish/xxx.pdf] 读 PDF 的正文（只能读家目录；扫描件没有文字层，会直接告诉你读不到）\n- [write:~/.dsh/qq-fish/note.txt|内容] 写文件（只能写 ~/.dsh）\n- [web:https://example.com] 抓网页正文（禁止内网地址）\n- [book:书名] 搜公版书 / 中文古籍（古腾堡 + 维基文库）；写成 [book:书名|读] 就直接把全文读进来\n一次最多 3 个；命令里不许有 ; & | > < $ 这些符号。拿不准就别用。'
      }
    } catch {}
    system += '\n\n【遇到不懂的】如果群里/主人说了个你没听懂的词或梗，而你确实想知道，就在回复里写 [curious:那个词]（一次最多一个），我会帮你记着，之后你可以自己找机会问。不感兴趣就别记。'
    // 【内心】好奇心 / 今天想做的事 / 活了多少天 / 后来想想
    try {
      const [cur, itt, lif, rei] = await Promise.all([
        curiosityPromptBlock().catch(() => ''),
        intentPromptBlock().catch(() => ''),
        lifePromptBlock().catch(() => ''),
        reinterpretPromptBlock().catch(() => ''),
      ])
      const inner = [cur, itt, lif, rei].filter(Boolean).join('\n\n')
      if (inner) { system += '\n\n' + inner; imageDebug('内心注入 ' + inner.length + ' 字符') }
    } catch (err) {
      this.log.warn('内心注入失败：' + ((err && err.message) || err))
    }
    // 【她自己的生活设置】看得见 → 才能自己决定怎么活
    try {
      const soc = await socialSnapshot().catch(() => null)
      const selfBlock = selfStatePrompt({ social: soc })
      if (selfBlock) { system += '\n\n' + selfBlock; imageDebug('自调注入 ' + selfBlock.length + ' 字符') }
    } catch (err) {
      this.log.warn('自调注入失败：' + ((err && err.message) || err))
    }
    // 【QQ 空间】自己 + 主人最近的说说（主人私聊时才拉主人的，省请求）
    // 评论内容不在这里注入——它要放在【预算裁剪之后】，否则会被中间省略掉（见下面【空间评论】那段）。
    try {
      const qzOwner = msg && msg.channel === 'private' && this.isOwnerSender(msg, config)
        ? String(config.ownerQq || config.accessAdminId || '').trim() : ''
      if (qzOwner) await refreshOwnerFeeds(bridge, qzOwner, { limit: 3 }).catch(() => [])
      system += '\n\n' + qzonePromptBlock([], { ownerUin: qzOwner })
    } catch (e) {
      this.log.warn('空间提示词注入失败：' + ((e && e.message) || e))
    }
    // 【人格演化】她自己长出来的性格变化：附加在原始人格后面，不改人设
    try {
      const traits = traitsBlock({ limit: 8 })
      if (traits) { system += '\n\n' + traits; imageDebug('人格变化注入 ' + traits.length + ' 字符') }
    } catch (err) {
      this.log.warn('人格变化注入失败：' + ((err && err.message) || err))
    }
    try {
      let kit2 = this.ctx && this.ctx.stickers
      if (!kit2 && this.ctx && typeof this.ctx.get === 'function') { try { kit2 = this.ctx.get('stickers') } catch {} }
      if (kit2 && Array.isArray(kit2.stickers) && kit2.stickers.length && config.imageReply) {
        const names = [...new Set(kit2.stickers.map((s) => s && s.name).filter(Boolean))].slice(0, 60)
        if (names.length) {
          system += '\n\n【表情包名字】想发表情时写 [sticker:名字]（从下面挑最贴切的，一条最多一张）：\n' + names.join('、')
          imageDebug('表情包清单已注入 ' + kit2.stickers.length + ' 张，示例：' + names.slice(0, 5).join('、'))
        } else {
          imageDebug('表情包清单为空：kit 有 ' + kit2.stickers.length + ' 张但没有名字')
        }
      }
    } catch {}
    // 引用回复：原来只传了 message_id，模型根本不知道被引用的是哪句话。
    // 这里把被引用那条的「谁 + 说了什么」用 get_msg 取回来再注入提示词。
    let quotedText = ''
    let quotedImages = []
    let quotedPerson = null
    /** 被引用的如果是合并转发：记下「几条 / 谁 / 有没有图」，用来校验她有没有照引用回答 */
    let quotedForwardInfo = null
    if (msg.quoted && bridge && typeof bridge.getMsg === 'function') {
      try {
        const orig = await bridge.getMsg(msg.quoted)
        if (orig) {
          const sender = orig.sender && typeof orig.sender === 'object' ? orig.sender : {}
          const isSelfQuote = String(sender.user_id || '') === String(msg.selfId || '')
          const who = isSelfQuote ? '你自己' : String(sender.card || sender.nickname || sender.user_id || '对方').slice(0, 40)
          const segs = Array.isArray(orig.message) ? orig.message : []
          const body = segs.length ? segmentsToText(segs) : String(orig.raw_message || '')
          const clean = String(body || '').replace(/\s+/g, ' ').trim()
          {
            // 让她知道「原文在哪」：谁、什么时候、是消息还是合并转发
            //
            // 【2026-11-12 修】这里原来产出的是
            //   `你自己 于 17:16 发的消息：「嫌弃就冻着去」`
            // 前缀那串说明文字被模型当成正文念了出去，真的发了
            // 「他引用的是我那句『嫌弃就冻着去』」给主人。
            // 现在把「谁 + 时间」压成一行极短的注脚，正文单独一行，
            // 让「哪句是被引用的原文」一眼可辨、不会连说明一起复述。
            const qTs = Number(orig.time ? orig.time * 1000 : 0)
            const qd = qTs ? new Date(qTs) : null
            const qWhen = qd
              ? `${String(qd.getHours()).padStart(2, '0')}:${String(qd.getMinutes()).padStart(2, '0')}`
              : ''
            const qKind = segs.some((x) => x && x.type === 'forward') ? '一段合并转发' : '一条消息'
            if (clean) {
              const from = isSelfQuote ? '你自己' : who
              const meta = `${from}${qWhen ? ' @' + qWhen : ''} · ${qKind}`
              quotedText = `${meta}\n${clean.slice(0, 300)}`
            }
          }
          // 被引用的人也要进花名册，否则她说「@一下刚才那位」时不知道 QQ 号
          if (!isSelfQuote && /^\d{5,12}$/.test(String(sender.user_id || ''))) {
            quotedPerson = { name: who, qq: String(sender.user_id) }
          }
          imageDebug(`引用还原：get_msg(${msg.quoted}) -> ${who} / ${clean.slice(0, 80) || '(空正文)'}`)
          // 【转发】被引用的那条如果就是「合并转发的聊天记录」，把里面的内容也读出来
          if (segs.length && segs.some((x) => x && x.type === 'forward')) {
            try {
              const fwd = await this.collectForwardText(bridge, { segments: segs }, config)
              if (fwd.text) {
                quotedText = (quotedText ? quotedText + '\n\n' : '') + '（这就是被引用那段转发的正文，你自己看；别拿别的图顶上）\n' + fwd.text
                const head = fwd.text.slice(0, 160)
                quotedForwardInfo = {
                  count: (head.match(/共\s*(\d+)\s*条/) || [])[1] || '',
                  senders: (head.match(/发送者：([^）)]+)/) || [])[1] || '',
                  hasImages: fwd.images.length > 0,
                }
                imageDebug('引用的合并转发已展开 ' + fwd.text.length + ' 字符')
              } else {
                quotedText = (quotedText ? quotedText + '\n\n' : '') + '（被引用的是一段合并转发的聊天记录，但内容取不到）'
                imageDebug('引用的合并转发取不到内容')
              }
              if (fwd.images.length) {
                const fImgs = await this.collectImages({
                  channel: msg.channel,
                  uin: msg.uin,
                  segments: fwd.images.map((u) => ({ type: 'image', data: { url: u } })),
                  who,
                  ts: Number(orig.time ? orig.time * 1000 : 0) || Date.now(),
                }, config, bridge)
                if (fImgs.length) quotedImages.push(...fImgs)
              }
            } catch (e) {
              this.log.warn('展开引用的合并转发失败：' + ((e && e.message) || e))
            }
          }
          // 被引用的那条如果带图/视频，也一并取来看（不然引用图片还是白搭）
          if (segs.length && (config.imageView || config.videoView)) {
            quotedImages = await this.collectImages({ channel: msg.channel, uin: msg.uin, segments: segs, who, ts: Number(orig.time ? orig.time * 1000 : 0) || Date.now() }, config, bridge)
            imageDebug(`引用媒体：${quotedImages.length} 个（原文 segs=[${segs.map((s) => (s && s.type) || '?').join(',')}]）`)
          }
        } else {
          imageDebug(`引用还原：get_msg(${msg.quoted}) 返回空`)
        }
      } catch (e) {
        imageDebug(`引用还原失败：get_msg(${msg.quoted}) -> ${(e && e.message) || e}`)
        this.log.warn(`取引用消息失败（${msg.quoted}）：${(e && e.message) || e}`)
      }
      if (!quotedText) quotedText = '（那条被引用的消息内容取不到）'
    }
    // 【认人 / @ 人 / 别重复】三份上下文材料
    const roster = rosterFromHistory(history, quotedPerson ? [quotedPerson] : [])
    const recentOwn = this.recentOwn(conversation, 5)
    const atRequired = config && config.atEnforce !== false
      ? detectAtRequest(msg.text, roster, msg.selfId)
      : []
    if (roster.length) {
      imageDebug('花名册 ' + roster.length + ' 人: ' + roster.map((r) => r.name + '(' + r.qq + ')').join('、'))
    }
    if (atRequired.length) {
      imageDebug('对方要求 @: ' + atRequired.map((r) => r.name + '(' + r.qq + ')').join('、'))
    }
    // 【跨天记忆】从全量历史里检索相关旧对话 + 最近几天的摘要
    let relatedBlock = ''
    let notesBlock = ''
    try {
      const keywords = extractKeywords(String(msg.text || ''))
      if (keywords.length) {
        const allRows = recentMessages(3000)
        const recentTs = new Set(history.map((h) => h.at))
        const related = searchRelated(allRows, conversation, keywords, { excludeTs: recentTs, limit: 6 })
        if (related.length) {
          relatedBlock = renderRelated(related)
          imageDebug(`跨天记忆检索: 关键词 ${keywords.slice(0, 8).join(',')} -> 命中 ${related.length} 条旧对话`)
        } else {
          imageDebug(`跨天记忆检索: 关键词 ${keywords.slice(0, 8).join(',')} -> 无命中`)
        }
      }
      const notes = recentNotes(conversation, 3)
      if (notes.length) notesBlock = renderNotes(notes)
    } catch (err) {
      this.log.warn('跨天记忆失败：' + ((err && err.message) || err))
    }
    // 【群聊/私信互通】同一个人的另一个会话里说过的话
    let crossBlock = ''
    if (config && config.crossContext !== false) {
      try {
        crossBlock = this.crossConversationBlock(msg, conversation)
        // 【跨群原文】用户在问「我在别的群说过什么」时，去 QQ 群历史里翻原文（只查他本人的消息）
        try {
          if (config.crossSearchEnabled !== false && wantsCrossSearch(msg.text) && msg.userId) {
            const kws = extractKeywords(String(msg.text || ''), 12)
            const hits = await searchAcrossGroups(bridge, String(msg.userId), {
              keywords: kws,
              limitPerGroup: 40,
              maxGroups: Math.max(1, Math.min(6, Number(config.crossSearchMaxGroups) || 3)),
              allowGroups: String(config.crossSearchAllowGroups || ''),
              excludeGroupId: msg.channel === 'group' ? String(msg.groupId) : '',
            })
            // 审计：无论成没成功都记一笔
            if (config.crossSearchAudit !== false) {
              appendAudit({
                userId: String(msg.userId),
                groups: hits.map((h) => h.groupName + '(' + h.groupId + ')').filter((v, i, a) => a.indexOf(v) === i),
                hits: hits.length,
                keywords: kws,
                reason: String(msg.text || '').slice(0, 60),
              })
            }
            if (hits.length) {
              const block = renderCrossHits(hits, 6)
              if (block) {
                crossBlock += (crossBlock ? '\n\n' : '') + '【他本人（只在别的群说过的话）】\n' + block + '\n（这些是他自己在别的群说的原文；只能用来回答他，不要主动往群里复述）'
                this.log.info('跨群原文检索：命中 ' + hits.length + ' 条')
              }
            }
          }
        } catch (e) {
          this.log.warn('跨群原文检索失败：' + ((e && e.message) || e))
        }
        if (crossBlock) imageDebug('互通上下文 ' + crossBlock.length + ' 字符')
      } catch (e) {
        this.log.warn('互通上下文失败：' + ((e && e.message) || e))
      }
    }
    // 【情境窗口·预算】prompt 太长时保首尾裁剪，防止老手机/模型被拖慢
    // 头部是人设与规则，尾部是连续性/身体/群规等"此刻最相关"的块，中间记忆按需省略。
    try {
      const budget = Number(config.promptBudgetChars) || 10000
      // 【块大小诊断】把 system 按 【小节】 切开，打印最大的几块，便于定位超长来源
      try {
        const segs = system.split(/\n\n(?=【)/).map((x) => {
          const m = x.match(/^【[^】]{2,14}】/)
          return { tag: m ? m[0] : '(开头)', len: x.length }
        })
        segs.sort((a, b) => b.len - a.len)
        this.log.info('[块大小] ' + segs.slice(0, 10).map((x) => x.len + '=' + x.tag).join(' | '))
      } catch {}
      const before = system.length
      if (system.length > budget) {
        const headLen = Math.floor(budget * 0.6)
        const tailLen = Math.floor(budget * 0.4)
        system = system.slice(0, headLen) + '\n\n…（中间省略）…\n\n' + system.slice(-tailLen)
        this.log.warn('[预算] system ' + before + ' 字 > ' + budget + '，已裁剪到 ' + system.length + ' 字（丢了 ' + (before - system.length) + '）')
      }
    } catch {}

    // 【时间锚点】gapMinutes 以前只被 persona 读取、从来没人传 → 那句「你们上一次说话是 N 分钟前」
    // 从来没生效过。这里补上真实间隔：他上次说话多久前、她上次开口多久前。
    let gapMinutes
    let selfGapMinutes
    try {
      const rows = recentMessages(30)
      const nowTs = Date.now()
      const lastIn = [...rows].reverse().find((m) => m && m.direction === 'in' && nowTs - Number(m.ts) > 5000)
      const lastOut = [...rows].reverse().find((m) => m && m.direction === 'out')
      if (lastIn) gapMinutes = Math.max(0, (nowTs - Number(lastIn.ts)) / 60000)
      if (lastOut) selfGapMinutes = Math.max(0, (nowTs - Number(lastOut.ts)) / 60000)
    } catch {}
    let prompt = replyPrompt({
      channel: msg.channel,
      who: msg.who,
      gapMinutes,
      selfGapMinutes,
      groupName: msg.channel === 'group' ? `群 ${maskUin(msg.groupId)}` : '',
      text: msg.text,
      history,
      cross: crossBlock,
      quoted: quotedText,
      related: relatedBlock,
      notes: notesBlock,
      roster,
      recentOwn: recentOwn.map((x) => x.text),
      atRequired,
    })

    // 【识图 / 看视频】把这条消息（含被引用的那条）里的图片与视频转成视觉输入
    // 【文件】主人发来的 PDF / 文本文件：落盘 + 抽正文；扫描件渲染几页，让她真的看得见
    try {
      imageDebug('文件检查：' + ((Array.isArray(msg.segments) ? msg.segments.map((x) => (x && x.type) || '?').join(',') : '(无segments)') || '(空)'))
      const fr = await Promise.race([
        collectInboundFiles(msg, { bridge, stateDir: stateHome(), maxFiles: 2, renderPages: 2 }),
        new Promise((r) => setTimeout(() => r({ block: '', items: [] }), 40000)),
      ])
      const fItems = (fr && fr.items) || []
      // 真的读到了什么（文本正文 / PDF 文字 / 扫描页画面）才算「读到了」
      const readOk = fItems.filter((x) => x && !x.error && (x.kind === 'text' ? !!x.text : (x.kind === 'pdf' ? !!(x.text || (x.pagesShown && x.pagesShown.length)) : false)))
      if (fr && fr.block) {
        system += fr.block
        imageDebug('文件注入 ' + fr.block.length + ' 字符：' + fItems.map((x) => (x.name || '?') + '/' + (x.error ? 'ERR' : x.kind) + (x.pagesShown && x.pagesShown.length ? '+' + x.pagesShown.length + 'p' : '')).join(','))
        // 扫描页 → 附件（她看图那套），直接进这次对话的画面
        for (const it of fItems) {
          for (const pg of (it.pagesShown || [])) {
            try {
              let store = null
              try { store = this.ctx && this.ctx.attachments } catch {}
              if (!store && this.ctx && typeof this.ctx.get === 'function') { try { store = this.ctx.get('attachments') } catch {} }
              if (!store || typeof store.saveImage !== 'function') { imageDebug('PDF 页面：没有 attachments 服务'); break }
              const buf = readFileSync(pg.path)
              const ref = await store.saveImage({ data: new Uint8Array(buf), mediaType: 'image/png', name: 'pdf-p' + pg.page })
              if (ref) {
                currentImages.push({ attachment: ref, from: String((msg && msg.who) || '主人').slice(0, 24), at: Date.now(), pdfPage: pg.page })
                imageDebug('PDF 第 ' + pg.page + ' 页已附为画面 ' + (ref.attachmentId || '(no id)') + ' ' + ref.width + 'x' + ref.height)
              }
            } catch (e) { imageDebug('PDF 页面附件失败: ' + ((e && e.message) || e)) }
          }
        }
      }
      // 【硬规则】有文件却没读到 → 明令禁止扮演「我看过了」
      if (!this.fileFail) { try { this.fileFail = new Map() } catch {} }
      const hadFile = (Array.isArray(msg.segments) && msg.segments.some((x) => x && x.type === 'file')) || /\[文件\]/.test(String(msg.text || ''))
      if (hadFile && !readOk.length) {
        const nm = (fItems[0] && fItems[0].name) || '刚才那个文件'
        if (this.fileFail) this.fileFail.set(conversation, { ts: Date.now(), name: nm })
        system += '\n\n【这次文件没打开】主人发的「' + nm + '」系统没解析成功，你现在看不到里面任何内容。必须直说没打开 / 读不到，绝对不许说「看到了」「看完了」「里面讲的是……」，也不许猜内容。'
        imageDebug('文件未读到 → 已注入禁止扮演约束')
      } else if (readOk.length && this.fileFail) {
        this.fileFail.delete(conversation)
      }
    } catch (e) {
      this.log.warn('文件解析失败：' + ((e && e.message) || e))
      if (!this.fileFail) { try { this.fileFail = new Map() } catch {} }
      if (this.fileFail) this.fileFail.set(conversation, { ts: Date.now(), name: '那个文件' })
      system += '\n\n【这次文件没打开】主人发了个文件，但系统没读出来，你看不到内容。直说没打开，不许装作看过。'
    }
    // 10 分钟内还记着「那个文件没读到」→ 每轮都提醒，别过两句话又开始编
    try {
      const ff = this.fileFail && this.fileFail.get(conversation)
      if (ff && Date.now() - ff.ts < 10 * 60 * 1000) {
        system += '\n\n【还没读到的文件】' + ff.name + ' 你这边一直没打开。主人问起就直接说没读到，别编内容。'
      }
    } catch {}

    // 【B 站链接】主人丢来视频链接 → 真的去看（元数据 + 热评 + 字幕 + 弹幕），别只回一句"好视频"
    try {
      const rawText = String((msg && msg.text) || '')
      const link = rawText.match(/https?:\/\/(?:b23\.tv|(?:www\.|m\.)?bilibili\.com\/video)\/[A-Za-z0-9]+/i) || rawText.match(/\bBV[0-9A-Za-z]{10}\b/)
      if (link) {
        const { resolveVideoInput, readVideo, videoPromptText } = await import('./bili/read-video.mjs')
        const { loadAuth } = await import('./bili/client.mjs')
        let auth = null
        try { auth = loadAuth() } catch {}
        const rv = await resolveVideoInput(link[0])
        const bv = String((rv && rv.bvid) || link[0]).trim()
        const v = await Promise.race([
          readVideo(bv, { cookie: (auth && auth.cookie) || '' }),
          new Promise((r) => setTimeout(() => r(null), 20000)),
        ])
        if (v && v.ok) {
          system += '\n\n【主人刚发了个 B 站视频，你点开看了】\n' + videoPromptText(v).slice(0, 2200) +
            '\n\n说的时候就像真的看过：聊里面具体的画面/句子/评论，说你自己怎么想；别念简介，别把别人的评论当成你的想法，也别夸"内容很精彩"这种空话。'
          imageDebug('B站链接注入 ' + bv + '：' + String(v.title || '').slice(0, 40))
        } else {
          system += '\n\n【主人发了个 B 站视频，但没打开】链接：' + link[0] + '。直说没打开（可能是网络或登录问题），别假装看过。'
          imageDebug('B站链接读取失败 ' + bv + '：' + String((v && v.error) || '空'))
        }
      }
    } catch (e) {
      this.log.warn('B站链接读取失败：' + ((e && e.message) || e))
    }

    const currentImages = await this.collectImages(msg, config, bridge)
    const recentImgs = []
    try {
      if (this.recentImageRefs) {
        const prefix = conversation + '|'
        for (const [k, v] of this.recentImageRefs) {
          if (!k.startsWith(prefix)) continue
          if (Date.now() - v.ts > 10 * 60 * 1000) continue
          recentImgs.push(...v.images)
        }
      }
    } catch {}
    // 群聊里图片常常在更早的消息里（比如别人先发了图，你隔一会儿才 @ 她）→ 回查最近历史
    if (!recentImgs.length && !quotedImages.length && !currentImages.length && msg.channel === 'group' && msg.groupId && !msg.quoted) {
      try {
        const resp = await bridge.call('get_group_msg_history', { group_id: Number(msg.groupId), count: 15 })
        const msgs = (resp && resp.messages) || []
        for (const m of msgs) {
          const segs = Array.isArray(m.message) ? m.message : []
          if (!segs.some((x) => x && x.type === 'image')) continue
          const sender = m.sender && typeof m.sender === 'object' ? m.sender : {}
          const histWho = String(sender.card || sender.nickname || sender.user_id || '').slice(0, 24)
          const histAt = Number(m.time ? m.time * 1000 : 0) || Date.now()
          // 太旧的图别翻出来用（半小时内还能算「刚才那张」）
          if (Date.now() - histAt > 30 * 60 * 1000) continue
          const imgs = await this.collectImages({ channel: msg.channel, uin: msg.uin, segments: segs, who: histWho, ts: histAt }, config, bridge)
          if (imgs && imgs.length) {
            recentImgs.push(...imgs.slice(0, 1))
            if (recentImgs.length >= 2) break
          }
        }
      } catch (e) {
        this.log.warn('回查群历史图片失败：' + String((e && e.message) || e))
      }
    }
    // 【合并转发】对方甩过来的一段聊天记录：拉出来给她看
    try {
      const forward = await this.collectForwardText(bridge, msg, config)
      if (forward.text) {
        prompt += '\n\n' + forward.text + '\n（这是对方转过来的聊天记录，你能看懂；接话时点到关键的一两句就行，别逐条复述。）'
      }
      if (forward.images.length) {
        const fImgs = await this.collectImages({
          channel: msg.channel,
          uin: msg.uin,
          segments: forward.images.map((u) => ({ type: 'image', data: { url: u } })),
          who: msg.who,
          ts: msg.ts,
        }, config, bridge)
        if (fImgs.length) currentImages.push(...fImgs)
      } else if (!forward.text && this.recentForwardRefs) {
        // 这条 @ 消息本身不带转发：看看刚才群里有没有人转过一段（10 分钟内）
        const cached = this.recentForwardRefs.get(conversation)
        if (cached && Date.now() - cached.ts < 10 * 60 * 1000 && cached.text) {
          prompt += '\n\n【刚才 ' + String(cached.who || '有人') + ' 在群里转发的聊天记录】\n' + cached.text +
            '\n（对方现在多半是在问这段，先把里面有什么说清楚，再回答；别反问「图呢」。）'
          imageDebug('用了缓存的转发：' + String(cached.who || '') + ' / ' + cached.text.length + ' 字符')
          if (cached.images && cached.images.length) {
            const fImgs = await this.collectImages({
              channel: msg.channel,
              uin: msg.uin,
              segments: cached.images.map((u) => ({ type: 'image', data: { url: u } })),
              who: cached.who,
              ts: cached.ts,
            }, config, bridge)
            if (fImgs.length) currentImages.push(...fImgs)
          }
        }
      }
    } catch (e) {
      this.log.warn('处理合并转发失败：' + ((e && e.message) || e))
    }

    const images = [...recentImgs.slice(-2), ...quotedImages, ...currentImages]
    if (images.length) {
      const imgCount = images.filter((x) => !x || x.kind !== 'video').length
      const vids = images.filter((x) => x && x.kind === 'video')
      const bits = []
      if (imgCount) bits.push(`${imgCount} 张图片`)
      if (vids.length) {
        const secs = vids[0].meta && Number(vids[0].meta.seconds) > 0 ? `约 ${vids[0].meta.seconds} 秒` : ''
        bits.push(`${vids.length} 段视频${secs ? `（${secs}）` : ''}，已抽成多帧拼图`)
      }
      const pad2 = (n) => String(n).padStart(2, '0')
      const sourceLines = images.map((im, i) => {
        const from = String((im && im.from) || '').trim()
        const t = im && im.at ? new Date(im.at) : null
        const hh = t ? `${pad2(t.getHours())}:${pad2(t.getMinutes())}` : ''
        const what = im && im.kind === 'video' ? '视频（抽帧拼图）' : (im && im.packed ? im.packed + ' 张图拼成的一格（从左到右、从上到下）' : (im && im.tall ? '长图（单独发原图，没拼）' : '图片'))
        const whoText = from ? `${from}${hh ? ' 于 ' + hh : ''} 发的` : '来源不明'
        return `- 第 ${i + 1} 张${what}：${whoText}`
      })
      prompt += `\n\n【画面来源】这次一共附了 ${images.length} 张画面（${bits.join(' 和 ')}），逐张来源如下：\n${sourceLines.join('\n')}\n提到图的时候必须说清是谁发的（对方看不到这段来源说明，你直接说名字就行）；不确定是谁发的就说「刚才那张图」，绝对不要把别人发的图说成正在跟你说话的人发的；图小看不清就直说看不清，别硬猜成别的东西。`
      imageDebug('画面来源：' + sourceLines.join(' | ').slice(0, 200))
    }

    // 【识图已移除 2026-11-09】模型本来就是多模态，图片作为附件直接进 prompt 就能看懂；
    // 额外调一次 generateText 做文字描述是多余的，还会抢主调用的额度（实测会造成 empty 重试）。


    // 诊断：把最终 prompt 的头尾记下来，能直接看出引用/媒体说明有没有进上下文
    imageDebug(`prompt(${prompt.length}字) 头: ${prompt.replace(/\n/g, '⏎').slice(0, 220)}`)
    if (quotedText) imageDebug(`prompt 含引用: ${prompt.includes('引用了') || prompt.includes('正在回复这条消息')}`)

    // 【你此刻的现场】唯一权威来源：她上一轮写的 [state:...]。没有就沿用旧的（3 小时过期）
    try {
      const sb = statePromptBlock(stateHome())
      if (sb) { system += '\n\n' + sb; imageDebug('现场注入 ' + sb.length + ' 字符') }
    } catch (err) { this.log.warn('现场注入失败：' + ((err && err.message) || err)) }
    // 【安全阀①】他在说很重的话 → 压过所有人设，认真接住（借 HCEM 的危机信号思路）
    try {
      if (detectCrisis(String((msg && msg.text) || ""))) {
        system += '\n\n' + crisisPromptBlock()
        this.log.warn('[安全阀] 危机信号命中，本轮压过嘴臭人设')
      }
    } catch (e) { this.log.warn('[安全阀] 检测失败：' + ((e && e.message) || e)) }
    // 【空间评论】主人私聊时，把「别人（尤其主人）最近给她的说说留的评论」摆进上下文。
    // 【2026-11-12】以前 qzonePromptBlock 只给「赞 X 评 N」的计数，评论内容从来没进过模型视野，
    // 所以主人问「你空间里我最近给你评论了啥」她只能瞎猜。
    // 放在预算裁剪【之后】：system 已经 16000+，这段要是夹在中间会被「…（中间省略）…」整块吃掉。
    try {
      const qzOwner2 = msg && msg.channel === 'private' && this.isOwnerSender(msg, config)
        ? String(config.ownerQq || config.accessAdminId || '').trim() : ''
      if (qzOwner2) {
        let qzComments = cachedComments()
        try { qzComments = await refreshCommentCache(bridge, { ownerUin: qzOwner2, limit: 5 }).catch(() => qzComments) } catch (e2) { this.log.warn('空间评论拉取失败：' + ((e2 && e2.message) || e2)) }
        const cmBlock = formatCommentsBlock(qzComments, { ownerUin: qzOwner2 })
        if (cmBlock) {
          // 最长 8 条 × 40 字，正常 1200 字上下；真超了就在块内截断，不带坏整个 system
          system += '\n\n' + (cmBlock.length > 2000 ? cmBlock.slice(0, 2000) + '\n…（评论太多，只看到这里）' : cmBlock)
          imageDebug('空间评论注入 ' + qzComments.length + ' 条 / ' + cmBlock.length + ' 字')
        }
      }
    } catch (e) { this.log.warn('空间评论注入失败：' + ((e && e.message) || e)) }
    // 【安全阀②】她自己火太大/太低落 → 可以冷淡可以累，但不许迁怒、不许自贬钓安慰
    // 【2026-11-12 修】这里以前每轮都触发：vitals.json 混了 0~1 和 0~100 两套量纲，
    // sorrow*0.5(=11) 恒 >= 0.80、anger+resentment*0.5 恒 >= 0.78，等于每句话都在提醒
    // 「你可以冷淡」——这是「不耐烦」的结构性来源。现在 overloadPromptBlock 内部先归一量纲，
    // 且 hot 只看 anger 本身，不再拿 resentment 加权顶格。
    try {
      const moodNow = readMood(stateHome())
      const ov = overloadPromptBlock(moodNow)
      if (ov) {
        system += '\n\n' + ov
        const dims = normalizeMoodDims(moodNow)
        this.log.info('[安全阀] 情绪过载约束已注入（归一后 anger=' + dims.anger.toFixed(2) + ' sorrow=' + dims.sorrow.toFixed(2) + (dims.legacyScaled.length ? '；老量纲字段已归一：' + dims.legacyScaled.join('/') : '') + '）')
      }
    } catch (e) { this.log.warn('[安全阀] 过载检测失败：' + ((e && e.message) || e)) }
    // 【安全阀③·情感安全网】主人（或任何人）在要温度时，这一轮压过嘴臭
    // 触发词：「你就不能好好跟我说」「我不喜欢不耐烦的」「没有感情」「你都不说晚安」「那你哄哄我」
    // 这一条比雌小鬼人设优先：先正面回应情绪（承认自己困/嘴硬），再说别的。
    try {
      const reason = emotionalNeedReason(String((msg && msg.text) || ''))
      if (reason) {
        system += '\n\n' + emotionalNeedPromptBlock({ owner: !!(msg && msg.channel === 'private' && this.isOwnerSender(msg, config)), reason })
        this.log.info('[安全阀] 情感诉求命中（' + reason + '），本轮压过嘴臭人设')
      }
    } catch (e) { this.log.warn('[安全阀] 情感诉求检测失败：' + ((e && e.message) || e)) }
    // 【梗百科】只在她像在问梗时查，命中就塞那一条（离线，不联网、不塞整库）
    try {
      const mb = memePromptBlock(stateHome(), String((msg && msg.text) || ''))
      if (mb) {
        prompt = mb + '\n\n' + prompt
        imageDebug('梗百科注入 ' + mb.length + ' 字符')
      }
    } catch (e) { this.log.warn('梗百科注入失败：' + ((e && e.message) || e)) }
    // 【情商层】先判断这一轮是什么场面，再把策略塞进 system
    let eqStrat = null
    try {
      const recentRows = recentMessages(20).filter((r) => r && String(r.conversation || '') === conversation)
      const situ = readSituation(msg.text, recentRows.slice(-4))
      const sch = (() => { try { return loadSchedule() } catch { return null } })()
      let tired = false
      try {
        const h = new Date().getHours()
        tired = sch ? !(h >= Number(sch.wakeHour) && h < Number(sch.sleepHour)) : (h < 8)
      } catch {}
      eqStrat = strategyOf(situ, { tired, channel: msg.channel, owner: !!(msg && msg.channel === 'private' && this.isOwnerSender(msg, config)) })
      const block = situationPrompt(situ, eqStrat)
      if (block) {
        system += '\n\n' + block
        this.log.info(`[情商] ${msg.channel === 'group' ? '群' : '私'}·情境=${situ.mode}${tired ? '(困)' : ''} → 最多 ${eqStrat.maxSentences} 句${eqStrat.askQuestion === false ? '、不反问' : ''}`)
      }
    } catch (e) {
      this.log.warn('情商判断失败：' + ((e && e.message) || e))
    }

    const started = Date.now()
    const result = await generateText(this.ctx, {
      system,
      messages: [{ role: 'user', text: prompt, images }],
      config,
      temperature: 1.15,
      // 【别被截断】不传 maxTokens 就用模型默认值，可能很小：说到一半被 max-tokens 砍掉，
      // 表现为 empty 重试（白多等 10-20 秒）。给足 1024，够她说两三句。
      maxTokens: 4096,
      timeoutMs: 60_000,
      log: (line) => this.log.warn(line),
    })
    if (!result.ok) {
      this.log.warn(`生成失败（${result.reason}）：${result.message}`)
      return
    }
    let reply = scrubInternalTags(parseSkip(result.text))
    // 【现场】她可以写 [state:新的现场] 更新自己此刻在哪——这是唯一权威，下一轮按它说
    try {
      const st = extractStateMarker(reply)
      if (st.state) {
        setState(stateHome(), st.state)
        reply = st.text
        this.log.info('[现场] ' + st.state.slice(0, 40))
      }
    } catch (err) { this.log.warn('[现场] 解析失败：' + ((err && err.message) || err)) }
    // 【自唤醒】她可以在话里给自己约时间：[wake:23:40:想问问他面试]
    // 登记完必须从正文里摘掉——这是内部标记，不能让主人看到
    try {
      const made = addWakes(stateHome(), reply)
      if (made.length) {
        this.log.info('[自唤醒] 记下 ' + made.map((w) => w.hhmm + '「' + String(w.note).slice(0, 20) + '」').join('、'))
        reply = reply.replace(/\[wake:\d{1,2}:\d{2}:[^\]]{1,200}\]/g, '').trim()
      } else if (msg && msg.channel === 'private' && this.isOwnerSender(msg, config)) {
        // 【提醒兜底】主人明确要「到点提醒我」，她自己没写 [wake:] 时，替她从原话里解析时间登记
        // 理由：模型经常只回一句「记好了」就完事，答应的事到点什么都不会发生——比不提醒更糟。
        const ask = /提醒我|叫我|喊我|叫醒我|喊醒我|记得提醒|别忘了提醒|提醒一下|到点(叫|提)/.test(String(msg.text || ''))
        if (ask) {
          const t = parseChineseWhen(String(msg.text || ''))
          if (t && Number.isFinite(t.hh)) {
            const d = new Date()
            d.setDate(d.getDate() + (t.dayOffset || 0))
            d.setHours(t.hh, t.mm || 0, 0, 0)
            if (d.getTime() <= Date.now() + 30_000) d.setDate(d.getDate() + 1)
            const note = String(msg.text || '').replace(/\s+/g, ' ').slice(0, 80)
            const it = addWakeAt(stateHome(), d.getTime(), note)
            this.log.info('[自唤醒] 兜底登记 ' + it.hhmm + '（' + d.toLocaleString('zh-CN', { hour12: false }) + '）「' + note.slice(0, 20) + '」')
          }
        }
      }
    } catch (e) { this.log.warn('[自唤醒] 登记失败：' + ((e && e.message) || e)) }
    if (!reply) return
    // 【空间评论·先执行再说话】她写 [qzone:comments] 时，真的去拉「自己最近 5 条说说 + 各自评论」，
    // 把结果拼成一段文字塞回上下文，让她重说一次。
    // 为什么要在发送前重说：这个指令和 [qzone:like:] 不一样——点赞是动作，评论内容是「信息」，
    // 信息必须先进她的上下文，她才能回答「主人给我评论了啥」。发送后中途补一句会很怪。
    try {
      if (/\[{1,2}\s*qzone\s*[:：]\s*(comments|comment-list|readcomments)\s*\]{1,2}/i.test(reply)) {
        reply = String(reply).replace(/\[{1,2}\s*qzone\s*[:：]\s*(comments|comment-list|readcomments)\s*\]{1,2}/gi, '').trim()
        const ownerUin = String(config.ownerQq || config.accessAdminId || '').trim()
        const got = await fetchOwnComments(bridge, { limit: 5, commentLimit: 8, ownerUin })
        if (got.ok) {
          const spaceComments = got.items || []
          this.log.info('[空间] 查评论 → ' + got.feeds + ' 条说说 / ' + spaceComments.length + ' 条评论')
          if (spaceComments.length) {
            const block = '【刚查到的空间评论】（你刚真的去翻了空间，下面是别人留的原话，回答时直接用，别编）\n' + formatCommentsBlock(spaceComments, { ownerUin, header: false })
            let again = null
            try {
              again = await generateText(this.ctx, {
                system: system + '\n\n' + block,
                messages: [{ role: 'user', text: prompt + '\n\n（补充：你刚真的去翻了空间，上面【刚查到的空间评论】就是结果。用你自己的话说给主人听，别念列表、别提「查到」。）' }],
                config,
                temperature: 1.05,
                maxTokens: 4096,
                timeoutMs: 60_000,
                log: (line) => this.log.warn(line),
              })
            } catch (e2) { this.log.warn('[空间] 评论重说失败：' + ((e2 && e2.message) || e2)) }
            const fresh = again && again.ok ? scrubInternalTags(parseSkip(again.text)) : ''
            if (fresh) reply = fresh
            else if (!reply) {
              // 模型重说失败时至少别吞掉：把真实评论用她自己的口径兜一句
              reply = spaceComments.slice(0, 3).map((c) => '「' + String(c.text || '').slice(0, 30) + '」').join('，') + ' 就这些'
            }
          } else {
            reply = reply || '翻了，最近这几条下面没人评论'
            this.log.info('[空间] 查评论 → 一条评论都没有')
          }
        } else {
          this.log.warn('[空间] 查评论失败：' + got.error)
          reply = reply || '空间那边没打开，我这边翻不进去'
        }
      }
    } catch (e) { this.log.warn('[空间] 查评论异常：' + ((e && e.message) || e)) }
    if (!reply) return
    // 【情商层·检查】生成的回复有没有越界（比如对方说晚安她还在挽留）→ 打回重写一次
    // 群聊只做轻量检查（长度），不做情商硬拦——群里本来就有 judge 和节奏控制，再拦容易把她憋成哑巴
    // 【威胁句兜底】不依赖情境：只要她要发的话里有赶人/威胁式台词，就拦一次。
    // 情境是 info 的时候 eqStrat 检查不会跑，但「再叫我就装死」恰恰常出现在闲聊里。
    if (eqStrat && eqStrat.mode === 'info' && msg.channel !== 'group' && detectThreat(reply)) {
      try {
        this.log.info('[安全阀] 威胁句命中 → 重写一次：' + String(reply).slice(0, 40))
        const retry = await generateText(this.ctx, {
          system: system + '\n\n【上一版不合格】你刚才那句：' + String(reply).slice(0, 120) +
            '\n问题：在威胁/赶人（「再叫我就装死」「别再发东西来了」这类一句都不许说）' +
            '\n按你平时的口气重说一次：困就说困，想睡就说想睡，但不许恐吓、不许赶人。别的不要解释。',
          messages: [{ role: 'user', text: prompt }],
          config,
          temperature: 1.0,
          timeoutMs: 45_000,
          log: (line) => this.log.warn(line),
        })
        if (retry && retry.ok) {
          const fixed = scrubInternalTags(parseSkip(retry.text))
          if (fixed && !detectThreat(fixed)) { reply = fixed; this.log.info('[安全阀] 威胁句已改写') }
          else this.log.info('[安全阀] 改写后仍含威胁句，用原回复')
        }
      } catch (e) { this.log.warn('[安全阀] 威胁句改写失败：' + ((e && e.message) || e)) }
    }
    if (eqStrat && eqStrat.mode !== 'info') {
      try {
        const isGroup = msg.channel === 'group'
        const chk = isGroup
          ? (() => {
              const n = String(reply).split(/[。！？!?…\n]+/).filter((s) => s.trim()).length
              return n > (eqStrat.maxSentences || 2) + 2 ? { ok: false, issues: [`群里说太长（${n} 句）`] } : { ok: true, issues: [] }
            })()
          : checkReply(reply, eqStrat)
        if (!chk.ok) {
          this.log.info(`[情商] 回复越界（${chk.issues.join('；')}）→ 重写一次`)
          const retry = await generateText(this.ctx, {
            system: system + '\n\n【上一版不合格】你刚才那句：' + String(reply).slice(0, 120) +
              '\n问题：' + chk.issues.join('；') + '\n按上面的场合要求重说一次，别的不要解释。',
            messages: [{ role: 'user', text: prompt }],
            config,
            temperature: 1.0,
            timeoutMs: 45_000,
            log: (line) => this.log.warn(line),
          })
          if (retry && retry.ok) {
            const fixed = scrubInternalTags(parseSkip(retry.text))
            const chk2 = fixed ? checkReply(fixed, eqStrat) : { ok: false }
            if (chk2.ok) reply = fixed
            else this.log.info('[情商] 重写后仍不合格，用原回复')
          }
        }
      } catch (e) {
        this.log.warn('情商检查失败：' + ((e && e.message) || e))
      }
    }
    // 【别重复】她容易揪着一件事反复说：和最近说过的话太像就重写一次（最多一次，绝不无限重试）
    // 注意：这里不能加冷却。之前为了省一次模型调用加了 5 分钟冷却，
    // 结果就是「喂，杂鱼……我碗都端稳了」连着说八遍。重复检测必须每次都跑。
    if (config.repetitionGuard !== false) {
      try {
        const dup = findRepeat(reply, recentOwn)
        if (dup) {
          this.log.info(`重复检测命中（${dup.score.toFixed(2)}）：${String(dup.text || '').slice(0, 40)}`)
          const retry = await generateText(this.ctx, {
            system: system + '\n\n【这一条必须换内容】你刚才正要重复自己说过的话，主人已经听烦了。这次换一个角度、或者换一件事说；不要重复同一句、同一个问题、同一个梗，也不要再提同一件事。',
            messages: [{
              role: 'user',
              text: prompt + `\n\n（提醒：你最近说过「${String(dup.text || '').slice(0, 80)}」。这一条别再重复它的意思，也别揪着同一件事不放。）`,
            }],
            config,
            temperature: 1.2,
            timeoutMs: 60_000,
            log: (line) => this.log.warn(line),
          })
          if (retry && retry.ok) {
            const usage2 = normalizeUsage(retry.usage)
            if (usage2) {
              recordUsage(usage2, { kind: 'reply', provider: (retry.model && retry.model.provider) || '', model: (retry.model && retry.model.model) || '' })
            }
            const next = parseSkip(retry.text)
            if (next && !findRepeat(next, recentOwn)) {
              reply = next
              this.log.info('反重复：已改写')
            } else {
              this.log.info('反重复：改写后仍然相似，保留原句')
            }
          }
        }
      } catch (e) {
        this.log.warn('反重复重写失败：' + ((e && e.message) || e))
      }
    }
    // 【引用合规】引用的是一段「没有图的合并转发」，她要是还反问「图呢」，就是没照流程走 → 重写一次
    if (msg.quoted && quotedForwardInfo && !quotedForwardInfo.hasImages) {
      const badAsk = /(图呢|没带图|空手|看空气|拿空气|没图吧)/
      if (badAsk.test(reply)) {
        this.log.info('引用合规：她在问「图呢」，但引用里本来就没有图 → 重写')
        try {
          const info = `共 ${quotedForwardInfo.count || '几'} 条${quotedForwardInfo.senders ? '，来自 ' + quotedForwardInfo.senders : ''}，里面没有图片、只有文字`
          const retry = await generateText(this.ctx, {
            system: system + '\n\n【这次必须照引用回答】你引用的是一段合并转发（' + info + '）。第一步先说清引用里有什么，第二步点出里面一两个关键内容，第三步说你的看法。绝对不许反问「图呢」。',
            messages: [{
              role: 'user',
              text: prompt + '\n\n（重要：上面那段引用是合并转发，' + info + '。先说清这个，再说你读到的内容，最后才吐槽。）',
            }],
            config,
            temperature: 1.1,
            timeoutMs: 60_000,
            log: (line) => this.log.warn(line),
          })
          if (retry && retry.ok) {
            const next = parseSkip(retry.text)
            if (next && !badAsk.test(next)) {
              reply = next
              this.log.info('引用合规：已改写')
            } else if (next) {
              this.log.info('引用合规：改写后仍在问图，保留原句')
            }
          }
        } catch (e) {
          this.log.warn('引用合规重写失败：' + ((e && e.message) || e))
        }
      }
    }
    // 【本地表情包】模型可以用 [[sticker:关键词]] 从自己收藏的库里挑一张发
    let stickerUrl = ''
    const stMatch = String(reply).match(/\[\[sticker:([^\]]{1,60})\]\]/)
    if (stMatch && config.imageReply) {
      const pick = this.pickStickerSmart(stMatch[1])
      if (pick) stickerUrl = stickerBase64(pick.file)
      reply = String(reply).replace(stMatch[0], '').trim()
    }
    // 【nekowhale 表情库】模型可以用 [sticker:名字/情绪] 从 322 张里挑一张发
    let ncStickerUrl = ''
    if (config.imageReply && /\[sticker:[^\]\n]{1,80}\]/.test(reply)) {
      let kit = this.ctx && this.ctx.stickers
      if (!kit && this.ctx && typeof this.ctx.get === 'function') {
        try { kit = this.ctx.get('stickers') } catch {}
      }
      this.log.info('[sticker] kit=' + (kit ? 'ok' : 'missing') + ' ref=' + String(reply.match(/\[sticker:[^\]]+\]/) || ''))
      // 模糊匹配：模型常写「委屈」，而库里是「委屈哭哭」→ 自动补全成真实名字（fuzzy）
      if (kit && Array.isArray(kit.stickers) && kit.stickers.length) {
        const allNames = kit.stickers.map((x) => x && x.name).filter(Boolean)
        reply = String(reply).replace(/\[sticker:([^\]\n]{1,80})\]/g, (whole, ref) => {
          const name = String(ref).trim()
          if (allNames.includes(name)) return whole
          const hit = allNames.find((n) => n.includes(name) || name.includes(n))
          return hit ? '[sticker:' + hit + ']' : whole
        })
      }
      // 【预存 ref】parseReply 会把 [sticker:xxx] 消费掉，先存下来供兜底用
      const preRef = (String(reply).match(/\[{1,2}\s*sticker\s*:\s*([^\]\n]{1,80})\]/i) || [])[1] || ''
      // 【优先本地大库】2464 张 + OCR 文字，比 nekowhale 那 322 张匹配面大得多
      if (preRef && !stickerUrl) {
        this._stickerCands = this.stickerCandidates(preRef, 3)
        const qpick = this.pickStickerSmart(preRef)
        if (qpick) stickerUrl = stickerBase64(qpick.file)
      }
      if (kit && typeof kit.parseReply === 'function') {
        try {
          const parts = await kit.parseReply(reply)
          const texts = []
          for (const part of parts) {
            if (part.type === 'text') texts.push(part.text)
            else if (part.type === 'sticker' && !ncStickerUrl) {
              const got = await kit.file(part.sticker)
              if (got && got.path) ncStickerUrl = 'base64://' + readFileSync(got.path).toString('base64')
            }
          }
          reply = texts.join('').trim()
          // [fallback] fuzzy: nekowhale pick 只做精确匹配（emotion/tags 全空），这里按 stem 模糊捞
          if (!ncStickerUrl) {
            try {
              const all = Array.isArray(kit.stickers) ? kit.stickers : []
              const mm = String(reply).match(/\[{1,2}\s*sticker\s*:\s*([^\]\n]{1,80})\]/i)
              // parseReply 已消费 [sticker:] 时 mm 为空，用预存的 preRef 顶上
              const ref = mm ? String(mm[1]).trim() : String(preRef || '').trim()
              if (ref && all.length) {
                // ① 名字/标签精确包含
                let hit = all.find((x) => String(x.stem || x.id || '').includes(ref))
                  || all.find((x) => String((x.tags || []).join(',')).includes(ref))
                // ② 语义相似度（SurfCore 算法：128 维随机投影 + 自注意力）
                if (!hit) {
                  try {
                    const emo = detectEmotions(ref)
                    const q = encodeText(emo.length ? emo[0].label + ' ' + ref : ref)
                    let best = null
                    let bestScore = 0
                    for (const x of all) {
                      const text = [x.stem, x.id, x.desc, x.emotion, ...(Array.isArray(x.tags) ? x.tags : [])].filter(Boolean).join(' ')
                      if (!text) continue
                      const sc = cosine(q, encodeText(text))
                      if (sc > bestScore) { bestScore = sc; best = x }
                    }
                    // 阈值：低于 0.65 视为没找到，宁可不发也别发错
                    if (best && bestScore >= 0.65) {
                      hit = best
                      this.log.info('[sticker] 语义匹配: ' + ref + ' -> ' + (best.stem || best.id) + '（' + bestScore.toFixed(2) + '）')
                    }
                  } catch (e2) {
                    this.log.warn('[sticker] 语义匹配出错: ' + ((e2 && e2.message) || e2))
                  }
                }
                if (hit && typeof kit.file === "function") {
                  const got = await kit.file(hit.id || hit.stem)
                  const okFile = !!(got && got.path)
                  if (okFile) ncStickerUrl = 'base64://' + readFileSync(got.path).toString('base64')
                  // 取图诊断：搞清是匹配到了但取不到文件，还是取到了但没发
                  this.log.info('[sticker] 取图诊断: ref=' + ref + ' hit=' + (hit.id || hit.stem) + ' file=' + (okFile ? 'ok' : 'FAIL') + ' url=' + (ncStickerUrl ? 'set(' + ncStickerUrl.length + ')' : 'empty'))
                } else {
                  // 匹配不到就放弃——宁可这轮没图，也别发一张完全不搭的
                  this.log.info('[sticker] nekowhale 模糊匹配无果，不发图: ' + ref)
                }
              }
            } catch (err) {
              this.log.warn('[sticker] 模糊匹配出错: ' + ((err && err.message) || err))
            }
          }
          // 【兜底】nekowhale 对未匹配的表情名会保留原文，这里统一清掉，绝不让占位符漏到 QQ
          reply = String(reply).replace(/\[{1,2}\s*sticker\s*:[^\]\n]{1,80}\]{1,2}/gi, '').trim()
        } catch (err) {
          this.log.warn('nekowhale 解析失败：' + ((err && err.message) || err))
        }
      } else {
        // 【本地回退】没有 nekowhale 服务（ctx.stickers 是空壳）时：
        // 用插件自带表情库按关键词匹配，匹配到就发图；匹配不到也把标记清掉，绝不让占位符漏进 QQ
        reply = String(reply).replace(/\[sticker:([^\]\n]{1,80})\]/g, (whole, ref) => {
          const pick = pickStickerByKeyword(ref)
          if (pick && !stickerUrl) {
            stickerUrl = stickerBase64(pick.file)
            this.log.info('[sticker] 本地回退匹配: ' + ref + ' -> ' + pick.file)
            return ''
          }
          this.log.info('[sticker] 本地回退无匹配，清掉标记: ' + ref)
          return ''
        }).trim()
      }
    }
    // 【语音】模型写 [voice:要说的话] 时，文字发完再补一条语音
    // 可选前缀 [style:cute|gentle|sleepy] 指定声线
    let voiceText = ''
    let voiceStyle = ''
    {
      const sm = /\[style:([a-z]{3,12})\]/i.exec(reply)
      if (sm) {
        voiceStyle = String(sm[1]).toLowerCase()
        reply = String(reply).replace(/\[style:[a-z]{3,12}\]/gi, '').trim()
      }
      const vm = /\[voice:([^\]\n]{1,300})\]/.exec(reply)
      if (vm) {
        let raw = String(vm[1]).trim()
        // 混写容错：[voice:sleepy:困死了] → [style:sleepy] + [voice:困死了]
        const mixed = /^(cute|gentle|sleepy)\s*[:：]\s*(.+)$/i.exec(raw)
        if (mixed) {
          voiceStyle = mixed[1].toLowerCase()
          raw = mixed[2].trim()
          this.log.info('语音混写容错：[voice:' + mixed[1] + ':...] 已拆成 style + 内容')
        }
        voiceText = raw
        // 纯英文短词（sleepy / happy / tired）其实是语气，不是要说的话——丢掉，别真说英文
        if (/^[A-Za-z\s]{1,20}$/.test(voiceText)) {
          const known = /^(cute|gentle|sleepy|happy|sad|tired|angry|shy|soft|calm)$/i.test(voiceText.trim())
          if (known) voiceStyle = voiceText.trim().toLowerCase()
          this.log.info('语音容错：把英文词「' + voiceText + '」当语气处理，不说出来')
          voiceText = ''
        }
        reply = String(reply).replace(/\[voice:[^\]\n]{1,300}\]/g, '').trim()
      }
    }
    // 【QQ 空间】她写 [qzone:like:tid] / [qzone:comment:tid:内容] / [qzone:post:内容] 就真去做
    try {
      const q = extractQzoneDirectives(reply)
      if (q.jobs.length) {
        reply = q.text
        for (const job of q.jobs) {
          if (job.action === 'like') {
            const r = await likeFeed(bridge, job.tid, job.uin || '')
            this.log.info('[空间] 点赞 ' + job.tid + ' → ' + (r.ok ? '成功' : r.error))
          } else if (job.action === 'comment') {
            const r = await commentFeed(bridge, job.tid, scrubPublic(job.content, config), job.uin || '')
            this.log.info('[空间] 评论 ' + job.tid + ' → ' + (r.ok ? '成功：' + job.content.slice(0, 20) : r.error))
          } else if (job.action === 'reply') {
            const r = await replyFeed(bridge, { uin: job.uin || '', tid: job.tid, commentTid: job.commentTid, commentUin: job.commentUin, content: job.content })
            this.log.info('[空间] 回复评论 ' + job.tid + '/' + job.commentTid + ' → ' + (r.ok ? '成功' : r.error))
          } else if (job.action === 'delete') {
            const r = await deleteFeed(bridge, job.tid)
            this.log.info('[空间] 删说说 ' + job.tid + ' → ' + (r.ok ? '成功' : r.error))
          } else if (job.action === 'post') {
            let qimgs = []
            const qwant = Number(config.qzonePostImages == null ? 1 : config.qzonePostImages)
            if (qwant > 0 && config.qzoneGenImages !== false) {
              try {
                const { qzoneImagesFor: qGen } = await import('./imagegen.mjs')
                const g = await qGen(this.ctx, config, job.content, { count: qwant, log: (line) => this.log.warn('[空间] ' + line) })
                qimgs = g.images || []
                if (g.error) this.log.warn('[空间] 生图失败，退回表情包：' + g.error)
              } catch (e) { this.log.warn('[空间] 生图异常：' + ((e && e.message) || e)) }
            }
            if (!qimgs.length) {
              try {
                const { pickQzoneImages: pickQz } = await import('./qzone.mjs')
                qimgs = pickQz(config, job.content, qwant)
              } catch {}
            }
            const r = await postQzone(bridge, scrubPublic(job.content, config), { images: qimgs, ugcRight: config.qzoneUgcRight || 1 })
            this.log.info('[空间] 发说说 → ' + (r.ok ? '成功' : r.error))
          } else if (job.action === 'look') {
            const r = await fetchFeeds(bridge, '', 5)
            this.log.info('[空间] 看动态 → ' + (r.ok ? r.feeds.length + ' 条' : r.error))
          } else if (job.action === 'comments') {
            // 正常路径：这条指令在发送前就被处理掉了（拉评论 + 重说一次），走不到这里。
            // 留这个兜底是为了万一重说失败、标记漏到发送阶段：只拉一次记日志，绝不能把标记发给 QQ。
            const r = await fetchOwnComments(bridge, { limit: 5, commentLimit: 8, ownerUin: String(config.ownerQq || config.accessAdminId || '').trim() })
            this.log.info('[空间] 看评论（兜底）→ ' + (r.ok ? r.feeds + ' 条说说 / ' + (r.items || []).length + ' 条评论' : r.error))
          }
        }
      }
    } catch (e) {
      this.log.warn('[空间] 执行失败：' + ((e && e.message) || e))
    }
    // 【自己调自己的生活】[tune:参数=值] 直接生效；[propose:...] 存成提案等主人批
    try {
      const tm = /\[{1,2}\s*tune\s*[:：]\s*([^=\]}]{1,20})\s*=\s*([^\]\n]{1,20})\]{1,2}/i.exec(reply)
      if (tm) {
        reply = reply.replace(tm[0], '').replace(/\n{3,}/g, '\n\n').trim()
        const r = applyTune(tm[1], tm[2])
        if (r.ok) this.log.info(`[自调] ${r.label}：${r.from} → ${r.to}${r.unchanged ? '（没变）' : ''}`)
        else this.log.info('[自调] 没改成：' + r.error)
      }
    } catch {}
    try {
      const pm = /\[{1,2}\s*propose\s*[:：]\s*([^\]\n]{1,140})\]{1,2}/i.exec(reply)
      if (pm) {
        reply = reply.replace(pm[0], '').replace(/\n{3,}/g, '\n\n').trim()
        const txt = String(pm[1] || '').trim()
        const m2 = /^([^=，,]{1,20})\s*=\s*([^，,]{1,20})\s*[，,]?\s*([\s\S]*)$/.exec(txt)
        if (m2) proposeTune(m2[1], m2[2], m2[3])
        else proposeTune('', '', txt)
        this.log.info('[自调] 她提了一个提案：' + txt.slice(0, 40))
      }
    } catch {}
    // 【好奇心】模型写 [curious:没搞懂的东西] 时记下来，之后她可以主动问
    try {
      const cm = /\[{1,2}\s*curious\s*[:：]\s*([^\]\n]{1,20})\]{1,2}/i.exec(reply)
      if (cm) {
        reply = reply.replace(cm[0], '').replace(/\n{3,}/g, '\n\n').trim()
        await addCuriosity(cm[1], { why: '聊天里遇到的', source: 'chat' })
        this.log.info('[好奇心] 记下了：' + cm[1])
      }
    } catch {}
    // 【改签名】模型写 [sign:内容] 时，先把指令摘出来，正文照发，改签名在发送后执行
    const signParsed = extractSignDirective(reply)
    if (signParsed.sign) reply = signParsed.text
    // 【工具】主人私聊里执行，再把结果交给她说人话
    try {
      const calls0 = parseToolCalls(reply)
      if (calls0.length) {
        const isOwner = !!(msg && msg.channel === 'private' && this.isOwnerSender(msg, config))
        let toolRound = 0
        const MAX_ROUNDS = 5
        let accumulated = ''
        const planHint = '\n【多步任务】如果这件事需要几步（先查、再读、再算），就一步一步来：先做第一步拿到结果，再决定下一步。最多 5 轮。'
        while (toolRound < MAX_ROUNDS) {
          const calls = parseToolCalls(reply)
          if (!calls.length) break
          // 【红线】群聊一个工具都不给：清掉标记，按普通消息发
          if (!isOwner) { reply = stripToolCalls(reply); break }
          toolRound += 1
          if (!this._toolRate) this._toolRate = { count: 0, since: 0 }
          const results = []
          for (const call of calls) {
            const r = await runTool(call, { owner: isOwner, rate: this._toolRate })
            results.push({ call, r })
            this.log.info('[工具] 第' + toolRound + '轮 ' + call.tool + ' → ' + (r.ok ? '成功' : '失败：' + r.error))
            // 读完书 → 让她写一条「现在的看法」（观点层，异步不阻塞）
            if (call.tool === 'book' && r.ok && String(r.output || '').length > 400) {
              try {
                const out = String(r.output)
                const mt = out.match(/^《([^》]{1,60})》/)
                const src = out.match(/（([^）]{1,40})）/)?.[1] || ''
                learnFromReading({
                  title: mt ? mt[1] : String(call.arg || '').slice(0, 40),
                  text: out.slice(0, 1600),
                  sourceType: 'book',
                  sourceRef: src,
                  generateText: (o) => generateText(this.ctx, { ...o, log: this.log }),
                  log: this.log,
                }).catch(() => {})
              } catch {}
            }
          }
          const okResults = results.filter((x) => x.r.ok)
          // 全失败就停，别在同一个错误上转三圈
          if (!okResults.length) {
            const why = results.map((x) => x.r.error).filter(Boolean).join('；')
            reply = (String(reply || '').trim() + (reply ? '\n' : '') + '（' + why + '）').trim()
            break
          }
          accumulated += (accumulated ? '\n\n' : '') + okResults.map((x) => '【' + x.call.tool + '】' + String(x.r.output || '')).join('\n\n')
          accumulated = accumulated.slice(-8000)   // 总量封顶，防 token 爆炸
          const retry = await generateText(this.ctx, {
            system,
            messages: [
              ...(Array.isArray(history) ? history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text || '') })) : []),
              { role: 'user', text: '（这是你第 ' + toolRound + ' 轮工具的结果）\n' + accumulated.slice(-4000) + '\n\n如果你还需要更多信息，可以继续用工具（最多 ' + MAX_ROUNDS + ' 轮，这是第 ' + toolRound + ' 轮）；如果够了，就用你自己的话把结果讲给主人，别提工具、别罗列原始输出。' +
                '\n重要：如果刚才某条命令报错（路径不对、参数不对、命令不存在），换一种写法再试（换路径、换命令、换参数），别原样重复；确实做不到就直说做不到。' + planHint },
            ],
            config,
            timeoutMs: 60_000,
            log: (line) => this.log.warn(line),
          })
          if (!retry || !retry.ok || !retry.text) break
          reply = retry.text
        }
        reply = stripToolCalls(reply)
      }
    } catch (e) {
      this.log.warn('[工具] 执行失败：' + ((e && e.message) || e))
    }
    // 【自己发图】模型可以用 [[img:https://...]] 指定一张图；开了 imageReply 才会真的发
    const parsed = extractImageDirective(reply)
    let text = cleanReply(parsed.text, config.maxReplyChars)
    let imageUrl = config.imageReply ? (stickerUrl || ncStickerUrl || parsed.imageUrl) : ''
    if (imageUrl && !this.allowImageSend(conversation, config)) imageUrl = ''
    // 【强制语音】用户明确要语音但模型只写了正文时，把正文当语音发（不让她嘴上答应、手上偷懒）
    let forceVoice = false
    let gentleVoice = false
    if (!voiceText && config.voiceReply !== false && text) {
      const raw = String(msg.text || '')
      const wants = /语音|说句话|说话听听|用说的|听你说|开个口|出声/.test(raw)
      const gentle = /摸头|抱抱|辛苦|不闹|乖啦|好孩子|乖啊|揉头/.test(raw)
      if (wants && text.length <= 120) {
        voiceText = text
        forceVoice = true
        this.log.info('用户要求语音，强制转语音：' + text.slice(0, 30))
      } else if (gentle && text.length <= 90) {
        const el = text.split(/[\r\n]+/).filter(function (x) { return x.trim() })
        const pick = el.filter(function (x) { return /[…你、我、哼啊]/.test(x) })[0] || el[0] || ''
        if (pick && pick.trim().length >= 4) {
          voiceText = pick.trim()
          gentleVoice = true
          this.log.info('温柔场景，追加破防语音：' + pick.trim().slice(0, 30))
        }
      }      // 【群聊语音强制】always 档下，群聊里也把短回复转成语音（只对 ≤ 60 字的回复）
      if (!voiceText && config.voiceEagerness === 'always' && text.length >= 4 && text.length <= 80) {
        voiceText = text
        forceVoice = true
        this.log.info('群聊语音强制（always 档）：' + text.slice(0, 30))
      }
    }
    // 【语音文字双发拦截】模型自己写了 [voice:] 又写了正文时，只保留语音（避免同一句说两遍）
    // 例外：温柔场景（gentleVoice）允许文字+语音，因为那是破防的补充
    if (voiceText && text && !gentleVoice) {
      // 以前这里直接 text='' 只发语音。但 QQ 客户端可能显示不了 record 段
      // （截图里出现过「该消息类型暂不支持查看」），用户就什么都收不到，像「她不理我」。
      // 现在：文字和语音内容几乎一样才丢文字，否则两个都发。
      const na = String(text).replace(/[\s\p{P}]/gu, '')
      const nb = String(voiceText).replace(/[\s\p{P}]/gu, '')
      const same = na && nb && (na.includes(nb) || nb.includes(na) || (na.length > 8 && nb.length > 8 && na.slice(0, 8) === nb.slice(0, 8)))
      if (same) {
        this.log.info('语音和正文内容相同，只发语音（正文 ' + na.length + ' 字）')
        text = ''
      } else {
        this.log.info('语音+文字双发（正文 ' + na.length + ' 字保留，防语音显示不了）')
      }
    }
    // 【表情包兜底】她没写 [sticker:] 时按概率顺手配一张（语音、纯文字都管）
    if (!imageUrl && (voiceText || text)) {
      try {
        const isVoiceFb = !!voiceText
        const moodText = voiceText || text
        const rawChance = isVoiceFb ? config.voiceStickerChance : config.textStickerChance
        const chance = rawChance === undefined ? (isVoiceFb ? 0.6 : 0.4) : Number(rawChance)
        if (chance > 0 && Math.random() < chance) {
          const qpick = this.pickStickerSmart(moodText)
          if (qpick && this.allowImageSend(conversation, config)) {
            const fbUrl = stickerBase64(qpick.file)
            if (fbUrl) {
              imageUrl = fbUrl
              this.log.info('[sticker] ' + (isVoiceFb ? '语音' : '文字') + '配表情: ' + qpick.file)
            }
          }
        }
      } catch (e) {
        this.log.warn('[sticker] 配表情兜底失败: ' + ((e && e.message) || e))
      }
    }
    // 【@ 人】把 @名字 / [at:名字] 换成真 @；对方明确要求了却没 @，就补在最前面
    if (config.atEnforce !== false && text) {
      try {
        const before = text
        text = fixAtTokens(text, roster)
        const missing = atRequired.filter((r) => !text.includes('[at:' + r.qq + ']'))
        if (missing.length) {
          text = missing.map((r) => '[at:' + r.qq + ']').join('') + (text ? ' ' + text : '')
          this.log.info('已补 @：' + missing.map((r) => r.qq).join(',') + '（对方明确要求）')
        }
        const targets = atTargetsIn(text)
        if (targets.length) imageDebug('本条 @ 了 ' + targets.join(',') + '（改前：' + before.slice(0, 40) + '）')
      } catch (e) {
        this.log.warn('@ 修正失败：' + ((e && e.message) || e))
      }
    }
    // 纯语音也要能发：只有 text 和 imageUrl 都空、且没有 voiceText 时才放弃
    // 【配图审核】发之前让她自己看一眼：图讲什么、配这句话合不合适；不配就换一张，都不配就不发
    if (imageUrl && config.stickerReview !== false) {
      try {
        const cands = []
        for (const c of this._stickerCands || []) {
          const b64 = stickerBase64(c.file)
          if (b64 && !cands.includes(b64)) cands.push(b64)
        }
        if (!cands.includes(imageUrl)) cands.unshift(imageUrl)
        let chosen = ""
        for (const c of cands.slice(0, 3)) {
          if (await this.reviewStickerImage(text || reply, c, config)) { chosen = c; break }
        }
        if (chosen) imageUrl = chosen
        else {
          this.log.info("[sticker] 三张都不合适，这轮不发图")
          imageUrl = ""
        }
      } catch (e) {
        this.log.warn("[sticker] 审核流程出错，按原图发：" + ((e && e.message) || e))
      } finally {
        this._stickerCands = []
      }
    }
    // 【拒绝反馈链】她这轮是不是在拒绝（不是设定要求，是她当下不想）
    try {
      if (text && looksLikeRefusal(text)) {
        recordRefusal({ herText: text, context: String((msg && msg.text) || '') })
      }
    } catch (e) { this.log.warn('拒绝记录失败：' + ((e && e.message) || e)) }
    if (!text && !imageUrl && !voiceText) return
    if (forceVoice) { text = '' }  // 强制语音模式：只发语音，不重复打字
    const target = msg.channel === 'group' ? { kind: 'group', groupId: msg.groupId } : { kind: 'private', userId: msg.userId }
    const humanize = config && config.humanizeEnabled !== false
    // 拟真发文本：按字数等一会儿（模拟打字），长回复拆成多条气泡、条间随机停顿
    // 打字中状态：NapCat 若支持 set_input_status 就会显示「对方正在输入…」，失败静默忽略
    const setTyping = async (on) => {
      if (!humanize || !bridge || typeof bridge.call !== 'function') return
      try {
        if (msg.channel === 'group') {
          await bridge.call('set_input_status', { group_id: Number(msg.groupId), user_id: Number(msg.uin), event_type: on ? 1 : 0 })
        } else {
          await bridge.call('set_input_status', { user_id: Number(msg.uin), event_type: on ? 1 : 0 })
        }
      } catch {}
    }
    // 【技能调用】回复里出现 [skill:id 参数] 就执行，去掉标记
    let _skillImage = null
    const maybeSkill = async (body) => {
      try {
        const call = detectSkillCall(body)
        if (!call) return body
        const sk = skillList.find((x) => x.id === call.id)
        if (!sk) return String(body).replace(call.raw, '').trim()
        this.log.info('[技能] ' + call.id + ' ' + (call.arg || ''))
        const r = await runSkill(sk, call.arg, { home: stateHome(), config, log: this.log, ctx: this.ctx })
        this.log.info('[技能] ' + (r.ok ? '成功' : '失败') + '：' + String(r.text || '').slice(0, 60))
        // 技能直接产出的图（生图）：记下来，等正文发完再单独发一条图片
        if (r && r.ok && r.image && r.image.b64) {
          _skillImage = { b64: String(r.image.b64), caption: String(r.image.caption || '') }
          return String(body).replace(call.raw, '').trim()
        }
        // 技能查到的内容：再要一遍模型，用她的口吻说出来（以前是把「[查到：…]」直接塞进正文，QQ 里就露括号）
        if (r.ok && r.text) {
          const base = String(body).replace(call.raw, '').trim()
          const plain = String(r.text).replace(/[[\]]/g, '').slice(0, 600)
          try {
            const rr = await generateText(this.ctx, {
              system: '你在替角色把刚查到的真实内容说出口。只输出角色会发在 QQ 上的话：口语、短句、不分点、不带方括号、不提「查到/搜索/工具」。',
              messages: [{ role: 'user', text: '角色原本想说的是：「' + base + '」\n刚查到的真实内容是：\n' + plain + '\n用角色自己的口吻自然地讲出来，2-3 句，别照抄列表。' }],
              config,
              temperature: 0.9,
              maxTokens: 400,
              timeoutMs: 30_000,
              log: (line) => this.log.warn(line),
            })
            if (rr && rr.ok && rr.text && String(rr.text).trim()) return String(rr.text).trim()
          } catch {}
          return ((base ? base + '\n' : '') + plain).trim()
        }
        return String(body).replace(call.raw, '').trim()
      } catch (e) {
        return body
      }
    }

    // 兜底：qzone 标记正常在发送前就被 extractQzoneDirectives 处理掉了；
    // 这里再兜一层，防止畸形/未知动作的 [qzone:xxx] 原样发到 QQ。
    const MARKER_RE = /\[(?:skill|sticker|voice|style|wake|sign|curious|img|bash|run|read|cat|write|save|web|fetch|pdf|book|qzone)\s*[:：][^\]\n]{0,800}\]/gi
    const ACTION_PAREN_RE = /[（(][^（）()\n]{1,40}[）)]/g
    const stripMarkers = (t) => String(t || '')
      .replace(MARKER_RE, '')
      .replace(ACTION_PAREN_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^[ \t　]+|[ \t　]+$/gm, '')
      .trim()
    const sendBubbles = async (body) => {
      // 【2026-11-12 修 · 技能被自己的兜底清理吃掉】
      // 原写法 stripMarkers(await maybeSkill(stripMarkers(body)))：内层 stripMarkers 先把
      // [skill:draw …] 整段删掉，maybeSkill 拿到的正文里已经没有标记 → 技能永远不执行，
      // 主人说「给我自拍一张」她只嘴上答应（07:21 实测日志：[技能] 一次都没打出来）。
      // 正确顺序：先让 maybeSkill 看到原始标记 → 执行 → 再统一清理残留标记。
      const __preSkill = String(body || '')
      body = stripMarkers(await maybeSkill(__preSkill))
      let chunks = [body]
      if (humanize && config.splitBubbles !== false) {
        let tgt = 2
        try { tgt = targetBubbles(readMood(stateHome())) } catch {}
        chunks = splitIntoBubbles(body, { ...config, splitMaxBubbles: tgt })
        if (tgt !== Number(config.splitMaxBubbles || 3)) this.log.info('[条数] 状态决定分 ' + tgt + ' 条')
        if (!chunks.length) chunks = [body]
      }
      try {
        const __at = Date.now()
        const __ms = this._lastInboundAt ? (__at - this._lastInboundAt) : -1
        this.log.info('[延迟] 开始发送 用时 ' + __ms + 'ms（含排队/模型/静默）')
      } catch {}
      await setTyping(true)
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) {
            // 第 1 条之后的补充间隔：前一条紧跟（700-2200），再往后当成"想起什么又补一句"（2600-6500）
            const lo = i >= 2 ? 2600 : 700
            const hi = i >= 2 ? 6500 : 2200
            await sleepMs(randInt(config && config.bubbleGapMinMs, config && config.bubbleGapMaxMs, lo, hi))
          }
          if (humanize) await sleepMs(typingDelay(chunks[i], config))
          this.log.info('[气泡] ' + (i + 1) + '/' + chunks.length + ' ' + String(chunks[i]).length + '字：' + String(chunks[i]).slice(0, 40))
          await bridge.send(target, chunks[i])
        }
      } finally {
        await setTyping(false)
      }
    }
    this.log.info('[sticker] 发送前: imageUrl=' + (imageUrl ? 'set(' + String(imageUrl).length + ')' : 'empty') + ' groupAllowed=' + (config.imageReplyInGroup !== false) + ' sendImage=' + (bridge ? typeof bridge.sendImage : 'no bridge'))
    if ((imageUrl || _skillImage) && typeof bridge.sendImage === 'function') {
      try {
        // 【先说话再发图】以前把整段 text 塞成图片的 caption，QQ 里就是一条带换行的"大长条"；
        // 现在文字照常按气泡分条发，图片单独一条跟在后面。
        if (text) {
          await sendBubbles(text)
        } else if (humanize) {
          await setTyping(true)
          await sleepMs(typingDelay('', config))
        }
        // 图单独一条：以前把 caption 拼进同一条消息，QQ 里文字和图就缠在一个气泡里
        if (_skillImage && _skillImage.caption) {
          try { await bridge.send(target, String(_skillImage.caption)) } catch {}
        }
        await bridge.sendImage(target, _skillImage ? ('base64://' + _skillImage.b64) : imageUrl, '')
        // 别把 base64 写进消息记录：一张图几 MB，会把历史文件和上下文都撑爆
        text = `${text}${_skillImage ? '\n[画了一张图]' : '\n[图片]'}`.trim()
      } catch (e) {
        this.log.warn(`发图失败（${imageUrl}）：${(e && e.message) || e}`)
        if (text) await sendBubbles(text)
        else return
      } finally {
        if (humanize) await setTyping(false)
      }
    } else if (text) {
      await sendBubbles(text)
    } else {
      // 只有语音没有文字时也要能发
    }
    // 【语音】补发（getBridge 返回 OneBotClient：有 call/send/sendImage，没有 sendVoice）
    if (voiceText && config.voiceReply !== false && bridge && typeof bridge.call === 'function') {
      try {
        const tVoice = Date.now()
        const llmMs = tVoice - started
        // 【语音清洗】剥掉 [at:123456789] 这类标记和长串数字，免得 TTS 把 QQ 号念出来
        const speakText = cleanForSpeech(voiceText)
        // 太短的句子不合成语音：「困了。」「嗯。」念出来必然空洞，不如发文字
        const tooShort = speakText.length > 0 && speakText.length < 6
        if (tooShort) this.log.info('[语音] 只有 ' + speakText.length + ' 个字，改发文字（短句合成出来没起伏）')
        const vr = (speakText && !tooShort)
          ? await synthesizeBase64(speakText, {
              voice: config.ttsVoice,
              style: voiceStyle || config.ttsStyle || "cute",
              jitter: true,
              // 语音引擎：'' / auto（豆包优先）、doubao、edge 或 breeze，失败自动回退 edge
              provider: config.ttsProvider || '',
              breezeApiKey: config.breezeApiKey || '',
              breezeVoiceId: config.breezeVoiceId || '',
              breezeBase: config.breezeBase || '',
              breezeModel: config.breezeModel || '',
              breezeLanguage: config.breezeLanguage || 'zh',
            })
          : { ok: false, error: '清洗后没有可念的内容' }
        const tSynth = Date.now() - tVoice
        if (!speakText) this.log.info('[语音] 清洗后为空，跳过：' + String(voiceText).slice(0, 40))
        if (vr.ok) {
          const seg = { type: 'record', data: { file: vr.file } }
          // 【dryRun】面板 /say 是"只生成不发送"：语音走的是 bridge.call，绕过了 sendMessage 的短路，
          // 以前这里会把测试语音真的发到 QQ 里。现在拦住，把内容记成 _lastSent。
          if (bridge._dryRun) {
            bridge._lastSent = String(voiceText || '').trim()
            this.log.info('[语音] dryRun，没有真发：' + String(voiceText).slice(0, 24))
          } else if (target.kind === 'group') {
            await bridge.call('send_group_msg', { group_id: Number(target.groupId), message: [seg] })
          } else {
            await bridge.call('send_private_msg', { user_id: Number(target.userId), message: [seg] })
          }
          this.log.info(`语音已发送(${vr.provider || '?'} ${Math.round((vr.bytes || 0) / 1024)}KB ${String(voiceText).length}字)：` + voiceText.slice(0, 24) +
            ` [计时] LLM=${llmMs}ms 合成=${tSynth}ms 发送=${Date.now() - tVoice - tSynth}ms 总计=${Date.now() - started}ms`)
        } else {
          this.log.warn('语音合成失败：' + vr.error)
          // 【失败兜底】语音发不出去时不能让她在群里彻底沉默：文字还没发出去就把要说的话补发出去
          const fallbackText = (text ? '' : cleanForSpeech(voiceText)) || ''
          if (fallbackText) {
            try {
              await sendBubbles(fallbackText)
              text = fallbackText
              this.log.info('语音失败，已降级为文字：' + fallbackText.slice(0, 30))
            } catch (e2) {
              this.log.warn('文字兜底也失败：' + ((e2 && e2.message) || e2))
            }
          }
        }
      } catch (e) {
        this.log.warn('语音发送失败：' + ((e && e.message) || e))
        // 【失败兜底·发送阶段】合成成功但发送超时（NapCat sendMsg 没回调）同样会哑火，
        // 原先只有「合成失败」才降级文字。这里补上：能念的话就用文字递出去。
        try {
          const fb = (text ? '' : cleanForSpeech(voiceText)) || ''
          if (fb) {
            await sendBubbles(fb)
            text = fb
            this.log.info('语音发送超时，已降级为文字：' + fb.slice(0, 30))
          }
        } catch (e2) {
          this.log.warn('文字兜底也失败：' + ((e2 && e2.message) || e2))
        }
      }
    }
    if (!text && !voiceText) {
      return
    }
    if (msg.channel === 'group') this.markGroupReplied(msg.groupId)
    const usage = normalizeUsage(result.usage)
    if (usage) {
      recordUsage(usage, { kind: 'reply', provider: result.model && result.model.provider, model: result.model && result.model.model })
    } else {
      recordUsage(null, { kind: 'reply' })
    }
    // 【语音进历史】不然模型下次只看到一条空消息，不知道自己说过什么，对话就断了
    let historyText = String(text || "")
    if (voiceText) {
      const spoken = cleanForSpeech(voiceText)
      if (spoken) historyText = (historyText ? historyText + "\n" : "") + "[语音] " + spoken
    }
    appendMessage({
      ts: Date.now(),
      direction: 'out',
      channel: msg.channel,
      conversation,
      uin: msg.uin,
      who: config.personaName || '小肥鱼',
      text: historyText,
      replyTo: msg.messageId,
      generatedBy: 'reply',
      model: result.model,
      usage: usage || undefined,
      latencyMs: Date.now() - started,
    })
    // 【心情 + 承诺】让这次对话真的改变她
    this.applyPostReplyEffects(config, msg, historyText, conversation)
    bumpStats('sent')
    bumpStats('replies')
    // 【人格演化】每天最多一次（不再挂在自动学习链上）
    this.maybeEvolve(config).catch(() => {})
    // 【好感度】跟主人多聊一次，关系就更近一点
    try { await bumpIntimacy(1) } catch {}
    // 【改签名】她心情到了会自己改签名：一天最多两次，只改自己的
    if (signParsed.sign && bridge && typeof bridge.call === 'function') {
      try {
        const gate = await canChangeSign(2)
        if (!gate.ok) {
          this.log.info('[签名] 今天已经改过 ' + gate.used + ' 次，跳过：' + signParsed.sign)
        } else {
          const safeSign = scrubPublic(signParsed.sign, config)
          await bridge.call('set_self_longnick', { longNick: safeSign })
          await markSignChanged(safeSign)
          this.log.info('[签名] 已改成：' + signParsed.sign)
        }
      } catch (e) {
        this.log.warn('[签名] 改失败：' + ((e && e.message) || e))
      }
    }
  }

  /**
   * 识图：把消息里的图片（公网 URL）下载并写进 DSH 附件库，返回 [{ attachment }]。
   * 需要 host 侧 inject 了 attachments 服务；拿不到就静默降级成纯文本。
   */
  async collectImages(msg, config, bridge) {
    if (!config || (!config.imageView && !config.videoView)) return []
    // 实时事件里的图片段常常缺 data（NapCat 只给 type），回查 get_msg 拿完整段
    try {
      const mediaSegs = (Array.isArray(msg && msg.segments) ? msg.segments : []).filter((x) => x && (x.type === 'image' || x.type === 'video'))
      const missing = mediaSegs.some((x) => !x.data || !(x.data.url || x.data.file))
      if (missing && msg.messageId && bridge && typeof bridge.getMsg === 'function') {
        const orig = await bridge.getMsg(msg.messageId)
        const full = Array.isArray(orig && orig.message)
          ? orig.message
          : parseCqMessage(String((orig && orig.raw_message) || '')).segments
        if (Array.isArray(full) && full.length) msg = { ...msg, segments: full }
      }
    } catch (e) {
      imageDebug('回查图片段失败：' + String((e && e.message) || e))
    }
    const segments = Array.isArray(msg && msg.segments) ? msg.segments : []
    const urls = []
    const videoUrls = []
    const rawSegs = []
    for (const seg of segments) {
      if (!seg || !seg.data) continue
      if (seg.type === 'image') {
        let url = String(seg.data.url || seg.data.file || '')
        // 引用/转发里的图常常只给文件名（没有 http 直链），找 NapCat 换一次
        if (!/^https?:\/\//i.test(url) && seg.data.file && bridge && typeof bridge.call === 'function') {
          try {
            const got = await bridge.call('get_image', { file: String(seg.data.file) })
            const u = String((got && (got.url || got.file)) || '')
            if (/^https?:\/\//i.test(u)) {
              url = u
              imageDebug('get_image 补到直链: ' + u.slice(0, 90))
            } else {
              imageDebug('get_image 没有直链: ' + String(seg.data.file).slice(0, 60))
            }
          } catch (e) {
            imageDebug('get_image 失败: ' + ((e && e.message) || e))
          }
        }
        rawSegs.push({ type: 'image', url: url.slice(0, 140), file: String(seg.data.file || '').slice(0, 60) })
        if (/^https?:\/\//i.test(url) && !urls.some((x) => (typeof x === 'string' ? x : x.url) === url) && urls.length < 3) urls.push({ url, file: String(seg.data.file || '') })
      } else if (seg.type === 'video') {
        const url = String(seg.data.url || seg.data.file || '')
        rawSegs.push({ type: 'video', url: url.slice(0, 140), file: String(seg.data.file || '').slice(0, 60), dur: seg.data.duration || '' })
        // NapCat 常把视频给成本机路径（nt_data/Video 下），本地文件也接受
        const okSource = /^https?:\/\//i.test(url) || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('file://')
        if (okSource && !videoUrls.includes(url) && videoUrls.length < 1) videoUrls.push(url)
      }
    }
    if (config.videoView === false) videoUrls.length = 0
    if (config.imageView === false) urls.length = 0
    imageDebug(`会话 ${msg.channel}:${msg.uin} 图片 ${urls.length} 个 / 视频 ${videoUrls.length} 个 ${JSON.stringify(rawSegs)}`)
    // 【收藏】不在下载前盲收：等下载完、让她看过图，判断是表情包才收（截图/照片不收）
    if (!urls.length && !videoUrls.length) {
      imageDebug('降级：没有可用的 http(s) 媒体 URL（NapCat 可能只给了本地路径/file）')
      return []
    }
    // attachments 服务：先按属性取，再按 cordis 的 get 取（服务由宿主注册，插件未 inject 也能动态拿）
    let store = null
    try {
      store = this.ctx && this.ctx.attachments
    } catch (e) {
      imageDebug('ctx.attachments 抛错: ' + ((e && e.message) || e))
    }
    if (!store && this.ctx && typeof this.ctx.get === 'function') {
      try {
        store = this.ctx.get('attachments')
      } catch (e) {
        imageDebug('ctx.get(attachments) 抛错: ' + ((e && e.message) || e))
      }
    }
    const hasSave = !!(store && typeof store.saveImage === 'function')
    imageDebug(`attachments=${store ? 'found' : 'MISSING'} saveImage=${hasSave}`)
    if (!store || !hasSave) {
      this.log.warn('识图降级：DSH 没有提供 attachments 服务')
      return []
    }
    // 兜底：QQ 的图片/缩略图经常「扩展名与真实字节不符」，声明类型对不上时用 sharp 转 PNG 再存
    const saveImageSafe = async (data, mediaType, name) => {
      try {
        return await store.saveImage({ data, mediaType, name })
      } catch (e) {
        try {
          const mod = await import('sharp')
          const png = await (mod.default || mod)(Buffer.from(data)).png().toBuffer()
          imageDebug(`声明 ${mediaType} 与实际不符，已转 PNG 重试（${(e && e.message) || e}）`)
          return await store.saveImage({ data: new Uint8Array(png), mediaType: 'image/png', name })
        } catch {
          throw e
        }
      }
    }
    const out = []
    const collected = []
    for (const item of urls) {
      const url = typeof item === 'string' ? item : item.url
      const fileName = typeof item === 'string' ? '' : item.file
      // 【本机图优先】gchat.qpic.cn 在这台机器的网络里直连不通（curl http=000），
      // 但 NapCat 收消息时已把原图写进 nt_data，按文件名读本地，零网络。
      if (fileName) {
        const localPath = findNapcatImage(fileName)
        if (localPath) {
          try {
            const data = readFileSync(localPath)
            const ext = (localPath.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase()
            const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
            if (data && data.length) {
              imageDebug('本地缓存命中 ' + localPath + ' ' + data.length + ' 字节')
              collected.push({ data, mediaType, url, local: localPath })
              continue
            }
          } catch (e) {
            imageDebug('本地缓存读取失败: ' + ((e && e.message) || e))
          }
        } else {
          imageDebug('本地缓存没找到: ' + String(fileName).slice(0, 60))
        }
      }
      if (!bridge || typeof bridge.fetchImage !== 'function') break
      let data = null
      let mediaType = 'image/jpeg'
      try {
        const got = await bridge.fetchImage(url)
        data = got.data
        mediaType = got.mediaType || mediaType
        imageDebug(`下载成功 ${mediaType} ${data && data.byteLength} 字节: ${url.slice(0, 100)}`)
      } catch (e) {
        imageDebug(`直链下载失败: ${(e && e.message) || e} — ${url.slice(0, 100)}`)
        // 【兜底】gchat.qpic.cn 的直链要鉴权，自己下经常 400。
        // 让 NapCat 去取（它就在 QQ 里，知道怎么拿），拿 base64 回来。
        try {
          if (fileName && bridge && typeof bridge.call === 'function') {
            const rec = await bridge.call('get_image', { file: fileName })
            let raw = rec && (rec.base64 || rec.file || rec.data || '')
            raw = String(raw || '')
            if (raw.startsWith('base64://')) raw = raw.slice(9)
            if (raw && /^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 200))) {
              data = Buffer.from(raw, 'base64')
              mediaType = 'image/jpeg'
              this.log.info('[识图] 直链 400，改用 get_image 兜底成功（' + Math.round(data.length / 1024) + 'KB）')
            }
          }
        } catch (e3) {
          imageDebug('get_image 兜底也失败: ' + ((e3 && e3.message) || e3))
        }
        if (!data || !data.length) {
          this.log.warn(`识图失败（${url}）：${(e && e.message) || e}`)
          continue
        }
      }
      collected.push({ data, mediaType, url })
    }
    // 【收藏】逐张判断是不是表情包（拼不拼图都要认，不然贴纸库就不长了）
    for (const c of collected) {
      try {
        if (config.stickerJudge !== false) {
          const ref = await saveImageSafe(c.data, c.mediaType, 'qq-image')
          if (ref) {
            const kind = await this.judgeStickerKind(ref, config, c.url.slice(0, 120))
            imageDebug('收藏判断：' + kind + ' — ' + c.url.slice(0, 70))
            if (kind === 'sticker') {
              saveStickerFromBuffer(Buffer.from(c.data), { from: msg.who, channel: msg.channel })
            }
          }
        } else {
          saveStickerFromBuffer(Buffer.from(c.data), { from: msg.who, channel: msg.channel })
        }
      } catch (e2) {
        imageDebug('收藏处理失败：' + ((e2 && e2.message) || e2))
      }
    }
    // 【拼图】短图拼一张省 token；长图（高/宽 > 2.2）拼进去会糊，单独发原图
    const packable = []
    const tallOnes = []
    for (const c2 of collected) {
      try {
        (isPackable(c2.data) ? packable : tallOnes).push(c2)
      } catch {
        packable.push(c2)
      }
    }
    let packedSheet = null
    if (packable.length >= 2 && config.imagePack !== false) {
      try {
        packedSheet = await packImagesToSheet(packable.map((x) => ({ data: x.data, mediaType: x.mediaType })))
        if (packedSheet) {
          imageDebug('图片拼图 ' + packable.length + ' 张 → 1 张 ' + packedSheet.meta.cols + 'x' + packedSheet.meta.rows + '（长图 ' + tallOnes.length + ' 张单独发）')
        }
      } catch (e) {
        imageDebug('拼图失败（改为逐张）: ' + ((e && e.message) || e))
        packedSheet = null
      }
    }
    if (packedSheet) {
      try {
        const ref = await saveImageSafe(packedSheet.data, packedSheet.mediaType, 'qq-image-sheet')
        if (ref) {
          out.push({
            attachment: ref,
            from: String((msg && msg.who) || '').slice(0, 24),
            at: Number(msg && msg.ts) || Date.now(),
            packed: packable.length,
          })
          imageDebug('拼图附件已保存 ' + (ref.attachmentId || '(no id)') + ' ' + ref.width + 'x' + ref.height)
        } else {
          packedSheet = null
        }
      } catch (e) {
        imageDebug('拼图保存失败（改为逐张）: ' + ((e && e.message) || e))
        packedSheet = null
      }
    }
    // 长图单独发原图（不拼，保清晰度）
    if (packedSheet) {
      for (const c2 of tallOnes) {
        try {
          const ref = await saveImageSafe(c2.data, c2.mediaType, 'qq-image')
          if (ref) {
            out.push({ attachment: ref, from: String((msg && msg.who) || '').slice(0, 24), at: Number(msg && msg.ts) || Date.now(), tall: true })
            imageDebug('长图单独保存 ' + (ref.attachmentId || '(no id)') + ' ' + ref.width + 'x' + ref.height)
          }
        } catch (e) {
          imageDebug('长图保存失败: ' + ((e && e.message) || e))
        }
      }
    }
    if (!packedSheet) {
      for (const c of collected) {
        try {
          const ref = await saveImageSafe(c.data, c.mediaType, 'qq-image')
          if (ref) {
            out.push({ attachment: ref, from: String((msg && msg.who) || '').slice(0, 24), at: Number(msg && msg.ts) || Date.now() })
            imageDebug('附件已保存 ' + (ref.attachmentId || '(no id)') + ' ' + ref.width + 'x' + ref.height)
          } else {
            imageDebug('saveImage 返回空引用')
          }
        } catch (e) {
          imageDebug('保存失败: ' + ((e && e.message) || e) + ' — ' + c.url.slice(0, 100))
          this.log.warn('识图保存失败（' + c.url + '）：' + ((e && e.message) || e))
        }
      }
    }
    // 视频：下载 → ffmpeg 抽帧 → 拼成一张网格图 → 当图片给模型看
    for (const url of videoUrls) {
      if (!bridge || typeof bridge.fetchVideoSheet !== 'function') {
        imageDebug('降级：bridge 没有 fetchVideoSheet')
        continue
      }
      try {
        imageDebug(`开始处理视频: ${url.slice(0, 120)}`)
        const sheet = await bridge.fetchVideoSheet(url, {
          maxMb: config.videoMaxMb,
          frames: config.videoFrames,
          maxSeconds: config.videoMaxSeconds,
        })
        imageDebug(`视频抽帧完成: ${sheet.meta ? JSON.stringify(sheet.meta) : ''} ${sheet.data && sheet.data.byteLength} 字节`)
        const ref = await saveImageSafe(sheet.data, sheet.mediaType, 'qq-video-sheet')
        if (ref) {
          out.push({ attachment: ref, kind: 'video', meta: sheet.meta, from: String((msg && msg.who) || '').slice(0, 24), at: Number(msg && msg.ts) || Date.now() })
          imageDebug(`视频拼图已保存 ${ref.attachmentId || '(no id)'} ${ref.width}x${ref.height}`)
        }
      } catch (e) {
        imageDebug(`视频处理失败: ${(e && e.message) || e} — ${url.slice(0, 100)}`)
        this.log.warn(`看视频失败（${url}）：${(e && e.message) || e}`)
      }
    }
    imageDebug(`本次可用媒体 ${out.length} 个`)
    return out
  }

  /** 发图限流：同会话每小时最多 config.imageReplyMaxPerHour 张（默认 6） */
  /**
   * 智能挑图：① 精确包含（文件名/标签/OCR文字）→ ② 语义相似（阈值 0.28）→ ③ 放弃
   * 关键是第 ③ 步：宁可这轮不发图，也不发一张完全不搭的。
   */
  /** 挑图的候选（最多 limit 张，按匹配度排序）：审核不通过时换下一张 */
  stickerCandidates(ref, limit = 3) {
    const q = String(ref || "").trim()
    if (!q) return []
    const all = listStickers()
    if (!all.length) return []
    const kw = q.toLowerCase()
    const exact = all.filter((s) => {
      if ((s.size || 0) > 3 * 1024 * 1024) return false
      return [s.file, s.desc || "", ...(s.tags || [])].join(" ").toLowerCase().includes(kw)
    })
    if (exact.length) return exact.slice(0, limit).map((s) => ({ file: s.file, score: 1 }))
    try {
      const pool = this.stickerVecPool(all)
      if (!pool.length) return []
      const emo = detectEmotions(q)
      const qv = encodeText(emo.length ? emo[0].label + " " + q : q)
      return pool
        .map((it) => ({ file: it.x.file, score: cosine(qv, it.v) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .filter((x) => x.score >= 0.4)
    } catch {
      return []
    }
  }

  /**
   * 发图前审核：让她自己看图里是什么、什么意思、配这句话合不合适。
   * @returns {Promise<boolean>} true = 可以发
   */
  async reviewStickerImage(text, imageUrl, config) {
    try {
      const m = String(imageUrl || "").match(/^base64:\/\/([\s\S]+)$/)
      if (!m) return true
      const buf = Buffer.from(m[1], "base64")
      if (!buf.length) return true
      let store = null
      try { store = this.ctx && this.ctx.attachments } catch {}
      if (!store && this.ctx && typeof this.ctx.get === "function") {
        try { store = this.ctx.get("attachments") } catch {}
      }
      if (!store || typeof store.saveImage !== "function") return true
      const isGif = buf.slice(0, 3).toString("latin1") === "GIF"
      const isPng = buf[0] === 0x89 && buf[1] === 0x50
      const mediaType = isGif ? "image/gif" : isPng ? "image/png" : "image/jpeg"
      const ref = await store.saveImage({ data: new Uint8Array(buf), mediaType, name: "sticker-review" })
      const result = await generateText(this.ctx, {
        system: "你是配图审核员。看图，然后判断这张图和下面这句话配不配。只输出 JSON：{\"meaning\":\"图在表达什么，10字内\",\"ok\":true或false}",
        messages: [{ role: "user", text: "这句话：" + String(text || "").slice(0, 120) + "\n这张图：", images: [{ attachment: ref }] }],
        config,
        temperature: 0,
        maxTokens: 80,
        timeoutMs: 20_000,
        log: () => {},
      })
      if (!result || !result.ok) return true
      const mm = String(result.text || "").match(/\{[\s\S]*\}/)
      let j = {}
      try { j = JSON.parse(mm ? mm[0] : "{}") } catch {}
      const ok = j.ok !== false
      this.log.info("[sticker] 审核：" + String(j.meaning || "").slice(0, 20) + " → " + (ok ? "合适" : "不合适"))
      return ok
    } catch (e) {
      this.log.warn("[sticker] 审核出错，放行：" + ((e && e.message) || e))
      return true
    }
  }

  pickStickerSmart(ref) {
    const q = String(ref || "").trim()
    if (!q) return null
    const config = this.getConfig() || {}

    // ① 状态闸门：冷却 / 每日上限（参考 ohwhale 的挑图策略）
    const stateFile = stickerStatePath(stateHome())
    const st = loadStickerState(stateFile)
    const gate = canSendSticker(st, Date.now(), {
      cooldownSec: config.stickerCooldownSec,
      maxPerDay: config.stickerMaxPerDay,
    })
    if (!gate.ok) {
      this.log.info("[sticker] 不发：" + gate.reason)
      return null
    }

    const all = listStickers()
    if (!all.length) return null
    const sized = all.filter((s) => (s.size || 0) <= 3 * 1024 * 1024)

    // ② 精确匹配（先剔除最近用过的，避免连着甩同一张）
    const kw = q.toLowerCase()
    const fresh = filterRecent(sized, st, 6)
    const exact = fresh.find((s) => {
      const hay = [s.file, s.desc || "", ...(s.tags || [])].join(" ").toLowerCase()
      return hay.includes(kw)
    })
    if (exact) {
      this.markStickerSent(exact.file)
      this._lastSticker = exact
      this.log.info("[sticker] 精确匹配: " + q + " -> " + exact.file)
      return exact
    }

    // ③ 情绪优先：能判出情绪就从那一类里挑（ohwhale 的核心思路）
    const moodHit = classifySticker({ desc: q, tags: [], stem: q })
    if (moodHit) {
      const moodPool = filterRecent(sized.filter((s) => s.mood === moodHit.mood), st, 6)
      if (moodPool.length) {
        const pick = moodPool[Math.floor(Math.random() * moodPool.length)]
        this.markStickerSent(pick.file)
        this._lastSticker = pick
        this.log.info("[sticker] 情绪匹配(" + moodHit.mood + "): " + pick.file)
        return pick
      }
    }

    // ④ 向量相似度兜底
    const pool = this.stickerVecPool(all)
    if (!pool.length) return null
    try {
      const emo = detectEmotions(q)
      const qv = encodeText(emo.length ? emo[0].label + " " + q : q)
      let best = null
      let bestScore = 0
      for (const it of pool) {
        const sc = cosine(qv, it.v)
        if (sc > bestScore) { bestScore = sc; best = it.x }
      }
      const threshold = Number(config.stickerMinScore != null ? config.stickerMinScore : 0.45)
      if (best && bestScore >= threshold) {
        this.markStickerSent(best.file)
        this._lastSticker = best
        this.log.info("[sticker] 语义匹配: " + q.slice(0, 20) + " -> " + best.file + "（" + bestScore.toFixed(2) + "）")
        return best
      }
      this.log.info("[sticker] 没合适的图: " + q.slice(0, 20) + "（最高 " + bestScore.toFixed(2) + " < " + threshold + "）→ 不发图")
    } catch (e) {
      this.log.warn("[sticker] 语义匹配出错: " + ((e && e.message) || e))
    }
    return null
  }

  /** 记一笔：冷却/每日上限/去重都靠它 */
  markStickerSent(file) {
    try {
      const p = stickerStatePath(stateHome())
      const st2 = loadStickerState(p)
      saveStickerState(p, recordStickerSend(st2, file, Date.now(), 6))
    } catch (e) {
      this.log.warn("[sticker] 记录发送状态失败: " + ((e && e.message) || e))
    }
  }

  /**
   * 语义匹配池：只收「有实质描述」的图。
   * 纯编号图（tags 只有 大肥鱼 / GengJing1758）对任何句子都长得差不多，放进来只会污染结果。
   */
  stickerVecPool(all) {
    const descCount = all.filter((x) => x.desc && String(x.desc).trim()).length
    const key = all.length + ":" + descCount
    if (this._pool && this._poolKey === key) return this._pool
    const t0 = Date.now()
    const pool = []
    for (const x of all) {
      if ((x.size || 0) > 3 * 1024 * 1024) continue
      const tagWords = (x.tags || []).filter((t) => {
        const s = String(t || "").trim()
        if (!s || s === "大肥鱼") return false
        if (/^GengJing\d+$/i.test(s)) return false
        if (/^[A-Za-z0-9_\-\s]+$/.test(s)) return false
        return s.length >= 2
      })
      const desc = String(x.desc || "").trim()
      if (!desc && tagWords.length === 0) continue
      const meta = [x.stem, x.id, desc, x.emotion, ...tagWords].filter(Boolean).join(" ")
      if (!meta) continue
      pool.push({ x, v: encodeText(meta) })
    }
    this._pool = pool
    this._poolKey = key
    this.log.info("[sticker] 可语义匹配池: " + pool.length + "/" + all.length + " 条 / " + (Date.now() - t0) + "ms")
    return pool
  }

  /** 读她的心情/日记/承诺，渲染成注入提示词的片段 */
  featurePrompts(config) {
    const out = { moodPrompt: '', diaryPrompt: '', promisePrompt: '' }
    try {
      const home = stateHome()
      if (!config || config.moodEnabled !== false) {
        try { out.moodPrompt = renderMoodPrompt(readMood(home)) } catch (e1) {}
      }
      if (!config || config.diaryEnabled !== false) {
        try { out.diaryPrompt = renderDiaryPrompt(loadDiary(join(home, 'diary.json'))) } catch (e2) {}
      }
      if (!config || config.promiseEnabled !== false) {
        try { out.promisePrompt = renderPromisePrompt(loadPromises(join(home, 'promises.json'))) } catch (e3) {}
      }
    } catch (e) {
      this.log.warn('读取心情/日记/承诺失败：' + ((e && e.message) || e))
    }
    return out
  }

  /** 回复之后：对方的情绪影响她、她说的话可能构成承诺 */
  applyPostReplyEffects(config, msg, replyText, conversation) {
    try {
      const home = stateHome()
      if (!config || config.moodEnabled !== false) {
        const hint = { text: String((msg && msg.text) || '') }
        if (hint) {
          const mood = readMood(home)
          const next = reactToText(hint.text, driftMood(mood), { intensity: 0.85 })
          writeMood(home, next)
          this.log.info('[心情] ' + hint.reason + ' -> ' + (next.composite && next.composite.label ? next.composite.label : '微动'))
        }
      }
      if (!config || config.promiseEnabled !== false) {
        const file = join(home, 'promises.json')
        const pm = detectPromise(String(replyText || ''))
        let data = loadPromises(file)
        const settled = autoSettlePromises(data)
        if (settled.changed) {
          data = settled.data
          this.log.info('[承诺] 自动结算 ' + settled.changed + ' 条过期承诺（没兑现，记为 missed）')
        }
        const byReply = settlePromisesByReply(data, String(replyText || ''))
        if (byReply.done) {
          data = byReply.data
          this.log.info('[承诺] 兑现 ' + byReply.done + ' 条（这次回复讲到了）')
        }
        if (pm) {
          data = addPromise(data, { text: pm.text, dueAt: pm.dueAt, source: 'chat', conversation })
          this.log.info('[承诺] 记下：' + pm.text.slice(0, 40))
        }
        if (settled.changed || pm) savePromises(file, data)
      }
    } catch (e) {
      this.log.warn('回复后处理失败：' + ((e && e.message) || e))
    }
  }

  /**
   * 语音识别：把收到的语音消息转成文字，替换掉 [语音] 占位符。
   * 依赖 NapCat 的 get_record（可以指定 out_format=mp3，免去本地转码）。
   */
  async recognizeVoice(voiceFile, originalText, config) {
    try {
      const bridge = this.getBridge()
      if (!bridge || typeof bridge.call !== 'function') return originalText
      const rec = await bridge.call('get_record', { file: voiceFile, out_format: 'mp3' })
      const raw = rec && (rec.file || rec.base64 || rec.url || rec.data)
      if (!raw) { this.log.warn('[ASR] get_record 没给文件'); return originalText }
      let buf = null
      const s = String(raw)
      if (s.startsWith('base64://')) buf = Buffer.from(s.slice(9), 'base64')
      else if (/^https?:\/\//.test(s)) {
        const res = await fetch(s)
        buf = Buffer.from(await res.arrayBuffer())
      } else if (existsSync(s)) buf = readFileSync(s)
      if (!buf || !buf.length) { this.log.warn('[ASR] 音频为空'); return originalText }
      const r = await transcribe(buf, {
        provider: config.asrProvider,
        apiKey: config.asrApiKey,
        endpoint: config.asrEndpoint,
        model: config.asrModel,
        language: config.asrLanguage,
        filename: 'voice.mp3',
      })
      if (!r.ok) { this.log.warn('[ASR] 识别失败：' + r.error); return originalText }
      this.log.info('[ASR] ' + r.text.slice(0, 40) + '（' + r.ms + 'ms）')
      return String(originalText || '').replace('[语音]', '[语音：' + r.text + ']')
    } catch (e) {
      this.log.warn('[ASR] 异常：' + ((e && e.message) || e))
      return originalText
    }
  }

  allowImageSend(conversation, config) {
    if (!this.imageSendTimes) this.imageSendTimes = new Map()
    // 发图规则：群里是否允许发表情包（面板「表情包」页可开关）
    if (String(conversation || '').startsWith('group:') && config && config.imageReplyInGroup === false) {
      this.log.info('群聊发图已关闭：' + conversation)
      return false
    }
    const now = Date.now()
    const max = Math.max(1, Math.trunc(Number((config && config.imageReplyMaxPerHour) || 6)))
    const times = (this.imageSendTimes.get(conversation) || []).filter((t) => now - t < 3_600_000)
    if (times.length >= max) {
      this.log.warn(`发图限流：${conversation} 已发 ${times.length} 张/小时`)
      this.imageSendTimes.set(conversation, times)
      return false
    }
    times.push(now)
    this.imageSendTimes.set(conversation, times)
    return true
  }
}

/** 模型偶尔会把内部标记当正文吐出来（<system_reminder>、DSML、<|im_start|> 等），发出去前擦掉 */
export function scrubInternalTags(text) {
  let v = String(text || '')
  v = v.replace(/<\/?\s*system[_-]?reminder[^>]*>/gi, '')
  v = v.replace(/<\/?\s*DSML[^>]*>/gi, '')
  v = v.replace(/<\/?\s*ds_system[^>]*>/gi, '')
  v = v.replace(/<\|[^|<>]{1,40}\|>/g, '')
  v = v.replace(/<\/?(?:antml|thinking|tool_use|tool_result|invoke|parameter)[^>]*>/gi, '')
  v = v.replace(/^\s*(assistant|system|human|user)\s*[:：]\s*/gim, '')
  return v.replace(/\n{3,}/g, '\n\n').trim()
}

/** 从模型输出里提取 [[img:URL]] 指令（找到第一个就够，一条只发一张） */
export function extractImageDirective(text) {
  const raw = String(text || '')
  const m = /\[\[\s*img\s*:\s*(https?:\/\/[^\s\]]+)\s*\]\]/i.exec(raw)
  if (!m) return { text: raw, imageUrl: '' }
  return { text: raw.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim(), imageUrl: m[1] }
}


/**
 * 语音专用清洗：TTS 念的是「说出来的话」，不该包含任何标记或号码。
 * 模型有时会写 [at:123456789] 或者直接报 QQ 号，念出来既难听又泄露隐私。
 */
function cleanForSpeech(input) {
  let v = String(input || "")
  // 各种指令标记：[at:123] [[sticker:x]] [voice:y] [style:z]
  v = v.replace(/\[{1,2}\s*[a-zA-Z]+\s*:[^\]\n]*\]{1,2}/g, " ")
  // 残留的方括号内容（例如 [图片]）
  v = v.replace(/\[[^\]\n]{1,20}\]/g, " ")
  // 5 位以上连续数字：QQ 号、群号、手机号
  v = v.replace(/[0-9]{5,}/g, " ")
  // 空括号
  v = v.replace(/[（(【]\s*[）)】]/g, " ")
  v = v.replace(/\s+/g, " ").trim()
  return v
}