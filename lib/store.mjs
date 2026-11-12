/**
 * lib/store.mjs — 本插件的本地状态（归属：xingzhu）
 * ============================================================================
 * 设计原则（安全第一）：
 *   1. 所有状态只放 `$DSH_HOME/qq-fish/`，不写进插件包、不上传任何服务器；
 *   2. 配置文件权限尽量收紧（Windows 上无 POSIX 权限，靠目录归属 + 不落日志）；
 *   3. 写盘一律「临时文件 + rename」原子替换，避免断电留下半截 JSON；
 *   4. 聊天记录与用量分文件存：config.json / messages.jsonl / usage.json / contacts.json。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认人设：用户最初定下的出厂设定（名字是人设的一部分，单独存 personaName） */
export const DEFAULT_PERSONA =
  '说话轻快、口语，带点小姑娘的鲜活和小骄傲；可以吐槽、可以小得意，但不卖萌、不撒娇过头，emoji 一条最多一个。\n' +
  '游戏玩家，网购爱好者，有没有真东西、值不值得花时间，一眼给结论；不感兴趣就直说，水货直接说「不值当」，别硬夸。'

/** 所有可配置项的默认值；HTTP 保存时只接受这里出现过的 key */
export const DEFAULT_CONFIG = {
  /** 人设名字（名字本身是人设的一部分） */
  personaName: '小肥鱼',
  /** 人设 / 说话方式 */
  persona: DEFAULT_PERSONA,
  /** 对主人的另一套人设（双人设）：私聊主人时用这份，留空则沿用 persona */
  personaOwner: '',
  /** 主人 QQ 号：只有这个号能用「昵称别名」（鱼宝、宝宝）叫她；正式名字谁叫都算 */
  ownerQq: '',
  /** 主人 B 站 UID（她发 B 站私信的目标） */
  ownerBiliMid: '',
  /** OneBot 11 WebSocket 地址（NapCat 的 ws 服务端） */
  wsUrl: '',
  /** OneBot access_token（可空） */
  wsToken: '',
  /** 自动回复总开关（默认关：先扫码、确认人设，再手动开） */
  autoReply: false,
  /** 识图：把聊天里收到的图片交给模型「看」（默认关，开了才会下载并作为视觉输入） */
  /** 多图拼成一张再给模型看：省视觉 token（需要本机有 ffmpeg，没有就自动逐张） */
  imagePack: true,
  imageView: false,
  /** 自己发图：允许模型在回复里用 [[img:URL]] 发表情包/图片（默认关） */
  imageReply: false,
  /** 群里也发图：关掉后只在私聊发图/表情（前端有开关，之前不在默认配置里导致改了不生效） */
  imageReplyInGroup: true,
  /** 发图规则：追加给模型的一段「什么图能发、什么图别发」的说明（最多 1200 字） */
  imageRulesText: '',
  /** 发图上限：每会话每小时最多发几张（防刷图） */
  imageReplyMaxPerHour: 6,
  /** 发语音时顺手配一张表情包的概率（0 = 从不，1 = 每条语音都配） */
  voiceStickerChance: 0.6,
  /** 纯文字回复时顺手配表情包的概率（0 = 从不） */
  textStickerChance: 0.4,
  // ── 心情 / 日记 / 复盘 / 承诺 / B站日报 / 双模式 / 尺度 ──────────────────
  /** 心情系统：她被哄/被骂/被撩之后，情绪会真的变化并影响语气 */
  moodEnabled: true,
  /** 日记：每天让她自己写一段今天的事 */
  diaryEnabled: true,
  /** 几点写日记（0-23） */
  diaryHour: 23,
  /** 日/周/月复盘 */
  reviewEnabled: true,
  /** 周复盘在星期几做（0=周日） */
  reviewWeeklyDay: 0,
  /** 月复盘在每月几号做（1-28） */
  reviewMonthlyDay: 1,
  /** 承诺机制：她说"明天告诉你"这种，会被记下来并提醒 */
  promiseEnabled: true,
  /** B站日报 */
  biliDailyEnabled: false,
  /** 几点生成 B站日报（0-23） */
  biliDailyHour: 9,
  /** B站自己逛：按日程表排时间（每天几个时间点，到点只刷一次）；关掉=退回旧的随机概率 */
  biliAutoWatch: true,
  /** 每天安排几个刷视频的时间点（1-8） */
  biliWatchPerDay: 4,
  /** 自己逛的冷却：两次之间至少多少分钟（与主动消息同档） */
  biliWatchMinGapMinutes: 180,
  /** 自己逛的每日上限 */
  biliWatchDailyMax: 4,
  /** 主人刚说完话多久内不去刷视频（分钟） */
  biliWatchOwnerIdleMinutes: 30,
  /** B站口味关键词（逗号分隔，空=用热门榜） */
  biliTasteKeywords: '',
  /** B站排除关键词（逗号分隔，标题含这些就不推） */
  biliExcludeKeywords: '',
  /** 双模式：daily=纯聊天（无干活权限），work=完整 Agent */
  chatMode: 'daily',
  // ── 表情包挑图策略（参考 ohwhale）──────────────────────────
  /** 两次发表情包的最短间隔（秒） */
  stickerCooldownSec: 45,
  /** 每天最多发几张 */
  stickerMaxPerDay: 25,
  /** 语义匹配阈值（低于这个宁可不发） */
  stickerMinScore: 0.45,
  // ── 语音识别（ASR）──────────────────────────────────
  asrEnabled: false,
  asrProvider: 'siliconflow',
  asrApiKey: '',
  asrEndpoint: '',
  asrModel: '',
  asrLanguage: 'zh',
  asrForBili: false,
  /** 向量记忆：硅基流动 bge-m3（免费层），key 填了才会启用语义检索 */
  embeddingKey: '',
  /** 天气：优先使用这里的坐标（空则用 IP 定位兜底） */
  /** 群聊静音截止时间（毫秒时间戳，0=不静音）：到点自动恢复；不在白名单里会被 loadConfig 过滤 */
  groupMuteUntil: 0,
  /** 提示词预算（字符）：system 超过它会被裁剪；以前不在白名单里，每次 saveConfig 都被抹掉 */
  promptBudgetChars: 10000,
  weatherCity: '',
  weatherGeoSource: "",
  weatherLat: '',
  weatherLon: '',
  /** 高德 Web服务 key：把坐标反查成「区·街道」（示例） */
  weatherAmapKey: '',
  embeddingModel: 'BAAI/bge-m3',
  asrBiliMaxSeconds: 900,
  /** B站：刷完是否顺手点赞（默认关，怕留太多痕迹） */
  biliAutoLike: false,
  /** B站：刷完是否收藏（默认关） */
  biliAutoFav: false,
  /** B站：让她在自己号上发动态（默认开，限额见 biliDynamicPerDay） */
  biliAutoDynamic: true,
  /** B站：每天最多发几条动态 */
  biliDynamicPerDay: 1,
  /** B站：是否允许在他自己的视频下评论（默认开，只在他视频下） */
  biliAutoComment: true,
  /** B站：每天最多评论几条（不限制就写大一点，上限 200） */
  commentPerDay: 40,
  /** B站：两条评论之间至少隔多久（分钟） */
  commentMinGapMinutes: 8,
  /** B站：每次到点真去评论的概率 */
  commentChance: 0.55,
  /** B站：别人（默认只认主人）回她评论时，她要不要接话 */
  biliCommentReplyEnabled: true,
  /** B站：多久查一次评论回复（分钟） */
  biliCommentReplyMinutes: 4,
  /** B站：一次最多接几条 */
  biliCommentReplyMaxPerTick: 3,
  /** B站：有人在评论区 @ 她时，她要不要回 */
  biliAtReplyEnabled: true,
  /** B站：多久查一次「@ 我的」（分钟） */
  biliAtReplyMinutes: 5,
  /** B站：一轮最多回几个 @ */
  biliAtReplyMaxPerTick: 2,
  /** B站：超过多少小时的 @ 不补回 */
  biliAtReplyMaxAgeHours: 6,
  /** B站：评论范围——owner=只评他的视频；watched=她刷到/看过的视频也能评；off=不评 */
  biliCommentScope: 'watched',
  /** B站：评论末尾自动 @ 主人 */
  biliCommentAt: true,
  /** B站：主人的 B 站昵称（@ 用，要和 B 站上完全一致才会真的提醒到；留空 = 不 @） */
  ownerBiliName: '',
  /** B站：她自己在 B 站上的昵称（用于把别人 @ 她时带上的那句话去掉；留空 = 用 personaName） */
  selfBiliName: '',
  /** 机器人自己的 QQ（脱敏用；留空则只脱敏主人/管理员相关的号） */
  selfQq: '',
  /** B站：主人的私信要不要回（对齐 AstrBot 的 ENABLE_PRIVATE_MESSAGES） */
  biliDmReply: true,
  /** B站：多久查一次私信（分钟） */
  biliDmPollMinutes: 10,
  /** B站：一次最多回几条 */
  biliDmMaxPerPoll: 3,
  /** B站：一天最多回几条 */
  biliDmMaxPerDay: 20,
  /** B站：每天/每周跟他复盘一次今天在 B 站干了什么 */
  biliSummaryEnabled: true,
  biliSummaryHour: 23,
  biliSummaryWeekday: 6,
  // ── B 站自动行为的时间管理（2026-11-12）────────────────────────────
  /**
   * B站：睡眠闸门总开关。开着时所有 B 站自动行为（自己逛/分享/动态/评论/私信/@回复/
   * 评论接话/日报）都先过 biliAutoAllowed()：她的作息睡眠窗口 + vitals.asleep +
   * 主人手填的静默 + 安静时段，任一判定为睡就跳过。关掉 = 回到旧行为（会半夜刷）。
   */
  biliSleepGate: true,
  /**
   * B站：主人熬夜例外。开着时，如果主人半夜还在跟她说话（默认 30 分钟内），
   * 她可以跟着醒着、可以刷 B 站——「不要每天晚上刷，如果他晚上决定熬夜可以晚上刷」。
   * 关掉 = 夜间一律不刷（她真的睡着了这条不受影响，永远不刷）。
   */
  biliOwnerNightAwake: true,
  /** 主人最后一条消息在多少分钟内算「他还在熬夜」 */
  biliOwnerNightAwakeMinutes: 30,
  /**
   * B站自己逛：**由她自己决定刷不刷**（默认开）。
   * 开着时把此刻处境摆给她看、问她一句「想刷吗」，她说刷才刷——包括半夜。
   * 关掉 = 退回 AstrBot 那套「每天固定几个时间点到点就刷」的定时表。
   */
  biliWatchSelfDirected: true,
  /** 问她「想刷吗」的最短间隔（分钟）——避免每个 tick 都花一次模型调用 */
  biliWillAskMinutes: 90,
  /** 主人最后一条消息在多少分钟内算「他还醒着」（夜里她可以陪他刷） */
  biliOwnerAwakeMinutes: 45,
  /** B站自己逛：按日程时间表触发（biliWatchSelfDirected=false 时才有意义） */
  biliWatchSchedule: true,
  /** B站自己逛：每天排几个时间点（3~5） */
  biliWatchSlots: 4,
  /** B站分享：两次之间的最小间隔（分钟） */
  biliShareMinGapMinutes: 120,
  /** B站分享：两次之间的最大间隔（分钟） */
  biliShareMaxGapMinutes: 240,
  /** B站分享：每天最多几条（0 = 不限） */
  biliSharePerDay: 2,
  /** 尺度：0=克制 1=暧昧 2=敢开 3=老司机随便上高速 */
  spiceLevel: 3,
  /** 发表情包前先让它自己看图：图和这句话配不配，不配就换/不发 */
  stickerReview: true,
  /** 收藏表情包前先看图判断：是表情包才收，截图/照片不收 */
  stickerJudge: true,
  /** 看懂视频：把聊天里的视频抽帧成几张图交给模型（需要 ffmpeg，见 videoViewNote） */
  videoView: true,
  /** 视频下载上限（MB）：超过就不下载，只当普通消息处理 */
  videoMaxMb: 30,
  /** 抽几帧交给模型看（拼成一张网格图） */
  videoFrames: 6,
  /** 单条视频最长多少秒（超过只取前 N 秒；0 = 不限） */
  videoMaxSeconds: 120,
  /** 上下文记忆：每次回复时注入多少条同会话历史（越大越记得住，也越费 token） */
  contextMessages: 20,
  /** 长期记忆：手动记下的事实/约定，每条每次都会进提示词（[{ id, text, at }]） */
  memories: [],
  // ── 拟真（像真人用 QQ）──────────────────────────────────────────────
  /** 拟真总开关：按字数模拟打字延迟 + 长回复拆成多条气泡 */
  humanizeEnabled: true,
  /** 每个字模拟多少毫秒的打字时间 */
  typingPerCharMs: 90,
  /** 单条回复最多模拟多少毫秒（防止长文等太久） */
  typingMaxMs: 6000,
  /** 把长回复拆成多条气泡（真人很少一次性发一大段） */
  splitBubbles: true,
  /** 最多拆成几条 */
  splitMaxBubbles: 4,
  /** 分条之间的间隔下限（毫秒） */
  bubbleGapMinMs: 700,
  /** 分条之间的间隔上限（毫秒） */
  bubbleGapMaxMs: 2200,
  // ── 消息合并（移植自 AstrBot astrbot_betterchat）──────────────────────
  /** 私聊合并：连续打字时先不回复，等静默窗口结束再把整串消息合并成一条输入 */
  mergeMessages: true,
  /** 静默窗口基准秒数：从最后一条消息算起，安静这么久就认为说完了 */
  mergeBaseQuietSeconds: 2.0,
  /** 静默窗口下限（秒）：再短也不低于这个，防止刚发两个字就被抢答 */
  mergeMinQuietSeconds: 1.5,
  /** 静默窗口上限（秒） */
  mergeMaxQuietSeconds: 4.0,
  /** 整轮硬上限（秒）：从第一条算起最多等这么久 */
  mergeTotalSeconds: 8.0,
  /** 长度换算：每 N 字把静默窗口 +1 秒 */
  mergeLengthScaleChars: 60,
  /** 单轮最多合并几条 */
  mergeMaxMessages: 8,
  /** 单轮最多合并多少字 */
  mergeMaxChars: 4000,
  /** 不参与合并的指令前缀（逗号分隔） */
  mergeIgnorePrefixes: '/,!',
  /** 静默跟随作息：用她的「睡觉→起床」当静默时段（关掉才用下面两个手填值） */
  silenceFollowSchedule: true,
  /** 深夜静默起始小时（0-23；等于结束小时则关闭） */
  nightSilenceStart: 1,
  /** 深夜静默结束小时（0-23） */
  nightSilenceEnd: 7,
  /**
   * 群聊接话方式：
   *   mention = 只回 @ 我的消息（默认，最省心）
   *   smart   = 只接「感兴趣的话题」（关键词 + 模型判断），受频率限制
   *   all     = 每条群消息都接（不推荐，容易刷屏/被风控）
   */
  groupReplyMode: 'mention',
  /** smart 模式的兴趣关键词（逗号/换行分隔；留空 = 全部交给模型判断） */
  groupKeywords: '',
  /** smart 模式下，是否先用模型判断「这条要不要插话」 */
  groupSmartJudge: true,
  /** 「每条都接」模式下也让她自己想一想：这条要不要接 */
  groupThink: true,
  /** 每个群每分钟最多思考几次 */
  groupThinkPerMinute: 8,
  /** 判断「要不要接」时带几条上文（0 = 不带，只看这一句） */
  groupThinkContext: 6,
  /** 同一个群两次接话的最短间隔（秒） */
  groupMinIntervalSec: 120,
  /** 同一个群每小时最多接几句（0 = 不主动接非 @ 话题） */
  groupMaxPerHour: 6,
  /** 候选群消息的接话概率（0-100） */
  groupReplyChance: 100,
  /** 兼容旧字段：true 等同 groupReplyMode='all'（新配置不再写入，仅读取时迁移） */
  autoReplyGroups: false,
  /** 主动推送总开关 */
  pushEnabled: false,
  /** 碎碎念总开关 */
  whisperEnabled: false,
  /** 自动说说：按心情和今天发生的事，自己往 QQ 空间发一条 */
  qzoneAutoPost: true,
  /** 自动说说每天最多几条（0 = 不发） */
  qzoneAutoPostPerDay: 1,
  /** 两条说说之间至少隔几小时 */
  qzoneAutoPostMinGapHours: 5,
  /** 允许发说说的时段（24h 本地时区） */
  qzoneAutoStart: 9,
  qzoneAutoEnd: 23,
  /** 心情偏离基准到多少才算「有情绪想发」 */
  qzoneAutoMoodThreshold: 0.45,
  /** 发完在 QQ 里告诉主人一声 */
  qzoneNotifyOwner: true,
  qzoneScroll: true,
  qzoneScrollMinGapHours: 2,
  qzoneScrollMaxActions: 6,
  qzoneScrollStart: 8,
  qzoneScrollEnd: 24,
  /** 说说配图张数（0=纯文字，默认 1） */
  qzonePostImages: 1,
  /** 说说配图由她自己生成（关掉则从表情包库里挑） */
  qzoneGenImages: true,
  /** 生图服务：ark（火山方舟 Seedream）/ siliconflow */
  imageGenProvider: 'ark',
  /** 生图 key（火山方舟 ark-xxx 或硅基流动 sk-xxx） */
  imageGenKey: '',
  /** 生图模型 */
  imageGenModel: 'doubao-seedream-4-0-20260415',
  /** 生图尺寸 */
  imageGenSize: '1024x1024',
  /** 生图时带上官方形象参考图（~/.dsh/qq-fish/self/ref-*.jpg），保证是同一个人；关掉=纯文生图 */
  imageGenUseRef: true,
  /** 说说可见范围：1 所有人 / 4 好友 / 64 仅自己 */
  qzoneUgcRight: 1,
  /** 隐私模式：面板/日志只显示脱敏后的内容 */
  privacyMode: true,
  /** 聊天记录最多保留多少条（超过后滚动丢弃最旧的） */
  maxHistory: 3000,
  /** 主动推送/碎碎念允许的时间段（24h，本地时区），默认 09:00–23:00 */
  activeStart: 9,
  activeEnd: 23,
  /** 主动推送前先让她自己判断「这时候该不该主动找他」 */
  pushSelfCheck: true,
  /** 主动推送最短间隔（分钟） */
  pushMinIntervalMinutes: 90,
  /** 碎碎念最短间隔（分钟） */
  whisperMinIntervalMinutes: 45,
  /** 单条 QQ 消息最大字数（超出截断，避免刷屏） */
  maxReplyChars: 400,
  // ── 自主学习 / 认人 / 反重复 ─────────────────────────────────────────
  /** 自主学习总开关：让她自己从聊天里记「人和事」（只补事实，不改人格） */
  autoLearn: true,
  /** 每收多少条消息自动学一次（每个会话单独计数） */
  autoLearnEvery: 15,
  /** 学到的记忆最多存多少条（超出按分数丢掉最旧、最不常用的） */
  autoLearnMaxItems: 240,
  /** 反重复：回复和她最近说过的话太像时，自动重写一次 */
  repetitionGuard: true,
  /** @ 强制：对方让你 @ 人时必须真的 @；@名字 自动转成 [at:QQ号] */
  atEnforce: true,
  // ── 人格演化 ───────────────────────────────────────────────────
  /** 作息开关：让她有自己的白天黑夜，并会自己微调 */
  scheduleEnabled: true,
  /** 多久评估一次作息（小时） */
  scheduleEvolveHours: 24,
  /** 人格演化开关：让她从聊天里自己长出性格变化（只附加，不改原始人格） */
  evolveEnabled: true,
  /** 每收多少条消息评估一次人格变化 */
  evolveEvery: 30,
  /** 最多保留多少条性格变化（防漂移） */
  evolveMaxTraits: 12,
  /** 你自己设定的原始人格（基准），随时可以一键恢复；空 = 还没存过 */
  personaOriginal: '',
  // ── 访问控制（面板「访问」页可调）──────────────────────────────
  /** 管理员 QQ 号（只认一个）：永远放行，不受白名单限制 */
  accessAdminId: '',
  /** 旧字段（多值），只读兼容：accessAdminId 为空时取第一个 */
  accessAdminIds: '',
  /** 启用白名单：只有名单里的群号/QQ 号会话才会被她响应 */
  accessWhitelistEnabled: false,
  /** 白名单 ID：群号或 QQ 号，逗号/换行分隔 */
  accessWhitelist: '',
  /** 允许不在名单里的人私聊她（关掉 = 陌生人私聊一律不理） */
  accessAllowStrangerPrivate: true,
  /** 被拦截的会话是否写日志（排查「她为什么不回」用） */
  accessBlockLog: true,
  /** 群聊与私信互通：把另一个会话里同一个人的话带进上下文 */
  crossContext: true,
  // 跨群原文检索（隐私相关，默认开但只查本人消息）
  crossSearchEnabled: true,
  // 允许检索的群（逗号分隔群号，空 = 全部允许）
  crossSearchAllowGroups: '',
  // 最多查几个群（1-6）
  crossSearchMaxGroups: 3,
  // 审计日志（记录每次检索，便于回溯）
  crossSearchAudit: true,
  // ── 口吻（面板「口吻」页可调）─────────────────────────────────────
  /** 回复长度：short 默认短 / normal 正常 / long 可以多说 */
  styleLength: 'short',
  /** 毒舌强度 0~2 */
  styleSass: 1,
  /** 卖萌程度 0~2 */
  styleCute: 0,
  /** 动作神态 0 不要 / 1 偶尔 / 2 多一点 */
  styleAction: 0,
  /** 允许「草、靠、淦」这类粗口（旧字段，保留兼容） */
  styleSwear: true,
  /** 爆粗档位：off 不说 / light 轻度 / mid 中度 / custom 自定义词表 */
  styleSwearLevel: 'light',
  /** 自定义爆粗词表（逗号分隔，最多 12 个） */
  styleSwearWords: '',
  /** 允许敷衍（哦、？、行吧） */
  styleFiller: true,
  /** 偶尔自嘲「少背点台词」 */
  styleSelfMock: true,
  /** 自定义口吻：主人手写的一段规矩，优先级最高 */
  styleCustomText: '',
  // ── 戳一戳 ─────────────────────────────────────────────────────────
  /** 被戳一戳时回一句（关掉就完全不理） */
  pokeReply: true,
  /** 回她的同时，也回戳对方一下 */
  pokeBack: true,
  /** 同会话两次戳一戳回复的最短间隔（秒），防连戳刷屏 */
  // 语音合成（edge-tts / 豆包 Seed Audio / BreezeBlue）
  voiceReply: false,
  // 语音引擎：'' 或 'auto' = 有豆包先用豆包，其次 Breeze，最后 edge
  ttsProvider: '',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsStyle: 'cute',
  // 语音积极性：low = 几乎不说话 / normal = 情绪浓才说 / high = 很爱说话 / always = 能说就说
  voiceEagerness: 'normal',
  pokeCooldownSec: 20,
  /** 自定义：被戳时该怎么反应（手写规矩，进她的提示词） */
  pokeRulesText: '',
  // ── 被叫名字 ───────────────────────────────────────────────────────
  /** 群里有人叫她的名字就回（不用非得 @），等于把「叫名字」当成点名 */
  nameCallReply: true,
  /** 她的别名（逗号分隔，除了 personaName 之外还算数的叫法，如「蓝鱼、肥鱼」） */
  nameCallAliases: '',
  /** 昵称别名（鱼宝/宝宝）只有主人能叫；关掉则群里谁叫都算 */
  nameCallOwnerOnly: true,
  /** 神经-体液：张力阈值（越低越容易主动找你）50-99 */
  /** 黑名单：这些 QQ 号说的话一律不处理（逗号分隔） */
  blacklist: '',
  /** 群聊参与风格：quiet 少说话 / normal 正常 / active 积极 */
  groupStyle: 'normal',
  /** 群聊响应等级 0-100：0=只回@ 25=+关键词 50=按判断 75=更积极 100=几乎全回 */
  replyLevel: 50,
  organicThreshold: 85,
  /** 神经-体液：基础累积速率（点/分钟）0.2-2.5 */
  organicRate: 0.75,
  /** 每小时最多主动发几条（含碎碎念），防骚扰 */
  maxProactivePerHour: 4,
  // 记忆卡参数（面板可自定义）
  memoryCard: {},
  // 目的机制参数（面板可自定义）
  purpose: {},
  /** 模型：留空 = 跟随当前对话的默认模型 */
  modelProvider: '',
  /** 模型优先级链：provider/model 逗号分隔，前一个不可用才换下一个 */
  modelChain: '',
  model: '',
  /** 主动推送目标：{ kind:'private'|'group', id:'<QQ号/群号>', name:'显示名' }；null = 最近私聊对象 */
  pushTarget: null,
  /** 碎碎念目标：同上；null = 跟随 pushTarget */
  whisperTarget: null,
  /** 主动推送最短间隔之外，是否只在有人聊过天才发（默认 true，避免对陌生人忽然开口） */
  pushOnlyAfterTalk: true,
  /** DSH 重启后自动拉起托管的 NapCat 并重连（默认开，因为用户装完就该"一直在"） */
  autoStart: true,
  /** 桥接模式：managed = 插件托管 NapCat；external = 用户已有 NapCat（填 wsUrl） */
  onebotMode: 'managed',
  /** 进阶路径：已有 NapCat 的 WebUI 地址与 token（token 只存本地） */
  webuiUrl: '',
  webuiToken: '',
  /** GitHub 下载加速镜像（留空 = 自动依次尝试：直连 → gh-proxy.com → ghproxy.net） */
  napcatMirror: '',
  /** 最近一次成功登录的账号（脱敏展示） */
  account: null,
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stateHome() {
  const dir = join(dshHome(), 'qq-fish')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function pathOf(name) {
  return join(stateHome(), name)
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function appendJsonLine(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
}

export function readJsonLines(file, limit) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const slice = typeof limit === 'number' && limit > 0 ? lines.slice(-limit) : lines
  const out = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // 坏行直接跳过：聊天记录不值得因为一行损坏整个面板
    }
  }
  return out
}

/** 当前配置（缺失字段用默认值补齐，并顺手把缺失的默认值落盘一次） */
export function loadConfig() {
  const file = pathOf('config.json')
  const stored = readJson(file, null)
  const config = { ...DEFAULT_CONFIG }
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (!(key in DEFAULT_CONFIG)) continue
      if (value === undefined || value === null) continue
      config[key] = value
    }
    // 旧配置迁移：以前「群里也回」开关 = true 时等于每条都回；升级后改为 smart，
    // 由关键词/模型判断是否感兴趣，并用频率限制兜底（否则升级后继续刷屏）。
    if (stored.groupReplyMode === undefined && stored.autoReplyGroups === true) {
      config.groupReplyMode = 'smart'
    }
    if (!['mention', 'smart', 'all'].includes(config.groupReplyMode)) config.groupReplyMode = 'mention'
  }
  if (!existsSync(file)) writeJsonAtomic(file, config)
  return config
}

/** 允许用 null 显式清空的字段（「自动：跟随默认」这类设置要靠 null 表达） */
const NULLABLE_KEYS = new Set(['pushTarget', 'whisperTarget'])

/** 只允许改白名单里的字段；返回新配置 */
export function saveConfig(patch) {
  const config = loadConfig()
  const next = { ...config }
  const patchObj = { ...(patch || {}) }
  // 兼容旧面板：只传 autoReplyGroups 时换算成新的 groupReplyMode
  if ('autoReplyGroups' in patchObj && !('groupReplyMode' in patchObj)) {
    patchObj.groupReplyMode = patchObj.autoReplyGroups === true ? 'all' : 'mention'
  }
  for (const [key, value] of Object.entries(patchObj)) {
    if (!(key in DEFAULT_CONFIG)) continue
    // 人格基准是存档，绝不允许被空值覆盖（否则一次误操作就没了）
    if (key === 'personaOriginal' && !String(value || '').trim()) continue
    if (value === null) {
      // 只有 nullable 字段允许清空；其余字段传 null 视为「不改」
      if (NULLABLE_KEYS.has(key)) next[key] = null
      continue
    }
    next[key] = clampSetting(key, value)
  }
  writeJsonAtomic(pathOf('config.json'), next)
  return next
}

/** 配置值的粗校验/钳制：宁可口径宽松，也不能因为一个坏值让整条插件不激活 */
export function clampSetting(key, value) {
  const num = (min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  switch (key) {
    case 'humanizeEnabled':
    case 'splitBubbles':
      return value === true
    case 'videoView':
      return value === true
    case 'videoMaxMb':
      return num(1, 200)
    case 'videoFrames':
      return num(2, 9)
    case 'videoMaxSeconds':
      return num(0, 3600)
    case 'typingPerCharMs':
      return num(20, 300)
    case 'typingMaxMs':
      return num(500, 20000)
    case 'splitMaxBubbles':
      return num(1, 5)
    case 'bubbleGapMinMs':
      return num(200, 10000)
    case 'bubbleGapMaxMs':
      return num(200, 15000)
    // ── 消息合并 ──────────────────────────────────────────────────────
    case 'mergeMessages':
      return value === true
    case 'mergeBaseQuietSeconds':
      return num(0.5, 10)
    case 'mergeMinQuietSeconds':
      return num(0.5, 10)
    case 'mergeMaxQuietSeconds':
      return num(0.5, 10)
    case 'mergeTotalSeconds':
      return num(1, 60)
    case 'mergeLengthScaleChars':
      return num(0, 500)
    case 'mergeMaxMessages':
      return num(1, 50)
    case 'mergeMaxChars':
      return num(100, 20000)
    case 'mergeIgnorePrefixes':
      return String(value || '').slice(0, 100)
    case 'silenceFollowSchedule':
      return value === true
    case 'nightSilenceStart':
    case 'nightSilenceEnd':
      return num(0, 23)
    case 'imageRulesText':
      return String(value || '').slice(0, 1200)
    case 'personaName':
      return String(value).trim().slice(0, 24) || '小肥鱼'
    case 'persona':
      return String(value).slice(0, 40000)
    case 'personaOwner':
      return String(value || '').slice(0, 40000)
    case 'ownerQq':
      return String(value || '').replace(/\D/g, '').slice(0, 12)
    case 'wsUrl': {
      const text = String(value).trim()
      if (text === '') return ''
      return /^wss?:\/\//i.test(text) ? text.slice(0, 300) : ''
    }
    case 'webuiUrl': {
      const text = String(value).trim()
      if (text === '') return ''
      return /^https?:\/\//i.test(text) ? text.slice(0, 300) : ''
    }
    case 'webuiToken':
      return String(value).trim().slice(0, 300)
    case 'napcatMirror': {
      const text = String(value).trim()
      if (text === '') return ''
      return /^https?:\/\//i.test(text) ? text.slice(0, 300) : ''
    }
    case 'onebotMode':
      return value === 'external' ? 'external' : 'managed'
    case 'wsToken':
      return String(value).trim().slice(0, 300)
    case 'maxHistory':
      return num(50, 20000)
    case 'activeStart':
    case 'activeEnd':
      return num(0, 23)
    case 'pushSelfCheck':
      return value === true
    case 'pushMinIntervalMinutes':
      return num(15, 24 * 60)
    case 'whisperMinIntervalMinutes':
      return num(15, 24 * 60)
    case 'imageReplyMaxPerHour':
    case 'stickerCooldownSec':
      return num(0, 3600)
    case 'stickerMaxPerDay':
      return num(1, 200)
    case 'stickerMinScore':
      return Math.max(0, Math.min(1, Number(value) || 0))
    case 'asrEnabled':
    case 'asrForBili':
      return value === true
    case 'asrProvider':
      return ['siliconflow', 'groq', 'openai', 'custom'].includes(value) ? value : 'siliconflow'
    case 'asrApiKey':
    case 'asrEndpoint':
    case 'asrModel':
    case 'asrLanguage':
      return String(value || '').slice(0, 500)
    case 'weatherCity':
      return String(value || '').slice(0, 40)
    case 'weatherLat':
    case 'weatherLon':
      return String(value || '').slice(0, 20)
    case 'weatherAmapKey':
      return String(value || '').slice(0, 64)
    case 'embeddingKey':
    case 'embeddingModel':
      return String(value || '').slice(0, 200)
    case 'asrBiliMaxSeconds':
      return num(60, 3600)
    case 'biliAutoLike':
    case 'biliAutoFav':
    case 'biliAutoDynamic':
    case 'biliAutoComment':
      return value === true
    case 'biliDynamicPerDay':
      return num(0, 5)
    case 'commentPerDay':
      return num(0, 200)
    case 'commentMinGapMinutes':
      return num(1, 720)
    case 'commentChance': {
      const v = Number(value)
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5
    }
    case 'biliCommentReplyEnabled':
      return value === true
    case 'biliCommentReplyMinutes':
      return num(1, 240)
    case 'biliCommentReplyMaxPerTick':
      return num(1, 5)
    case 'biliAtReplyEnabled':
      return value === true
    case 'biliAtReplyMinutes':
      return num(1, 240)
    case 'biliAtReplyMaxPerTick':
      return num(1, 4)
    case 'biliAtReplyMaxAgeHours':
      return num(1, 72)
    case 'biliCommentScope': {
      const sc = String(value || '')
      return sc === 'owner' || sc === 'off' ? sc : 'watched'
    }
    case 'biliCommentAt':
      return value === true
    case 'ownerBiliName':
    case 'selfBiliName':
      return String(value || '').replace(/[<>\n\r]/g, '').slice(0, 40)
    case 'selfQq':
      return String(value || '').replace(/[^0-9]/g, '').slice(0, 20)
    case 'biliDmReply':
      return value === true
    case 'biliDmPollMinutes':
      return num(3, 240)
    case 'biliDmMaxPerPoll':
      return num(1, 5)
    case 'biliDmMaxPerDay':
      return num(0, 50)
    case 'biliSummaryEnabled':
      return value === true
    case 'biliSummaryHour':
      return num(0, 23)
    case 'biliSummaryWeekday':
      return num(0, 6)
    case 'biliSleepGate':
    case 'biliWatchSchedule':
    case 'biliOwnerNightAwake':
    case 'biliWatchSelfDirected':
      return value === true
    case 'biliWillAskMinutes':
      return num(20, 720)
    case 'biliOwnerAwakeMinutes':
      return num(5, 240)
    case 'biliOwnerNightAwakeMinutes':
      return num(5, 240)
    case 'biliWatchMaxGapMinutes':
      return num(15, 24 * 60)
    case 'biliWatchSlots':
      return num(3, 5)
    case 'biliShareMinGapMinutes':
      return num(30, 24 * 60)
    case 'biliShareMaxGapMinutes':
      return num(30, 24 * 60)
    case 'biliSharePerDay':
      return num(0, 12)
    case 'moodEnabled':
    case 'diaryEnabled':
    case 'reviewEnabled':
    case 'promiseEnabled':
    case 'biliDailyEnabled':
      return value === true
    case 'diaryHour':
    case 'biliDailyHour':
      return num(0, 23)
    case 'biliAutoWatch':
      return value === true
    case 'biliWatchPerDay':
      return num(1, 8)
    case 'biliWatchMinGapMinutes':
      return num(30, 1440)
    case 'biliWatchDailyMax':
      return num(1, 24)
    case 'biliWatchOwnerIdleMinutes':
      return num(5, 240)
    case 'reviewWeeklyDay':
      return num(0, 6)
    case 'reviewMonthlyDay':
      return num(1, 28)
    case 'biliTasteKeywords':
    case 'biliExcludeKeywords':
      return String(value || '').slice(0, 500)
    case 'chatMode':
      return value === 'work' ? 'work' : 'daily'
    case 'spiceLevel':
      return num(0, 3)
    case 'voiceStickerChance':
    case 'textStickerChance':
      return Math.max(0, Math.min(1, Number(value)))
      return num(1, 60)
    case 'stickerReview':
      return value === true
    case 'stickerJudge':
      return value === true
    case 'maxReplyChars':
      return num(60, 2000)
    case 'autoLearn':
    case 'repetitionGuard':
    case 'atEnforce':
    case 'pokeReply':
    case 'pokeBack':
      return value === true
    case 'pokeCooldownSec':
      return num(0, 600)
    case 'evolveEnabled':
      return value === true
    case 'scheduleEnabled':
      return value === true
    case 'scheduleEvolveHours':
      return num(4, 168)
    case 'evolveEvery':
      return num(10, 500)
    case 'evolveMaxTraits':
      return num(4, 30)
    case 'personaOriginal':
      return String(value || '').slice(0, 40000)
    case 'accessAdminId':
      return String(value || '').replace(/\D/g, '').slice(0, 12)
    case 'accessAdminIds':
      return String(value || '').slice(0, 2000)
    case 'accessWhitelist':
      return String(value || '').slice(0, 2000)
    case 'accessWhitelistEnabled':
    case 'accessAllowStrangerPrivate':
    case 'accessBlockLog':
    case 'crossContext':
      return value === true
    case 'styleLength':
      return ['short', 'normal', 'long'].includes(value) ? value : 'short'
    case 'styleSass':
    case 'styleCute':
    case 'styleAction':
      return num(0, 2)
    case 'styleSwear':
    case 'styleFiller':
    case 'styleSelfMock':
      return value === true
    case 'styleSwearLevel':
      return ['off', 'light', 'mid', 'custom'].includes(value) ? value : 'light'
    case 'styleSwearWords':
      return String(value || '').slice(0, 200)
    case 'styleCustomText':
      return String(value || '').slice(0, 1200)
    case 'pokeRulesText':
      return String(value || '').slice(0, 1200)
    case 'nameCallReply':
      return value === true
    case 'nameCallAliases':
      return String(value || '').slice(0, 200)
    case 'nameCallOwnerOnly':
      return value !== false
    case 'blacklist':
      return String(value || '').replace(/[^0-9,，;；\s]/g, '').slice(0, 400)
    case 'replyLevel':
      return Math.min(100, Math.max(0, Number(value) || 50))
    case 'groupStyle':
      return ['quiet', 'normal', 'active'].includes(String(value)) ? String(value) : 'normal'
    case 'organicThreshold':
      return Math.min(99, Math.max(50, Number(value) || 85))
    case 'organicRate':
      return Math.min(2.5, Math.max(0.2, Number(value) || 0.75))
    case 'autoLearnEvery':
      return num(4, 200)
    case 'autoLearnMaxItems':
      return num(20, 2000)
    case 'maxProactivePerHour':
      return num(0, 20)
    case 'modelChain':
      return String(value || '').slice(0, 600)
    case 'modelProvider':
    case 'model':
      return String(value).trim().slice(0, 120)
    case 'imageReply':
    case 'imageReplyInGroup':
    case 'privacyMode':
    case 'autoReply':
    case 'autoReplyGroups':
    case 'groupThink':
      return value === true
    case 'groupThinkPerMinute':
      return num(0, 60)
    case 'groupThinkContext':
      return num(0, 30)
    case 'groupSmartJudge':
    case 'pushEnabled':
    case 'whisperEnabled':
    case 'qzoneAutoPost':
    case 'qzoneScroll':
    case 'qzoneNotifyOwner':
    case 'pushOnlyAfterTalk':
    case 'autoStart':
      return value === true
    case 'groupReplyMode':
      return ['mention', 'smart', 'all'].includes(value) ? value : 'mention'
    case 'groupKeywords':
      return String(value || '').slice(0, 2000)
    case 'groupMinIntervalSec':
      return num(10, 3600)
    case 'qzoneAutoPostPerDay':
      return num(0, 3)
    case 'qzonePostImages':
      return num(0, 3)
    case 'qzoneGenImages':
      return value === true
    case 'imageGenProvider':
      return ['ark', 'siliconflow'].includes(String(value)) ? String(value) : 'ark'
    case 'imageGenUseRef':
      return value === true
    case 'imageGenKey':
    case 'imageGenModel':
    case 'imageGenSize':
      return String(value || '').slice(0, 200)
    case 'qzoneUgcRight': {
      const n = Number(value)
      return [1, 4, 16, 64, 128].includes(n) ? n : 1
    }
    case 'qzoneAutoPostMinGapHours':
      return num(1, 48)
    case 'qzoneAutoStart':
      return num(0, 23)
    case 'qzoneAutoEnd':
      return num(1, 24)
    case 'qzoneAutoMoodThreshold': {
      const n = Number(value)
      return Number.isFinite(n) ? Math.min(1, Math.max(0.1, n)) : 0.45
    }
    case 'groupMaxPerHour':
      return num(0, 60)
    case 'groupReplyChance':
      return num(0, 100)
    case 'pushTarget':
    case 'whisperTarget': {
      if (!value || typeof value !== 'object') return null
      const kind = value.kind === 'group' ? 'group' : 'private'
      const id = String(value.id || '').replace(/\D/g, '').slice(0, 20)
      if (!id) return null
      return { kind, id, name: String(value.name || '').slice(0, 40) }
    }
    case 'account':
      return value && typeof value === 'object' ? value : null
    default:
      return value
  }
}

/** 消息日志（JSONL；面板只取最近 N 条） */
export function messageLogPath() {
  return pathOf('messages.jsonl')
}

/** 重写消息日志（编辑上下文用）：原子写，空数组时写空文件 */
function rewriteMessageLog(rows) {
  const file = messageLogPath()
  mkdirSync(dirname(file), { recursive: true })
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  writeFileSync(file, text, 'utf8')
}

/** 读某个会话的消息（面板编辑上下文用；ts 作为会话内唯一标识） */
export function conversationMessages(conversation, limit = 200) {
  const key = String(conversation || '')
  const cap = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 200)))
  const rows = readJsonLines(messageLogPath(), 0).filter((m) => m && m.conversation === key)
  return rows.slice(-cap)
}

/** 按 ts 删除某个会话里的若干条消息 */
export function deleteMessages(conversation, tsList) {
  const key = String(conversation || '')
  const want = new Set((Array.isArray(tsList) ? tsList : [tsList]).map((t) => String(t)))
  const rows = readJsonLines(messageLogPath(), 0)
  const kept = rows.filter((m) => !(m && m.conversation === key && want.has(String(m.ts))))
  const removed = rows.length - kept.length
  if (removed > 0) rewriteMessageLog(kept)
  return { removed, remaining: kept.length }
}

/** 清空某个会话的历史（不动别的会话） */
export function clearConversation(conversation) {
  const key = String(conversation || '')
  const rows = readJsonLines(messageLogPath(), 0)
  const kept = rows.filter((m) => !(m && m.conversation === key))
  const removed = rows.length - kept.length
  if (removed > 0) rewriteMessageLog(kept)
  return { removed, remaining: kept.length }
}

/** 每个会话最后一条消息的时间戳（内存态，用于保证同一会话内时间单调递增） */
const lastTsByConversation = new Map()

/**
 * 追加一条聊天记录。
 * 同一会话内强制时间戳单调递增（至少 +1ms）：QQ 事件时间是秒级且可能和本机时钟有偏差，
 * 不这样做会出现「回复的时间戳比它回的那条消息还早」，面板按时间排序时回复会跑到消息前面。
 */
export function appendMessage(record) {
  const next = { ...record }
  // 【防膨胀】消息文本里绝不允许出现 base64 之类的巨型内联数据，否则单条记录能到几 MB
  if (typeof next.text === "string") {
    next.text = next.text.replace(/base64:\/\/[A-Za-z0-9+/=]{100,}/g, "[图片]")
    if (next.text.length > 2000) next.text = next.text.slice(0, 2000)
  }
  const key = String(next.conversation || '')
  let ts = Number(next.ts) || Date.now()
  if (key) {
    const last = lastTsByConversation.get(key) || 0
    if (ts <= last) ts = last + 1
    lastTsByConversation.set(key, ts)
  }
  next.ts = ts
  appendJsonLine(messageLogPath(), next)
  return next
}

export function recentMessages(limit = 300) {
  return readJsonLines(messageLogPath(), limit)
}

/**
 * 修复历史聊天记录（启动时跑一次，幂等）：
 *   1. 同一会话内时间戳强制单调递增——旧版本用 QQ 事件秒级时间 + 本机时钟混用，
 *      可能让“回复”的时间戳小于它回的那条消息，面板按时间排序就乱序了；
 *   2. 旧版本把 CQ 码原文（[CQ:image,...]）当文本存了下来，这里转成 [图片]/[表情] 等可读占位。
 * 只在真的需要修改时写盘，并且先把原文件备份成 messages.jsonl.bak-<时间>。
 * @returns {Promise<{changed:boolean, rows:number, fixedTimestamps:number, fixedCq:number, backup:string}>}
 */
export async function repairMessageLog() {
  const file = messageLogPath()
  const result = { changed: false, rows: 0, fixedTimestamps: 0, fixedCq: 0, backup: '' }
  if (!existsSync(file)) return result
  const raw = readFileSync(file, 'utf8')
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }
  result.rows = rows.length
  if (!rows.length) return result
  const { parseCqMessage } = await import('./onebot.mjs')
  const lastTs = new Map()
  for (const row of rows) {
    const key = String(row.conversation || '')
    let ts = Number(row.ts) || 0
    if (key) {
      const prev = lastTs.get(key) || 0
      if (ts <= prev) {
        ts = prev + 1
        result.fixedTimestamps += 1
      }
      lastTs.set(key, ts)
    }
    row.ts = ts
    if (typeof row.text === 'string' && row.text.includes('[CQ:')) {
      const parsed = parseCqMessage(row.text)
      if (parsed.text !== row.text) {
        row.text = parsed.text
        result.fixedCq += 1
      }
    }
  }
  if (result.fixedTimestamps > 0 || result.fixedCq > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    result.backup = `${file}.bak-${stamp}`
    writeFileSync(result.backup, raw, 'utf8')
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    renameSync(tmp, file)
    lastTsByConversation.clear()
    for (const [key, ts] of lastTs.entries()) lastTsByConversation.set(key, ts)
    result.changed = true
  } else if (rows.length) {
    // 没改文件也把内存里的“最后时间”预热，避免重启后第一条消息时间被错误回退
    for (const [key, ts] of lastTs.entries()) {
      const current = lastTsByConversation.get(key) || 0
      if (ts > current) lastTsByConversation.set(key, ts)
    }
  }
  return result
}

/** 聊天记录瘦身：超过 keep*2 行就只留最近 keep 行（原子替换，面板不会读到半截） */
export function trimMessages(keep = 3000) {
  const file = messageLogPath()
  if (!existsSync(file)) return 0
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const limit = Math.max(100, Math.trunc(Number(keep) || 3000))
  if (lines.length <= limit * 2) return 0
  const kept = lines.slice(-limit)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
  renameSync(tmp, file)
  return lines.length - kept.length
}

/** 本地缓存的联系人与群（展示用；不含敏感 token） */
export function loadContacts() {
  return readJson(pathOf('contacts.json'), { friends: [], groups: [], updatedAt: 0 })
}

export function saveContacts(value) {
  writeJsonAtomic(pathOf('contacts.json'), value)
}

/** QQ 桥接/登录状态（进程内状态不做持久化，重启后重新探测） */
export const runtime = {
  startedAt: Date.now(),
  bridge: { state: 'idle', detail: '尚未连接 QQ 桥', lastError: '' },
  login: { state: 'idle', qrDataUrl: '', qrUrl: '', account: null, message: '' },
  napcat: { state: 'unknown', dir: '', pid: 0, version: '', detail: '' },
  stats: { received: 0, sent: 0, replies: 0, todayKey: todayKey() },
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 今日/累计收发统计（持久化在 stats.json，重启不丢）。
 * kind: 'received' | 'sent' | 'replies'
 */
export function loadStats() {
  const day = todayKey()
  const data = readJson(pathOf('stats.json'), null)
  const lifetime = (data && data.lifetime) || { received: 0, sent: 0, replies: 0 }
  if (!data || data.day !== day) {
    return { day, received: 0, sent: 0, replies: 0, lifetime }
  }
  return {
    day,
    received: Number(data.received) || 0,
    sent: Number(data.sent) || 0,
    replies: Number(data.replies) || 0,
    lifetime,
  }
}

export function bumpStats(kind, n = 1) {
  const current = loadStats()
  const count = Math.max(1, Math.trunc(Number(n) || 1))
  if (kind === 'received') current.received += count
  else if (kind === 'sent') current.sent += count
  else if (kind === 'replies') current.replies += count
  else return current
  current.lifetime[kind] = (current.lifetime[kind] || 0) + count
  writeJsonAtomic(pathOf('stats.json'), current)
  return current
}

/** 安全确认状态（独立文件，避免被"配置恢复默认"覆盖） */
export function loadSafety() {
  const data = readJson(pathOf('safety.json'), null)
  return { acknowledged: !!(data && data.acknowledged === true), acknowledgedAt: (data && data.acknowledgedAt) || 0 }
}

export function saveSafety(value) {
  const next = {
    acknowledged: !!(value && value.acknowledged === true),
    acknowledgedAt: value && value.acknowledged ? Date.now() : 0,
  }
  writeJsonAtomic(pathOf('safety.json'), next)
  return next
}

export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
