/**
 * dsh-dafeiyu-home — host 半端（归属：xingzhu）
 * ============================================================================
 * 这个文件只做三件事：
 *   1. 创建/持有 QqFishBridge（真正的 QQ 桥、登录、聊天、推送都在 lib/ 里）；
 *   2. 把面板需要的数据与动作挂成 `/api/qq-fish/*` HTTP 路由（契约见 docs/api-contract.md）；
 *   3. 跟随插件生命周期挂载/卸载，失败时只降级、不拖垮宿主。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import dns from 'node:dns'

// 【DNS】这台容器的 IPv6 解析不通（AAAA 查询 EAI_AGAIN），而 Node/undici 默认会同时查 A+AAAA，
// 导致 fetch 直接失败。这里强制走 IPv4，避免她的 B 站/天气/模型请求被 IPv6 拖死。
try {
  dns.setDefaultResultOrder && dns.setDefaultResultOrder('ipv4first')
  const origLookup = dns.lookup.bind(dns)
  dns.lookup = function (host, options, cb) {
    if (typeof options === 'function') { cb = options; options = {} }
    const opts = Object.assign({}, options || {}, { family: 4 })
    return origLookup(host, opts, cb)
  }
  // undici 与宿主的 SSRF 校验走 promises 版，单独补一遍（漏了就会 EAI_AGAIN）
  const dp = dns.promises
  if (dp && typeof dp.lookup === "function") {
    const origP = dp.lookup.bind(dp)
    dp.lookup = function (host, options) {
      const o = (options && typeof options === "object") ? options : {}
      return origP(host, Object.assign({}, o, { family: 4 }))
    }
  }
} catch {}

import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QqFishBridge } from './lib/bridge.mjs'
import { createLogger } from './lib/redact.mjs'

import { DEFAULT_PERSONA, clearConversation, conversationMessages, deleteMessages, dshHome, loadConfig, loadSafety, recentMessages, saveConfig, stateHome } from './lib/store.mjs'
import { tickQzoneAuto, autoPostStatus } from './lib/qzone-auto.mjs'
import { tickQzoneScroll, scrollStatus } from './lib/qzone-scroll.mjs'
import { usageSummary } from './lib/usage.mjs'

export const name = 'dafeiyu'
export const inject = ['webServer', 'stickers']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))

import { listStickers, stickerDir, loadIndex, listPacks, listStickersInPack, topStickers, findDuplicates, bumpStickerUse } from './lib/stickers.mjs'
import { fetchMyDynamics, fetchVideoInfo, loadBiliAccount } from './lib/bili/api.js'
import { synthesizeBase64, TTS_VOICES, TTS_STYLES } from './lib/tts.mjs'
import { loadBody, saveBody, cycleDay, phaseOf } from './lib/body.mjs'
import { voiceState, voiceStateAsync, applyVoiceConfig, previewVoice } from './lib/voice-config.mjs'
import { advancedSnapshot, applyAdvanced, bodySnapshot, applyBody, applyDesire, rerollBody, innerSnapshot, innerAction, tuneState, tuneAction, biliSnapshot, organicState, organicAction } from './lib/panel-data.mjs'
import { currentActivity, recentActivity } from './lib/daystream.mjs'
import { scanMilestones } from './lib/life.mjs'
import { scanCuriosity } from './lib/curiosity.mjs'
import { generateIntents } from './lib/intent.mjs'
import { reinterpretOne } from './lib/reinterpret.mjs'
import { readAudit, listGroups } from './lib/cross-search.mjs'
import { maintain as memoryMaintain, status as memoryStatus, addMemory as memoryAdd, promptBlock as memoryPromptBlock } from './lib/memory-decay.mjs'
import { status as purposeStatus, purposeGate } from './lib/purpose.mjs'
import { addFact, clearFacts, learnNow, listFacts, removeFact, updateFact } from './lib/learn.mjs'
import { evolveAcrossAll, addTrait, clearTraits, evolveNow, listTraits, removeTrait, updateTrait } from './lib/persona-evolve.mjs'
import { evolveSchedule, loadSchedule, saveSchedule, scheduleState } from './lib/schedule.mjs'
import { generateText } from './lib/llm.mjs'
import { cleanReply, systemPrompt } from './lib/persona.mjs'
import { readMood, writeMood, moodSnapshot, driftMood, applyMoodEvent } from './lib/vitals.mjs'
import { loadDiary, saveDiary, appendEntry, generateDiary, generateReview, entriesInPeriod, needsDiary, needsReview, saveReview, listReviews, renderDiaryPrompt } from './lib/sc/diary.mjs'
import { loadPromises, savePromises, addPromise, markPromiseDone, markPromiseMissed, removePromise, promiseSnapshot } from './lib/sc/promise.mjs'
import { loadBiliDaily, saveBiliDaily, fetchRanking, searchVideos, pickVideos, generateReport, appendReport, latestReport, needsDailyReport } from './lib/bili/daily.mjs'
import { transcribe as asrTranscribe, testConnection as asrTest, warmupLocal as asrWarmup, ASR_PROVIDERS } from './lib/asr.mjs'
import { loadStickerState, stickerStateSummary, stickerStatePath } from './lib/sc/sticker-state.mjs'
import { STICKER_MOODS } from './lib/sc/sticker-mood.mjs'
import { loadAuth as loadBiliAuth, browse as biliBrowse, getNav as biliNav, likeVideo as biliLike, favoriteVideo as biliFav } from './lib/bili/client.mjs'
import { generateQr as biliGenerateQr, pollQr as biliPollQr, loginState as biliLoginState } from './lib/bili/qrlogin.mjs'
import { pickShareCandidate as biliPickShare, buildShareCard as biliBuildCard } from './lib/bilishare.mjs'
import { runDynamic, runComment, herProfile } from './lib/bili/auto.mjs'
import { runDmReply, dmState, listSessions, fetchMessages } from './lib/bili/dm-chat.mjs'
import { runSummary, loadSummaryState, collectActivity } from './lib/bili/summary.mjs'
import { runReplyLoop } from './lib/bili/reply-loop.mjs'
import { runAtLoop } from './lib/bili/at-loop.mjs'
import { willSnapshot as biliWillSnapshot } from './lib/bili/will.mjs'
import { sleepState as biliSleepState } from './lib/bili/awake.mjs'
import { listOwnerVideos } from './lib/bili/owner-videos.mjs'
import { dynamicBudget, loadDynamicAccount } from './lib/bili/dynamic.mjs'
import { commentBudget } from './lib/bili/comment.mjs'
import { impressionsSnapshot } from './lib/member-impressions.mjs'
import { ledgerSync, ledgerVerify, ledgerSnapshot, healthLine } from './lib/ledger.mjs'
import { selfSnapshot, addClaim, addProject, addLine } from './lib/self.mjs'
import { dayplanSnapshot, generateDay as genDayplan, dateStr as dpDateStr, loadDay } from './lib/dayplan.mjs'
import { roomSnapshot, addFurniture, loadRoom, saveRoom, guessRoomFromText, setWeather } from './lib/room.mjs'
import { currentWeather } from './lib/weather.mjs'

const ROUTE_PREFIX = '/api/qq-fish'
const SCENE_DIR = join(PKG_DIR, 'assets', 'scene')
/** 场景角色动画：逻辑名 → dsh-pet 里的 webm 文件名（不复制、运行时引用） */
const SCENE_PET_FILES = {
  idle: '待机呼吸休闲.webm',
  wave: '点击回应-元气挥手.webm',
  walk: '原地左转奔跑.webm',
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendBinary(res, file, contentType) {
  if (!existsSync(file)) {
    sendJson(res, 404, { ok: false, error: '场景素材不存在', code: 'scene-asset-missing' })
    return
  }
  const buf = readFileSync(file)
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': buf.length,
    'cache-control': 'public, max-age=3600',
  })
  res.end(buf)
}

/** 在本机 profiles 里找已安装的 dsh-pet（MIT），只取它 assets 目录，不复制代码/素材 */
function findDshPetAssets() {
  try {
    const base = join(dshHome(), 'profiles')
    for (const profile of readdirSync(base)) {
      const dir = join(base, profile, 'node_modules', 'dsh-pet', 'assets')
      if (existsSync(dir)) return dir
    }
  } catch {}
  return ''
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// ── 语音配置统一走 lib/voice-config.mjs（面板、控制台、合成器共用一个真相）──

/**
 * 每日任务：日记、日/周/月复盘、B站日报。
 * 每分钟被调用一次，真正执行与否交给 needs* 判断（幂等，不会重复写）。
 */
/**
 * 刷完顺手点赞/收藏。默认关闭——点赞会留下痕迹，得用户主动开。
 * 只挑「真的看了字幕」的视频，像真人那样。
 */
async function applyBiliActions(auth, config, videos, log) {
  const out = { liked: [], faved: [] }
  try {
    if (!auth || !auth.loggedIn) return out
    const wantLike = config && config.biliAutoLike === true
    const wantFav = config && config.biliAutoFav === true
    if (!wantLike && !wantFav) return out
    // 只挑有字幕的（说明真看了）
    const watched = (videos || []).filter((v) => v && v.subLines > 0 && v.aid)
    if (!watched.length) return out
    const picks = watched.slice(0, wantLike ? 2 : 0)
    for (const v of picks) {
      const r = await biliLike(auth, v.aid, true)
      if (r.ok) { out.liked.push(v.title.slice(0, 30)); log.info('[B站] 点赞：' + v.title.slice(0, 30)) }
      await new Promise((res) => setTimeout(res, 800))
    }
    if (wantFav && watched[0]) {
      const r2 = await biliFav(auth, watched[0].aid)
      if (r2.ok) { out.faved.push(watched[0].title.slice(0, 30)); log.info('[B站] 收藏：' + watched[0].title.slice(0, 30)) }
    }
  } catch (e) {
    log.warn('[B站] 点赞/收藏失败：' + ((e && e.message) || e))
  }
  return out
}

async function runDailyTasks(ctx, log) {
  const config = loadConfig()
  const now = new Date()
  const hour = now.getHours()
  const home = stateHome()
  const diaryFile = join(home, 'diary.json')

  // ① 日记：到点且今天还没写
  if (config.diaryEnabled !== false && hour === Number(config.diaryHour != null ? config.diaryHour : 23)) {
    const diary = loadDiary(diaryFile)
    if (needsDiary(diary)) {
      const msgs = recentMessages(200)
      const r = await generateDiary(ctx, { stateHome: home, config, log, messages: msgs })
      if (r.ok) {
        const next = appendEntry(diary, { text: r.text, source: 'auto', moodLabel: (moodSnapshot(readMood(home)).composite || '') })
        saveDiary(diaryFile, next)
        log.info('[日记] 写好了：' + r.text.slice(0, 40))
      } else {
        log.warn('[日记] 没写成：' + r.error)
      }
    }
  }

  // ② 复盘：日 / 周 / 月
  if (config.reviewEnabled !== false) {
    const diary = loadDiary(diaryFile)
    const jobs = []
    const reviewHour = (Number(config.diaryHour != null ? config.diaryHour : 23) + 1) % 24
    if (hour === reviewHour && needsReview(diary, 'daily')) jobs.push('daily')
    if (now.getDay() === Number(config.reviewWeeklyDay != null ? config.reviewWeeklyDay : 0) && hour === reviewHour && needsReview(diary, 'weekly')) jobs.push('weekly')
    if (now.getDate() === Number(config.reviewMonthlyDay != null ? config.reviewMonthlyDay : 1) && hour === reviewHour && needsReview(diary, 'monthly')) jobs.push('monthly')

    for (const kind of jobs) {
      const entries = entriesInPeriod(diary, kind)
      if (!entries.length) continue
      const r = await generateReview(ctx, { config, log, kind, entries })
      if (r.ok) {
        const next = saveReview(diary, kind, Date.now(), r.text, { count: entries.length })
        saveDiary(diaryFile, next)
        log.info('[' + kind + '复盘] 写好了')
      } else {
        log.warn('[' + kind + '复盘] 失败：' + r.error)
      }
    }
  }

  // ③ B站日报
  if (config.biliDailyEnabled && hour === Number(config.biliDailyHour != null ? config.biliDailyHour : 9)) {
    const data = loadBiliDaily(join(home, 'bili-daily.json'))
    if (needsDailyReport(data)) {
      const kw = String(config.biliTasteKeywords || '').split(/[,，\s]+/).filter(Boolean)
      const ex = String(config.biliExcludeKeywords || '').split(/[,，\s]+/).filter(Boolean)
      const videos = await biliBrowse(loadBiliAuth(), { count: 6, maxSubtitleChars: 900 })
      if (videos.length) {
        const r = await generateReport(ctx, { config, log, videos, personaName: config.personaName })
        if (r.ok) {
          const p2 = (n) => String(n).padStart(2, '0')
          const date = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
          const next = appendReport(data, { date, text: r.text, videos })
          saveBiliDaily(join(home, 'bili-daily.json'), next)
          log.info('[B站日报] 写好了')
        }
      }
    }
  }

  // ④ 内心维护：人生里程碑 / 好奇心扫描 / 生成今日意图 / 记忆重解
  //    每个函数内部都按日期判重，一天只会真跑一次
  try {
    const msgs = recentMessages(400)
    await scanMilestones()
    const learnedWords = new Set()
    try {
      for (const f of listFacts({ conversation: '' }) || []) {
        const t = typeof f === 'string' ? f : f && (f.text || f.fact)
        if (t) learnedWords.add(String(t).slice(0, 8))
      }
    } catch {}
    // 人设里出现过的词不算「没搞懂」——那是她自己的词汇（杂鱼、主人、白饭…）
    try {
      const persona = String(config.persona || '')
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i + len <= persona.length; i++) learnedWords.add(persona.slice(i, i + len))
      }
    } catch {}
    await scanCuriosity({ messages: msgs, knownWords: learnedWords })
    const ctxText = msgs.slice(-20).map((m) => (m.direction === 'out' ? '她说：' : (m.who || '对方') + '：') + String(m.text || '').slice(0, 40)).join('\n')
    await generateIntents({ generateText, ctx, config, log, context: ctxText, max: 2 })
    await reinterpretOne({ generateText, ctx, config, log })
  } catch (e) {
    log.warn('内心维护失败：' + ((e && e.message) || e))
  }
}

export function apply(ctx) {
  const log = createLogger('[qq-fish]')
  const bridge = new QqFishBridge({ ctx, version: PKG.version, log })

  // 【本地 ASR 预热】后台加载 SenseVoice 模型（约 4-5 秒）。
  // 挂定时器里避免阻塞插件启动；只在启用 local 时执行，失败只警告不影响其他功能。
  setTimeout(() => {
    try {
      const cfg = loadConfig()
      if (!cfg || !cfg.asrEnabled || String(cfg.asrProvider || '') !== 'local') return
      asrWarmup()
        .then((r) => {
          if (r.ok) log.info(`[ASR] 本地模型预热完成（${r.ms}ms）`)
          else log.warn(`[ASR] 本地模型预热失败：${r.error}`)
        })
        .catch(() => {})
    } catch {}
  }, 2000)

  /** 路由分发：统一把异常翻译成 {ok:false, error, code}，面板直接展示人话 */
  /** 面板心情视图：在快照基础上按生理周期修正体温（排卵后黄体期会升 0.3~0.5℃，经期略低） */
  const moodView = async () => {
    const snap = moodSnapshot(readMood(stateHome()))
    try {
      const b = await loadBody()
      const day = cycleDay(b)
      const phase = day ? phaseOf(day, b) : ''
      const offset = { period: -0.15, follicular: 0, ovulation: 0.1, luteal: 0.35, pms: 0.3 }[phase] || 0
      if (snap && snap.body && Number.isFinite(Number(snap.body.temperature))) {
        snap.body.temperature = Math.round((Number(snap.body.temperature) + offset) * 10) / 10
      }
    } catch {}
    return snap
  }

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/qq-fish\/?/, '')
    const method = req.method || 'GET'

    // 【面板说话】主人直接在面板里跟她说话：不经过 QQ，只生成不发送（dryRun）
    if (method === 'POST' && path === 'say') {
      const body = await readBody(req)
      const text = String((body && body.text) || '').trim().slice(0, 500)
      if (!text) return sendJson(res, 400, { ok: false, error: '空消息' })
      const eng = bridge && bridge.engine
      if (!eng) return sendJson(res, 503, { ok: false, error: '引擎未就绪' })
      const cfg = loadConfig()
      const ownerId = String(cfg.accessAdminId || '').replace(/\D/g, '')
      if (!ownerId) return sendJson(res, 400, { ok: false, error: '没配主人 QQ（accessAdminId）' })
      const selfId = String((bridge && bridge.selfId) || '').replace(/\D/g, '')
      const event = {
        post_type: 'message',
        message_type: 'private',
        self_id: selfId || '',
        user_id: ownerId,
        sender: { user_id: ownerId, nickname: '主人' },
        message: [{ type: 'text', data: { text } }],
        raw_message: text,
        message_id: 'say-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        time: Math.floor(Date.now() / 1000),
      }
      const before = bridge._dryRun
      bridge._dryRun = true
      bridge._lastSent = ''
      try {
        await eng.handle(event)
        // handle 是异步的：回复在后台跑，轮询等它（最多 30 秒）
        for (let i = 0; i < 120 && !bridge._lastSent; i++) await new Promise((r) => setTimeout(r, 500))
        return sendJson(res, 200, { ok: true, text: String(bridge._lastSent || '').trim() })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      } finally {
        bridge._dryRun = before
      }
    }
    if (method === 'GET' && (path === '' || path === 'health')) {
      return sendJson(res, 200, { ok: true, name: PKG.name, version: PKG.version, home: stateHome() })
    }

    // 场景小屋素材（v0.2.0-alpha.1）
    if (method === 'POST' && path === 'client-error') {
      const body = await readBody(req)
      try {
        const msg = String((body && (body.stack || body.msg)) || '').slice(0, 1200)
        console.error('[qq-fish/client] ' + msg.replace(/\n/g, ' | '))
      } catch {}
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'GET' && path === 'scene/info') {
      const petAssets = findDshPetAssets()
      return sendJson(res, 200, {
        ok: true,
        sceneName: String((bridge.publicConfig() && bridge.publicConfig().sceneName) || '大肥鱼的小家'),
        background: existsSync(join(SCENE_DIR, 'hut.webp')),
        hasPet: !!petAssets,
        petFiles: Object.keys(SCENE_PET_FILES),
        attribution: '场景：Blender 三渲二（xingzhu）；角色动画：dsh-pet (MIT, PC2005-cloud)',
      })
    }
    if (method === 'GET' && path === 'scene/background') {
      return sendBinary(res, join(SCENE_DIR, 'hut.webp'), 'image/webp')
    }
    if (method === 'GET' && path.startsWith('scene/pet/')) {
      const key = path.slice('scene/pet/'.length)
      const fileName = SCENE_PET_FILES[key]
      if (!fileName) return sendJson(res, 404, { ok: false, error: '未知动画', code: 'scene-pet-unknown' })
      const petAssets = findDshPetAssets()
      if (!petAssets) return sendJson(res, 404, { ok: false, error: '未检测到 dsh-pet，使用静态角色', code: 'scene-pet-missing' })
      return sendBinary(res, join(petAssets, 'webm', fileName), 'video/webm')
    }

    // 只读
    if (method === 'GET' && path === 'state') return sendJson(res, 200, bridge.snapshot())
    if (method === 'GET' && path === 'qzone/scroll') {
      const cfgS = loadConfig()
      return sendJson(res, 200, {
        ok: true,
        ...scrollStatus(stateHome(), 10),
        enabled: cfgS.qzoneScroll !== false,
        gapHours: cfgS.qzoneScrollMinGapHours,
        maxActions: cfgS.qzoneScrollMaxActions,
        window: [cfgS.qzoneScrollStart, cfgS.qzoneScrollEnd],
      })
    }
    if (method === 'POST' && path === 'qzone/scroll-now') {
      const cfgS = loadConfig()
      const r = await tickQzoneScroll(
        { ctx, config: cfgS, log, getBridge: () => bridge.engineClient() },
        { force: true },
      )
      return sendJson(res, 200, { ...r, status: scrollStatus(stateHome(), 5) })
    }
    if (method === 'GET' && path === 'qzone/stream') {
      const qs = await import('./lib/qzone-http.mjs')
      const r = await qs.qzoneZoneList(bridge.engineClient(), { page: Number(url.searchParams.get('page') || 1) })
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (method === 'GET' && path === 'qzone/auto') {
      const cfg = loadConfig()
      return sendJson(res, 200, {
        ok: true,
        ...autoPostStatus(stateHome()),
        enabled: cfg.qzoneAutoPost !== false,
        perDay: cfg.qzoneAutoPostPerDay,
        minGapHours: cfg.qzoneAutoPostMinGapHours,
        window: [cfg.qzoneAutoStart, cfg.qzoneAutoEnd],
      })
    }
    if (method === 'POST' && path === 'qzone/auto-now') {
      const cfg = loadConfig()
      const dry = url.searchParams.get('dry') === '1'
      const r = await tickQzoneAuto({ ctx, config: cfg, log, getBridge: () => bridge.engineClient() }, { force: true, dry })
      return sendJson(res, 200, r)
    }
    // ── 空间 HTTP 通道：看动态 / 点赞 / 评论 / 回复 / 删说说（移植自 AstrBot qzone 插件） ──
    if (path.startsWith('qzone/feeds') || path.startsWith('qzone/detail') || path.startsWith('qzone/recent')) {
      try {
        const q = await import('./lib/qzone-http.mjs')
        const client = bridge.engineClient()
        if (path === 'qzone/feeds') {
          const num = Math.max(1, Math.min(50, Number(url.searchParams.get('num') || 10)))
          const pos = Math.max(0, Number(url.searchParams.get('pos') || 0))
          return sendJson(res, 200, { ok: true, ...(await q.qzoneFeeds(client, { uin: url.searchParams.get('uin') || '', num, pos })) })
        }
        if (path === 'qzone/detail') {
          return sendJson(res, 200, { ok: true, ...(await q.qzoneDetail(client, { uin: url.searchParams.get('uin') || '', tid: url.searchParams.get('tid') || '' })) })
        }
        return sendJson(res, 200, { ok: true, ...(await q.qzoneRecentFeeds(client, { page: Number(url.searchParams.get('page') || 1) })) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (method === 'POST' && path.startsWith('qzone/')) {
      const act = path.slice('qzone/'.length)
      if (['like', 'comment', 'reply', 'delete', 'publish-http', 'ctx'].includes(act)) {
        try {
          const q = await import('./lib/qzone-http.mjs')
          const client = bridge.engineClient()
          const body = await readBody(req)
          if (act === 'ctx') {
            const c = await q.qzoneCtx(client)
            return sendJson(res, 200, { ok: true, uin: c.uin, gtk: Boolean(c.gtk) })
          }
          if (act === 'like') return sendJson(res, 200, await q.qzoneLike(client, { uin: body.uin, tid: body.tid }))
          if (act === 'comment') return sendJson(res, 200, await q.qzoneComment(client, { uin: body.uin, tid: body.tid, content: body.content }))
          if (act === 'reply') return sendJson(res, 200, await q.qzoneReply(client, body))
          if (act === 'delete') return sendJson(res, 200, await q.qzoneDelete(client, { tid: body.tid }))
          if (act === 'publish-http') {
            const { readFileSync } = await import('node:fs')
            const bufs = []
            for (const f of (Array.isArray(body.files) ? body.files : [])) bufs.push(readFileSync(String(f)))
            return sendJson(res, 200, await q.qzonePublish(client, { text: body.text, images: bufs, ugcRight: body.ugcRight }))
          }
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
        }
      }
    }
    if (method === 'GET' && path === 'usage') return sendJson(res, 200, { ok: true, ...usageSummary() })
    if (method === 'GET' && path === 'chats') return sendJson(res, 200, bridge.listChats())
    if (method === 'GET' && path === 'messages') {
      // getMessages 现在是 async（要补查引用原文）
      return sendJson(res, 200, await bridge.getMessages(url.searchParams.get('conversation') || '', url.searchParams.get('limit') || 200))
    }
    if (method === 'GET' && path === 'login/quicklist') return sendJson(res, 200, await bridge.quickLoginList())
    if (method === 'GET' && path === 'safety') return sendJson(res, 200, { ok: true, safety: loadSafety() })

    // ── 观点层（她读过的书 + 会变的看法） ──
    if (method === 'GET' && path === 'worldview') {
      try {
        const { listViewpoints } = await import('./lib/worldview.mjs')
        const items = listViewpoints()
        let reading = []
        try {
          const j = JSON.parse(readFileSync(join(stateHome(), 'reading-log.json'), 'utf8'))
          reading = Array.isArray(j.items) ? j.items : []
        } catch {}
        return sendJson(res, 200, { ok: true, items, reading: reading.slice(-20).reverse() })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (method === 'POST' && path === 'worldview/delete') {
      try {
        const body = await readBody(req)
        const { removeViewpoint } = await import('./lib/worldview.mjs')
        return sendJson(res, 200, { ok: removeViewpoint(String((body && body.id) || '')) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    }

    // ── 表情包库 ──
    // ── 目的机制（主动搭话的决策状态）──────────────
    if (method === 'GET' && path === 'purpose') {
      return sendJson(res, 200, { ok: true, ...purposeStatus(Date.now(), loadConfig()) })
    }
    if (method === 'GET' && path === 'purpose/gate') {
      return sendJson(res, 200, { ok: true, ...purposeGate({ config: loadConfig() }) })
    }
    // ── 跨群检索审计（隐私可分页查看） ─────────────
    // ── 她的小屋（房间 + 家具）──────────────
    if (method === 'GET' && path === 'room') {
      const home = stateHome()
      const snap = roomSnapshot(home)
      let current = { room: 'living', activity: '在家待着', since: '', source: 'idle', inHome: true }
      try {
        const day = loadDay(home, dpDateStr())
        const nw = new Date()
        const minute = nw.getHours() * 60 + nw.getMinutes()
        const toMin = (t) => { const p = String(t || '').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0) }
        const item = Array.isArray(day && day.items) ? day.items.find((it) => { const a = toMin(it.start); let b = toMin(it.end); if (b <= a) b = 24 * 60; return minute >= a && minute < b }) : null
        if (item) {
          const text = String(item.activity || '') + String(item.location || '') + String(item.detail || '')
          const loc = String(item.location || '')
          const inHome = !/附近|公园|街|店|超市|商场|外面|路上|公司|学校/.test(loc) || /家|客厅|厨房|卧|书房|阳台|露台|卫/.test(loc)
          current = { room: guessRoomFromText(text), activity: String(item.activity || '待着') + (loc ? '（' + loc + '）' : ''), since: item.start, source: 'dayplan', inHome }
        }
      } catch {}
      let weatherInfo = null
      try { weatherInfo = await currentWeather(undefined, loadConfig()) } catch {}
      const manual = snap.weather
      const autoKind = (weatherInfo && weatherInfo.kind) || 'sunny'
      const cfgNow = loadConfig()
      return sendJson(res, 200, { ...snap, weather: manual || autoKind, weatherInfo, weatherGeoSource: String(cfgNow.weatherGeoSource || ""), weatherCity: String(cfgNow.weatherCity || ""), current })
    }
    // ── 主力机上报实时位置（她跟着主人的位置看天气）──────────
    if (method === 'POST' && path === 'weather/location') {
      const body = await readBody(req)
      const lat = String((body && body.lat) || '').trim()
      const lon = String((body && body.lon) || '').trim()
      const city = String((body && body.city) || '').trim().slice(0, 40)
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
        return sendJson(res, 200, { ok: false, error: '需要 lat / lon' })
      }
      saveConfig({ weatherLat: lat, weatherLon: lon, weatherCity: city, weatherGeoSource: 'gps' })
      // 位置变了，清掉天气缓存，立刻按新位置取
      try { unlinkSync(join(stateHome(), 'weather.json')) } catch {}
      let info = null
      try { info = await currentWeather(undefined, loadConfig()) } catch {}
      return sendJson(res, 200, { ok: true, lat, lon, city, weatherInfo: info })
    }
    if (method === 'POST' && path === 'weather/ip-locate') {
      // 【IP 定位】浏览器只在 HTTPS 给精确定位；http 面板用这个兜底（精度到城市，够天气用）
      try {
        // 用免费的 ip-api（不依赖任何 key，别人装了也能用）；有高德 key 才额外补中文地名
        const r = await fetch('http://ip-api.com/json/?lang=zh-CN', { signal: AbortSignal.timeout(9000) })
        const j = await r.json()
        if (!j || j.status !== 'success' || !Number.isFinite(Number(j.lat))) {
          return sendJson(res, 200, { ok: false, error: 'IP 定位失败：' + String((j && (j.message || j.status)) || '未知') })
        }
        const lat = Number(j.lat).toFixed(5)
        const lon = Number(j.lon).toFixed(5)
        const city = String(j.city || j.regionName || '').trim()
        // IP 定位（城市级）：跟着网络走，写回配置，标记来源为 ip
        saveConfig({ weatherLat: lat, weatherLon: lon, weatherCity: city, weatherGeoSource: 'ip' })
        try { unlinkSync(join(stateHome(), 'weather.json')) } catch {}
        let info = null
        try { info = await currentWeather(undefined, loadConfig()) } catch {}
        return sendJson(res, 200, { ok: true, lat, lon, city, weatherInfo: info, via: 'ip' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: 'IP 定位出错：' + String((e && e.message) || e).slice(0, 80) })
      }
    }
    if (method === 'GET' && path.startsWith('room3d/')) {
      // 【3D 房间】包内静态资源（three.js + 房间 + 几何角色），同源加载，不依赖 8099
      const rel = String(path.slice('room3d/'.length) || '').replace(/[^a-zA-Z0-9._/-]/g, '').replace(/\.\./g, '')
      const root = join(PKG_DIR, 'web3d-pkg')
      const file = join(root, rel)
      try {
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          return sendJson(res, 404, { ok: false, error: 'no such asset' })
        }
        const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
        const buf = readFileSync(file)
        res.writeHead(200, { 'content-type': mime, 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=86400' })
        res.end(buf)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
      return
    }
    if (method === 'GET' && path.startsWith('room/bg/')) {
      const id = String(path.slice('room/bg/'.length) || '').replace(/[^a-z0-9]/gi, '')
      const allowed = ['living', 'kitchen', 'master', 'second', 'study', 'guest', 'bath1', 'bath2', 'balcony', 'terrace']
      if (!allowed.includes(id)) return sendJson(res, 404, { ok: false, error: 'no such room' })
      try {
        const buf = readFileSync(join(PKG_DIR, 'assets', 'room', id + '.png'))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
        res.end(buf)
      } catch {
        return sendJson(res, 404, { ok: false, error: 'no image' })
      }
      return
    }
    if (method === 'POST' && path === 'room/action') {
      const body = await readBody(req)
      const act = String((body && body.action) || '')
      const home = stateHome()
      if (act === 'gift') {
        const item = addFurniture(home, { from: 'owner', room: String((body && body.room) || '') })
        return sendJson(res, 200, item ? { ...roomSnapshot(home), ok: true, item } : { ok: false, error: '没东西可添了' })
      }
      if (act === 'weather-auto') {
        const r = loadRoom(home)
        r.weather = ''
        saveRoom(home, r)
        let info = null
        try { info = await currentWeather(undefined, loadConfig()) } catch {}
        return sendJson(res, 200, { ...roomSnapshot(home), ok: true, weather: (info && info.kind) || 'sunny', weatherInfo: info })
      }
      if (act === 'weather') {
        const w = setWeather(home, String((body && body.weather) || 'sunny'))
        return sendJson(res, 200, { ...roomSnapshot(home), ok: true, weather: w })
      }
      if (act === 'move') {
        const r = loadRoom(home)
        const it = r.items.find((x) => x.id === String((body && body.id) || ''))
        if (!it) return sendJson(res, 200, { ok: false, error: '没有这件家具' })
        const nx = Number(body && body.x)
        const ny = Number(body && body.y)
        if (Number.isFinite(nx)) it.x = Math.max(2, Math.min(96, nx))
        if (Number.isFinite(ny)) it.y = Math.max(4, Math.min(90, ny))
        saveRoom(home, r)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 200, { ok: false, error: '未知 action' })
    }
    if (method === 'GET' && path === 'dayplan') {
      return sendJson(res, 200, { ok: true, ...dayplanSnapshot(stateHome()) })
    }
    if (method === 'POST' && path === 'dayplan/gen') {
      const b = await readBody(req)
      const home = stateHome()
      const date = String((b && b.date) || dpDateStr())
      const r = await genDayplan({ generateText, ctx, config: loadConfig(), home, date, hint: String((b && b.hint) || '') })
      return sendJson(res, 200, { ok: r.ok, ...(r.ok ? { day: r.day, template: !!r.template } : { error: r.error }) })
    }
    if (method === 'GET' && path === 'self') {
      return sendJson(res, 200, { ok: true, ...selfSnapshot(stateHome()) })
    }
    if (method === 'POST' && path === 'self/action') {
      const b = await readBody(req)
      const home = stateHome()
      const act = String((b && b.action) || '')
      if (act === 'claim') return sendJson(res, 200, { ok: true, ...addClaim(home, b.text, b.evidence) })
      if (act === 'project') return sendJson(res, 200, { ok: true, ...addProject(home, b.title, b.failIf) })
      if (act === 'line') return sendJson(res, 200, { ok: true, ...addLine(home, b.text) })
      return sendJson(res, 200, { ok: false, error: 'unknown action' })
    }
    if (method === 'GET' && path === 'ledger') {
      const home = stateHome()
      let mems = []
      try {
        const mod = await import('./lib/memory-decay.mjs')
        const st = mod.status ? mod.status(home) : null
        mems = (st && st.items) || []
        // 补账 + 健康一行
        try { ledgerSync(home, mems) } catch {}
        try {
          const v = ledgerVerify(home, mems)
          let tension = '?'
          try { const om = await import('./lib/organic.mjs'); tension = om.organicSnapshot().tension } catch {}
          healthLine(home, { memCount: mems.length, vitalsOk: true, tension, mood: '' })
        } catch {}
      } catch {}
      return sendJson(res, 200, { ok: true, ...ledgerSnapshot(home, mems) })
    }
    if (method === 'GET' && path === 'impressions') {
      return sendJson(res, 200, { ok: true, ...impressionsSnapshot() })
    }
    if (method === 'GET' && path === 'cross-audit') {
      const u = new URL(req.url, 'http://x')
      const limit = Number(u.searchParams.get('limit')) || 50
      return sendJson(res, 200, { ok: true, entries: readAudit(limit) })
    }
    // ── 语音合成（edge-tts）──────────────────────
    if (method === 'GET' && path === 'tts/voices') {
      return sendJson(res, 200, { ok: true, voices: TTS_VOICES })
    }
    if (method === 'GET' && path === 'tts/styles') {
      return sendJson(res, 200, { ok: true, styles: TTS_STYLES })
    }
    if (method === 'POST' && path === 'tts') {
      const body = await readBody(req)
      const text = String((body && body.text) || '').trim()
      if (!text) return sendJson(res, 200, { ok: false, error: '文字不能为空' })
      const r = await synthesizeBase64(text, { voice: body.voice, style: body.style })
      if (!r.ok) return sendJson(res, 200, r)
      // 如果指定了目标就顺便发出去
      if (body.target && (body.target.id || body.target.groupId)) {
        try {
          await bridge.sendVoice(
            body.target.kind === 'group' ? { kind: 'group', groupId: body.target.id } : { kind: 'private', userId: body.target.id },
            r.file,
          )
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: '合成成功但发送失败：' + String((e && e.message) || e) })
        }
      }
      return sendJson(res, 200, { ok: true, bytes: r.bytes, sent: Boolean(body.target) })
    }
    // ── Breeze 每日额度：手动领取 + 查看今天领没领 ──
    if ((method === 'GET' || method === 'POST') && path === 'breeze/claim') {
      const { creditsSummary, claimDaily, readClaimState } = await import('./lib/breeze-claim.mjs')
      const force = String(url.searchParams.get('claim') || '') === '1' || method === 'POST'
      const summary = await creditsSummary()
      const result = force ? await claimDaily() : null
      return sendJson(res, 200, { ok: true, summary, result, history: (readClaimState().history || []).slice(-5) })
    }
    // ── 额度：workbuddy 积分 + DeepSeek 官方余额（两边都失败了也返回 ok:true，别让面板报错）──
    if (method === 'GET' && path === 'quota') {
      const { quotaSnapshot, quotaLine } = await import('./lib/quota.mjs')
      const force = String(url.searchParams.get('force') || '') === '1'
      const q = await quotaSnapshot({ force })
      return sendJson(res, 200, { ok: true, ...q, line: quotaLine(q) })
    }
    // ── 语音：统一状态（唯一数据源 config.json + tts-breeze.json，所有前端都读这一份）──
    if (method === 'GET' && path === 'voice/state') {
      // 顺手拉一次账号里的音色列表 + 余额（缓存 6h；?force=1 强制刷新）
      let st
      try {
        st = await voiceStateAsync({ force: /[?&]force=1/.test(String(url || '')) })
      } catch {
        st = voiceState()
      }
      return sendJson(res, 200, { ok: true, ...st })
    }
    if (method === 'POST' && path === 'voice/config') {
      const body = await readBody(req)
      return sendJson(res, 200, applyVoiceConfig(body || {}))
    }
    if (method === 'POST' && path === 'voice/preview') {
      const body = await readBody(req)
      return sendJson(res, 200, await previewVoice(body || {}))
    }
    // ── 身体 / 高级（和 8082 控制台共用 lib/panel-data.mjs）──
    if (method === 'GET' && path === 'body/state') {
      return sendJson(res, 200, { ok: true, ...(await bodySnapshot()) })
    }
    if (method === 'POST' && path === 'body/config') {
      const body = await readBody(req)
      return sendJson(res, 200, await applyBody(body || {}))
    }
    if (method === 'POST' && path === 'body/reroll') {
      return sendJson(res, 200, await rerollBody())
    }
    // 【欲望可调】主人拖滑块直接写 vitals（0-100）
    if (method === 'POST' && path === 'body/desire') {
      const dbody = await readBody(req)
      return sendJson(res, 200, applyDesire(dbody || {}))
    }
    // 【她的一天】时间线：她不在跟你说话的时候都在干嘛
    if (method === 'GET' && path === 'daystream') {
      return sendJson(res, 200, { ok: true, current: currentActivity(stateHome()), entries: recentActivity(stateHome(), 60) })
    }
    if (method === 'GET' && path === 'advanced/state') {
      return sendJson(res, 200, { ok: true, groups: advancedSnapshot() })
    }
    if (method === 'POST' && path === 'advanced/config') {
      const body = await readBody(req)
      return sendJson(res, 200, applyAdvanced((body && body.patch) || body || {}))
    }
    if (method === 'GET' && path === 'organic/state') {
      return sendJson(res, 200, { ok: true, ...organicState() })
    }
    if (method === 'POST' && path === 'organic/action') {
      const ob = await readBody(req)
      return sendJson(res, 200, organicAction((ob && ob.action) || ''))
    }
    if (method === 'GET' && path === 'bili/state') {
      return sendJson(res, 200, { ok: true, ...biliSnapshot() })
    }
    if (method === 'GET' && path === 'tune/state') {
      return sendJson(res, 200, { ok: true, ...tuneState() })
    }
    if (method === 'POST' && path === 'tune/action') {
      const body = await readBody(req)
      return sendJson(res, 200, tuneAction((body && body.action) || '', body || {}))
    }
    if (method === 'GET' && path === 'inner/state') {
      return sendJson(res, 200, { ok: true, ...(await innerSnapshot()) })
    }
    if (method === 'POST' && path === 'inner/action') {
      const body = await readBody(req)
      return sendJson(res, 200, { ok: true, ...(await innerAction((body && body.action) || '', body || {})) })
    }
    if (method === 'GET' && path === 'sign') {      return (async () => {
        const b = await loadBody()
        return sendJson(res, 200, { ok: true, longNick: b.lastSign || '', note: 'QQ 没有读取签名的接口，这里只显示她（或你）最后一次改的值' })
      })()
    }
    if (method === 'POST' && path === 'sign') {
      const body = await readBody(req)
      const v = String((body && body.longNick) || '').trim().slice(0, 60)
      if (!v) return sendJson(res, 200, { ok: false, error: '签名不能为空' })
      if (!bridge.client || bridge.client.state !== 'online') {
        return sendJson(res, 200, { ok: false, error: 'QQ 桥还没连上' })
      }
      try {
        const r = await bridge.client.call('set_self_longnick', { longNick: v })
        // NapCat 返回 {result:0, errMsg:""}；非 0 就是失败
        if (r && typeof r === 'object' && r.result !== undefined && r.result !== 0) {
          return sendJson(res, 200, { ok: false, error: '改签名失败：' + (r.errMsg || '未知原因') })
        }
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: '改签名失败：' + String((e && e.message) || e) })
      }
      await saveBody({ lastSign: v })
      return sendJson(res, 200, { ok: true, longNick: v })
    }
    // ── 记忆卡（会衰减的长期记忆）─────────────────
    if (method === 'GET' && path === 'memory-card') {
      return sendJson(res, 200, { ok: true, ...memoryStatus(Date.now(), loadConfig()) })
    }
    if (method === 'GET' && path === 'memory-card/prompt') {
      return sendJson(res, 200, { ok: true, text: memoryPromptBlock() })
    }
    if (method === 'POST' && path === 'memory-card/maintain') {
      return sendJson(res, 200, { ok: true, ...memoryMaintain(Date.now(), { config: loadConfig() }) })
    }
    if (method === 'POST' && path === 'memory-card/add') {
      const body = await readBody(req)
      const text = String((body && body.text) || '').trim()
      if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
      return sendJson(res, 200, { ok: true, ...memoryAdd(text, { importance: Number(body.importance) || 70, config: loadConfig() }) })
    }
    // ── B 站扫码登录（给她一个专属 B 站号）──────────────────────
    if (method === 'GET' && path === 'bili/qr') {
      const r = await biliGenerateQr().catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      return sendJson(res, 200, r)
    }
    if (method === 'GET' && path === 'bili/qr/poll') {
      const u = new URL(req.url, 'http://x')
      const r = await biliPollQr(undefined, u.searchParams.get('key') || '').catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      return sendJson(res, 200, r)
    }
    if (method === 'GET' && path === 'bili/login-state') {
      return sendJson(res, 200, biliLoginState())
    }
    // ── B 站自主发言：她自己的动态 + 在他视频下的评论 ─────────────
    if (method === 'GET' && path === 'bili/auto-state') {
      const cfg = loadConfig()
      const dyn = dynamicBudget()
      const cmt = commentBudget()
      let sched = {}
      try { sched = JSON.parse(readFileSync(join(stateHome(), 'scheduler.json'), 'utf8')) } catch {}
      let videos = []
      let videoError = ''
      try {
        const ownerMid = String(cfg.ownerBiliMid || '').trim()
        if (ownerMid) {
          const acc2 = loadDynamicAccount()
          const listed = await listOwnerVideos(ownerMid, 8, { cookie: acc2.cookie })
          if (listed.ok) videos = listed.videos.map((v) => ({ ...v, commented: Boolean(cmt.videos[v.aid]) }))
          else videoError = listed.error
        }
      } catch (e) { videoError = String((e && e.message) || e) }
      const prof = await herProfile()
      return sendJson(res, 200, {
        ok: true,
        self: { mid: prof.mid, name: prof.name },
        ownerMid: String(cfg.ownerBiliMid || ''),
        dynamic: {
          auto: cfg.biliAutoDynamic !== false,
          perDay: dyn.perDay,
          count: dyn.count,
          remaining: dyn.remaining,
          lastAt: Number(sched.lastBiliDynamicAt || 0) || null,
        },
        comment: {
          auto: cfg.biliAutoComment !== false,
          perDay: cmt.perDay,
          count: cmt.count,
          remaining: cmt.remaining,
          lastAt: Number(sched.lastBiliCommentAt || 0) || null,
          scope: String(cfg.biliCommentScope || 'watched'),
          at: cfg.biliCommentAt !== false,
          ownerName: String(cfg.ownerBiliName || ''),
        },
        dm: {
          auto: cfg.biliDmReply !== false,
          pollMinutes: Number(cfg.biliDmPollMinutes || 10),
          maxPerPoll: Number(cfg.biliDmMaxPerPoll || 3),
          maxPerDay: Number(cfg.biliDmMaxPerDay ?? 20),
        },
        summary: {
          auto: cfg.biliSummaryEnabled !== false,
          hour: Number(cfg.biliSummaryHour ?? 23),
          weekday: Number(cfg.biliSummaryWeekday ?? 6),
        },
        // 【她自己决定刷不刷】面板能看到她最近几次自己怎么决定的
        will: (() => { try { return biliWillSnapshot(Date.now(), stateHome()) } catch (e) { return { error: String((e && e.message) || e) } } })(),
        sleepGate: (() => {
          try {
            const st = biliSleepState({ now: Date.now(), config: cfg })
            return {
              gate: cfg.biliSleepGate !== false,
              selfDirected: cfg.biliWatchSelfDirected !== false,
              window: st.window,
              inScheduleSleep: st.inScheduleSleep,
              moodAsleep: st.moodAsleep,
              ownerAsleep: st.ownerAsleep,
              clock: st.clock,
            }
          } catch (e) { return { error: String((e && e.message) || e) } }
        })(),
        videos,
        videoError,
      })
    }
    if (method === 'POST' && path === 'bili/dynamic-now') {
      const body = await readBody(req)
      const r = await runDynamic(ctx, loadConfig(), log, { dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    // ── B 站私信：收+回（对齐 AstrBot 的 PRIVATE_MESSAGE_*）────────────
    if (method === 'GET' && path === 'bili/dm-state') {
      const cfg = loadConfig()
      const [st, sess, msgs] = await Promise.all([
        Promise.resolve(dmState()),
        listSessions(undefined),
        cfg.ownerBiliMid ? fetchMessages(undefined, String(cfg.ownerBiliMid), 12) : Promise.resolve({ ok: false, error: '没配 ownerBiliMid' }),
      ])
      return sendJson(res, 200, {
        ok: true,
        state: st,
        ownerMid: String(cfg.ownerBiliMid || ''),
        enabled: cfg.biliDmReply !== false,
        pollMinutes: Number(cfg.biliDmPollMinutes || 10),
        maxPerPoll: Number(cfg.biliDmMaxPerPoll || 3),
        maxPerDay: Number(cfg.biliDmMaxPerDay ?? 20),
        sessions: sess.ok ? sess.items : [],
        sessionsError: sess.ok ? '' : sess.error,
        messages: msgs.ok ? msgs.messages : [],
        messagesError: msgs.ok ? '' : msgs.error,
      })
    }
    // ── B 站日报/周报（手动触发 + 看原始素材）────────────
    if (method === 'GET' && path === 'bili/summary-state') {
      const st = loadSummaryState()
      const act = collectActivity(undefined, Date.now() - 86400000)
      return sendJson(res, 200, { ok: true, state: st, today: { watched: act.watched.length, comments: act.comments.length, dms: act.dms.length } })
    }
    if (method === 'POST' && path === 'bili/summary-now') {
      const body = await readBody(req)
      const kind = body && body.kind === 'weekly' ? 'weekly' : 'daily'
      const r = await runSummary(ctx, loadConfig(), log, { kind, dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    // ── 评论区接话（手动触发 / 调试）────────────
    if (method === 'POST' && path === 'bili/comment-reply-now') {
      const body = await readBody(req)
      const r = await runReplyLoop(ctx, loadConfig(), log, { dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    if (method === 'POST' && path === 'bili/at-now') {
      const body = await readBody(req)
      const r = await runAtLoop(ctx, loadConfig(), log, { dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    // 【她自己决定刷不刷】面板可以问她一次「现在想刷吗」（不真刷，只问）
    if (method === 'POST' && path === 'bili/will-ask') {
      try {
        const { askHerWill, willSnapshot } = await import('./lib/bili/will.mjs')
        const cfgW = loadConfig()
        const dryRun = loadConfig().biliWillDryRun !== false
        // now 可用于调试「假如现在是凌晨 3 点，她会怎么决定」
        const bodyW = await readBody(req).catch(() => ({}))
        const atW = Number(bodyW && bodyW.now) || Date.now()
        const w = await askHerWill(ctx, cfgW, { now: atW, home: stateHome(), log })
        return sendJson(res, 200, { ...w, snapshot: willSnapshot() })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (method === 'POST' && path === 'bili/dm-now') {
      const body = await readBody(req)
      const r = await runDmReply(ctx, loadConfig(), log, { dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    if (method === 'POST' && path === 'bili/comment-now') {
      const body = await readBody(req)
      const r = await runComment(ctx, loadConfig(), log, { dry: Boolean(body && body.dry) })
      return sendJson(res, 200, r)
    }
    // ── 私聊发文件（用她的 QQ 号发给指定 QQ）──────────────
    if (method === 'POST' && path === 'file/upload') {
      const body = await readBody(req)
      const userId = String((body && body.userId) || '').replace(/\D/g, '')
      const filePath = String((body && body.path) || '').trim()
      const name = String((body && body.name) || '').trim()
      if (!userId || !filePath) return sendJson(res, 200, { ok: false, error: '需要 userId 和 path' })
      if (!bridge.client || bridge.client.state !== 'online') return sendJson(res, 200, { ok: false, error: 'QQ 桥不在线' })
      try {
        const params = { user_id: Number(userId), file: filePath }
        if (name) params.name = name
        const r = await bridge.client.call('upload_private_file', params)
        return sendJson(res, 200, { ok: true, result: r })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    }
    // ── 作息（她的白天黑夜）──────────────────────────
    if (method === 'GET' && path === 'schedule') {
      const st = scheduleState(Date.now())
      // 【日程优先】今天有日程就按日程里的当前段说话（比作息推算准）
      try {
        const day = loadDay(stateHome(), dpDateStr())
        const nw = new Date()
        const minute = nw.getHours() * 60 + nw.getMinutes()
        const toMin = (t) => { const p = String(t || '').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0) }
        const item = Array.isArray(day && day.items)
          ? day.items.find((it) => { const a = toMin(it.start); let b = toMin(it.end); if (b <= a) b = 24 * 60; return minute >= a && minute < b })
          : null
        if (item) {
          const hh = String(nw.getHours()).padStart(2, '0') + ':' + String(nw.getMinutes()).padStart(2, '0')
          let asleepNow = true
          try { const m = readMood(stateHome()); if (m && typeof m.asleep === 'boolean') asleepNow = m.asleep } catch {}
          const isSleep = /睡/.test(String(item.activity || ''))
          if (isSleep && !asleepNow) {
            st.text = '现在 ' + hh + '，日程里这个点你在睡觉，不过之前被消息叫醒过，眼下正迷糊着'
          } else {
            st.text = '现在 ' + hh + '，你' + String(item.activity || '待着') + (item.location ? '（' + item.location + '）' : '') + (item.detail ? '——' + item.detail : '')
          }
          st.activity = 'dayplan'
          st.sleeping = isSleep && asleepNow
        }
      } catch {}
      // 【她现在】最近在刷 B 站就说在刷，别只报作息
      try {
        const sched = JSON.parse(readFileSync(join(stateHome(), 'scheduler.json'), 'utf8'))
        const now = Date.now()
        const lastWatch = Number((sched && sched.lastBiliWatchAt) || 0)
        if (lastWatch && now - lastWatch < 10 * 60 * 1000) {
          const d = new Date(now)
          const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
          st.text = '现在 ' + hh + '，你正窝着刷 B 站，刚刷到一个挺有意思的视频，看得正入神'
          st.activity = 'bili'
        }
      } catch {}
      try {
        const mood = readMood(stateHome())
        if (mood && mood.asleep === false && st.sleeping) {
          st.text = String(st.text || '').replace('你已经睡了', '这个点你本该睡着，不过之前被消息吵醒过，眼下醒着')
          st.awake = true
          st.woken = true
        } else if (mood && mood.asleep === true && !st.sleeping) {
          st.text = String(st.text || '') + '（其实还在睡）'
          st.sleeping = true
        }
      } catch {}
      return sendJson(res, 200, { ok: true, schedule: loadSchedule(), state: st })
    }
    if (method === 'POST' && path === 'schedule') {
      const body = await readBody(req)
      const patch = {}
      if (body && Number.isFinite(Number(body.wakeHour))) patch.wakeHour = Math.max(0, Math.min(23, Math.round(Number(body.wakeHour))))
      if (body && Number.isFinite(Number(body.sleepHour))) patch.sleepHour = Math.max(0, Math.min(23, Math.round(Number(body.sleepHour))))
      if (body && typeof body.note === 'string') patch.note = body.note.trim().slice(0, 200)
      saveSchedule(patch)
      return sendJson(res, 200, { ok: true, schedule: loadSchedule(), state: scheduleState(Date.now()) })
    }
    if (method === 'POST' && path === 'schedule/evolve') {
      const r = await evolveSchedule({ ctx, config: loadConfig(), log })
      return sendJson(res, 200, Object.assign({ ok: true, evolved: r }, { schedule: loadSchedule(), state: scheduleState(Date.now()) }))
    }
    // ── 人格演化（她自己长出来的性格变化）──────────────
    if (method === 'GET' && path === 'traits') {
      return sendJson(res, 200, listTraits())
    }
    if (method === 'POST' && path === 'traits') {
      const body = await readBody(req)
      const action = String((body && body.action) || 'add')
      const cfg = loadConfig()
      if (action === 'add') {
        const text = String((body && body.text) || '').trim()
        if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
        addTrait({ text, source: 'manual', pinned: !!(body && body.pinned), maxTraits: cfg.evolveMaxTraits })
        return sendJson(res, 200, listTraits())
      }
      if (action === 'pin' || action === 'update') {
        const patch = action === 'pin'
          ? { pinned: !!(body && body.on) }
          : {
              text: String((body && body.text) || ''),
              pinned: body && typeof body.pinned === 'boolean' ? body.pinned : undefined,
              enabled: body && typeof body.enabled === 'boolean' ? body.enabled : undefined,
            }
        const r = updateTrait(String((body && body.id) || ''), patch)
        if (!r.ok) return sendJson(res, 200, r)
        return sendJson(res, 200, listTraits())
      }
      if (action === 'remove') {
        removeTrait(String((body && body.id) || ''))
        return sendJson(res, 200, listTraits())
      }
      if (action === 'clear') {
        clearTraits()
        return sendJson(res, 200, listTraits())
      }
      return sendJson(res, 200, { ok: false, error: '未知 action' })
    }
    if (method === 'POST' && path === 'traits/evolve') {
      const body = await readBody(req)
      // 全量模式：所有群 + 私聊一起演化
      if (body && (body.all === true || body.all === 'true')) {
        const allResult = await evolveAcrossAll({ ctx, config: loadConfig(), log, limit: Number(body.limit) || 400 })
        return sendJson(res, 200, Object.assign({ ok: true, evolved: allResult }, listTraits()))
      }
      const conversation = String((body && body.conversation) || '')
      const chats = bridge.listChats()
      const fallback = chats && Array.isArray(chats.conversations) && chats.conversations[0] ? String(chats.conversations[0].key) : ''
      const target = conversation || fallback
      if (!target) return sendJson(res, 200, { ok: false, error: '还没有聊天会话' })
      const evolved = await evolveNow({ ctx, conversation: target, config: loadConfig(), log, limit: 60 })
      return sendJson(res, 200, Object.assign({ ok: true, evolved }, listTraits()))
    }
    // ── 人格基准：把当前人设存成「原版」，或一键恢复 ──
    if (method === 'POST' && path === 'persona/base') {
      const cfg = loadConfig()
      const text = String(cfg.persona || '').trim()
      if (!text) return sendJson(res, 200, { ok: false, error: '当前人设是空的' })
      saveConfig({ personaOriginal: text })
      return sendJson(res, 200, { ok: true, config: bridge.publicConfig() })
    }
    if (method === 'POST' && path === 'persona/restore-base') {
      const cfg = loadConfig()
      const base = String(cfg.personaOriginal || '').trim()
      if (!base) return sendJson(res, 200, { ok: false, error: '还没存过基准人格，先点「设为基准」' })
      saveConfig({ persona: base })
      return sendJson(res, 200, { ok: true, config: bridge.publicConfig() })
    }
    // ── 口吻试音：按当前档位生成一句，只回给面板看，不发到 QQ ──
    if (method === 'POST' && path === 'style/test') {
      const cfg = loadConfig()
      const system = systemPrompt(cfg, { channel: 'private' })
      const result = await generateText(ctx, {
        system,
        messages: [{ role: 'user', text: '（这是面板里的试音，不是真的聊天）随便跟我说一句话，让我听听你现在的口吻。只输出正文。' }],
        config: cfg,
        temperature: 1.1,
        timeoutMs: 30_000,
        log: (line) => log.warn(line),
      })
      if (!result || !result.ok) {
        return sendJson(res, 200, { ok: false, error: (result && (result.reason || result.message)) || '生成失败' })
      }
      return sendJson(res, 200, { ok: true, text: cleanReply(result.text, 300) })
    }
    // ── 戳一戳：让面板能立刻试一次（模拟「某人戳了她」，走同一套处理）──
    if (method === 'POST' && path === 'poke/test') {
      const body = await readBody(req)
      const conversation = String((body && body.conversation) || '')
      if (!conversation) return sendJson(res, 200, { ok: false, error: '缺少 conversation' })
      const rows = conversationMessages(conversation, 60)
      const lastIn = [...rows].reverse().find((m) => m && m.direction === 'in' && String(m.senderId || '').trim())
      if (!lastIn) return sendJson(res, 200, { ok: false, error: '这个会话里还没有别人说过话，先聊两句再试' })
      const parts = conversation.split(':')
      const kind = parts[0] === 'group' ? 'group' : 'private'
      const id = String(parts[1] || '')
      const selfId = String(bridge.selfId || '')
      if (!selfId) return sendJson(res, 200, { ok: false, error: '她的账号号还没就绪（QQ 桥可能没连上），等连上再试' })
      const event = {
        post_type: 'notice',
        notice_type: 'notify',
        sub_type: 'poke',
        time: Math.floor(Date.now() / 1000),
        self_id: Number(selfId) || undefined,
        user_id: Number(lastIn.senderId),
        target_id: Number(selfId) || undefined,
        sender: { user_id: Number(lastIn.senderId), nickname: String(lastIn.who || '') },
      }
      if (kind === 'group') event.group_id = Number(id)
      try {
        bridge.engine.handle(event).catch((e) => log.warn('处理消息失败：' + ((e && e.message) || e)))
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
      return sendJson(res, 200, { ok: true, who: String(lastIn.who || lastIn.senderId) })
    }
    // ── 自主学习（她自己从聊天里记下来的人和事）──────────
    if (method === 'GET' && path === 'learned') {
      return sendJson(res, 200, listFacts())
    }
    if (method === 'POST' && path === 'learned') {
      const body = await readBody(req)
      const action = String((body && body.action) || 'add')
      const cfg = loadConfig()
      if (action === 'add') {
        const text = String((body && body.text) || '').trim()
        if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
        const subject = String((body && body.subject) || '').trim()
        const subjectId = String((body && body.subjectId) || '').replace(/\D/g, '')
        addFact({
          text,
          subject,
          subjectId,
          conversation: String((body && body.conversation) || ''),
          channel: String((body && body.channel) || ''),
          source: 'manual',
          pinned: !!(body && body.pinned),
          maxItems: cfg.autoLearnMaxItems,
        })
        return sendJson(res, 200, listFacts())
      }
      if (action === 'pin' || action === 'update') {
        const patch = action === 'pin'
          ? { pinned: !!(body && body.on) }
          : { text: String((body && body.text) || ''), pinned: body && typeof body.pinned === 'boolean' ? body.pinned : undefined }
        const r = updateFact(String((body && body.id) || ''), patch)
        if (!r.ok) return sendJson(res, 200, r)
        return sendJson(res, 200, listFacts())
      }
      if (action === 'remove') {
        removeFact(String((body && body.id) || ''))
        return sendJson(res, 200, listFacts())
      }
      if (action === 'clear') {
        clearFacts(String((body && body.conversation) || ''))
        return sendJson(res, 200, listFacts())
      }
      return sendJson(res, 200, { ok: false, error: '未知 action' })
    }
    if (method === 'POST' && path === 'learn-now') {
      const body = await readBody(req)
      const conversation = String((body && body.conversation) || '')
      const wantAll = !conversation || body.all === true || body.all === 'true'
      if (!conversation && !wantAll) return sendJson(res, 200, { ok: false, error: '缺少 conversation' })
      const result = await learnNow({ ctx, conversation: conversation || 'all', config: loadConfig(), log, source: 'manual', all: wantAll, limit: 400 })
      return sendJson(res, 200, Object.assign({ ok: true, learned: result }, listFacts()))
    }
    // ── B站（只读）──────────────────────────────
    if (method === 'GET' && path === 'bili/status') {
      const acc = loadBiliAccount()
      return sendJson(res, 200, { ok: true, mid: acc.mid, name: acc.name, hasCredentials: acc.hasCredentials })
    }
    if (method === 'GET' && path === 'bili/dynamics') {
      return sendJson(res, 200, await fetchMyDynamics())
    }
    if (method === 'GET' && path.startsWith('bili/video/')) {
      const bv = decodeURIComponent(path.slice('bili/video/'.length))
      return sendJson(res, 200, await fetchVideoInfo(bv))
    }
    // ── 表情包情绪分布 + 发送额度 ───────────────────────────
    if (method === 'GET' && path === 'sticker-moods') {
      const cfg = loadConfig()
      const all = listStickers()
      const counts = {}
      for (const s of all) { if (s.mood) counts[s.mood] = (counts[s.mood] || 0) + 1 }
      const tagged = Object.values(counts).reduce((a, b) => a + b, 0)
      const st = loadStickerState(stickerStatePath(stateHome()))
      const summary = stickerStateSummary(st, {
        cooldownSec: cfg.stickerCooldownSec,
        maxPerDay: cfg.stickerMaxPerDay,
      })
      return sendJson(res, 200, { ok: true, total: all.length, tagged, moods: STICKER_MOODS, counts, state: summary })
    }
    // ── 语音识别 ─────────────────────────────────────────────
    if (method === 'GET' && path === 'asr/providers') {
      return sendJson(res, 200, { ok: true, providers: ASR_PROVIDERS })
    }
    if (method === 'POST' && path === 'asr/test') {
      const body = await readBody(req)
      const cfg = loadConfig()
      const r = await asrTest({
        provider: String((body && body.provider) || cfg.asrProvider),
        apiKey: String((body && body.apiKey) || cfg.asrApiKey),
        endpoint: String((body && body.endpoint) || cfg.asrEndpoint),
        model: String((body && body.model) || cfg.asrModel),
        language: String((body && body.language) || cfg.asrLanguage),
      })
      return sendJson(res, 200, Object.assign({ ok: r.ok }, r))
    }
    // ── 心情 ────────────────────────────────────────────────
    if (method === 'GET' && path === 'mood') {
      return sendJson(res, 200, { ok: true, mood: await moodView() })
    }
    if (method === 'POST' && path === 'mood/adjust') {
      const body = await readBody(req)
      const deltas = (body && body.deltas) || {}
      const next = applyMoodEvent(readMood(stateHome()), deltas, { reason: String((body && body.reason) || '面板手动调节') })
      writeMood(stateHome(), next)
      return sendJson(res, 200, { ok: true, mood: moodSnapshot(next) })
    }
    if (method === 'POST' && path === 'mood/reset') {
      const empty = applyMoodEvent(readMood(stateHome()), { }, { reason: 'reset' })
      writeMood(stateHome(), { ...empty, current: { ...empty.base }, events: [], composite: { label: '', dims: [] } })
      return sendJson(res, 200, { ok: true, mood: await moodView() })
    }
    // ── 日记 / 复盘 ─────────────────────────────────────────
    if (method === 'GET' && path === 'diary') {
      const diary = loadDiary(join(stateHome(), 'diary.json'))
      return sendJson(res, 200, { ok: true, entries: diary.entries.slice(-80).reverse(), reviews: listReviews(diary, null, 30) })
    }
    if (method === 'POST' && path === 'diary/generate') {
      const body = await readBody(req)
      const home = stateHome()
      const cfg = loadConfig()
      const day = String((body && body.date) || '')
      const msgs = recentMessages(200)
      const r = await generateDiary(ctx, { stateHome: home, config: cfg, log, messages: msgs })
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error })
      let diary = loadDiary(join(home, 'diary.json'))
      diary = appendEntry(diary, { text: r.text, source: 'manual', moodLabel: (moodSnapshot(readMood(home)).composite || '') })
      saveDiary(join(home, 'diary.json'), diary)
      return sendJson(res, 200, { ok: true, text: r.text, entries: diary.entries.slice(-20).reverse() })
    }
    if (method === 'POST' && path === 'review/generate') {
      const body = await readBody(req)
      const kind = String((body && body.kind) || 'daily')
      const home = stateHome()
      const diary = loadDiary(join(home, 'diary.json'))
      const entries = entriesInPeriod(diary, kind)
      const r = await generateReview(ctx, { config: loadConfig(), log, kind, entries })
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error })
      const next = saveReview(diary, kind, Date.now(), r.text, { count: entries.length })
      saveDiary(join(home, 'diary.json'), next)
      return sendJson(res, 200, { ok: true, kind, text: r.text })
    }
    // ── 承诺 ────────────────────────────────────────────────
    if (method === 'GET' && path === 'promises') {
      return sendJson(res, 200, { ok: true, promises: promiseSnapshot(loadPromises(join(stateHome(), 'promises.json'))) })
    }
    if (method === 'POST' && path === 'promise/action') {
      const body = await readBody(req)
      const id = String((body && body.id) || '')
      const action = String((body && body.action) || '')
      const p = join(stateHome(), 'promises.json')
      let data = loadPromises(p)
      if (action === 'done') data = markPromiseDone(data, id)
      else if (action === 'missed') data = markPromiseMissed(data, id)
      else if (action === 'remove') data = removePromise(data, id)
      else if (action === 'add') data = addPromise(data, { text: String((body && body.text) || ''), dueAt: Number((body && body.dueAt) || 0), source: 'manual' })
      savePromises(p, data)
      return sendJson(res, 200, { ok: true, promises: promiseSnapshot(data) })
    }
    // ── B站日报 ─────────────────────────────────────────────
    if (method === 'GET' && path === 'bili-daily') {
      const data = loadBiliDaily(join(stateHome(), 'bili-daily.json'))
      return sendJson(res, 200, { ok: true, latest: latestReport(data), reports: data.reports.slice(-10).reverse() })
    }
    if (method === 'POST' && path === 'bili-daily/generate') {
      const home = stateHome()
      const cfg = loadConfig()
      const kw = String(cfg.biliTasteKeywords || '').split(/[,，\s]+/).filter(Boolean)
      const ex = String(cfg.biliExcludeKeywords || '').split(/[,，\s]+/).filter(Boolean)
      const videos = await biliBrowse(loadBiliAuth(), { count: 6, maxSubtitleChars: 900 })
      if (!videos.length) return sendJson(res, 200, { ok: false, error: '没挑到视频' })
      const r = await generateReport(ctx, { config: cfg, log, videos, personaName: cfg.personaName })
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error })
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      const date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
      let data = loadBiliDaily(join(home, 'bili-daily.json'))
      data = appendReport(data, { date, text: r.text, videos })
      saveBiliDaily(join(home, 'bili-daily.json'), data)
      // 顺手点赞/收藏（默认关，开关在面板）
      const acted = await applyBiliActions(loadBiliAuth(), cfg, videos, log)
      return sendJson(res, 200, { ok: true, date, text: r.text, videos, acted, latest: latestReport(data) })
    }
    // ── 表情包：分组 / 统计 / 去重 ────────────────
    if (method === 'GET' && path === 'stickers/packs') {
      return sendJson(res, 200, { ok: true, packs: listPacks(), total: listStickers().length })
    }
    if (method === 'GET' && path === 'stickers/top') {
      const u = new URL(req.url, 'http://x')
      const limit = Number(u.searchParams.get('limit')) || 10
      return sendJson(res, 200, { ok: true, stickers: topStickers(limit) })
    }
    if (method === 'GET' && path === 'stickers/dups') {
      return sendJson(res, 200, { ok: true, groups: findDuplicates() })
    }
    if (method === 'POST' && path === 'stickers/use') {
      const body = await readBody(req)
      const file = String((body && body.file) || '').trim()
      if (!file) return sendJson(res, 200, { ok: false, error: '缺少 file' })
      return sendJson(res, 200, { ok: bumpStickerUse(file), file })
    }
    if (method === 'GET' && path === 'stickers') {
      return sendJson(res, 200, { ok: true, stickers: listStickers() })
    }
    if (method === 'GET' && path.startsWith('stickers/file/')) {
      const name = decodeURIComponent(path.slice('stickers/file/'.length))
      // 允许子目录（astrbot/<包>/<分类>/<文件>）与中文文件名，但必须落在表情库目录内
      const baseDir = resolve(stickerDir())
      const full = resolve(baseDir, name)
      if (full !== baseDir && !full.startsWith(baseDir + sep)) return sendJson(res, 400, { ok: false, error: '非法文件名' })
      const ext = name.split('.').pop().toLowerCase()
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      return sendBinary(res, full, mime)
    }
    if (method === 'POST' && path === 'stickers/upload') {
      const body = await readBody(req)
      const rawName = String((body && body.name) || 'upload').replace(/[^A-Za-z0-9._-]/g, '')
      const b64 = String((body && body.data) || '').replace(/^data:[^,]+,/, '')
      if (!b64) return sendJson(res, 200, { ok: false, error: '没有图片数据' })
      let buf
      try { buf = Buffer.from(b64, 'base64') } catch { return sendJson(res, 200, { ok: false, error: 'base64 解析失败' }) }
      if (!buf || buf.length < 200) return sendJson(res, 200, { ok: false, error: '图片太小' })
      if (buf.length > 8 * 1024 * 1024) return sendJson(res, 200, { ok: false, error: '图片太大（>8MB）' })
      const isPng = buf[0] === 0x89 && buf[1] === 0x50
      const isGif = buf.slice(0, 3).toString('latin1') === 'GIF'
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8
      if (!isPng && !isGif && !isJpg) return sendJson(res, 200, { ok: false, error: '只支持 png/jpg/gif' })
      const ext = isPng ? '.png' : isGif ? '.gif' : '.jpg'
      const base = rawName.replace(/\.[A-Za-z0-9]+$/, '') || 'upload'
      const file = 'own_' + Date.now().toString(36) + '_' + base.slice(0, 24) + ext
      writeFileSync(join(stickerDir(), file), buf)
      const idx = loadIndex()
      idx.stickers.push({ file, size: buf.length, savedAt: Date.now(), from: '用户上传', channel: 'upload', tags: ['她自己', '本尊'] })
      writeFileSync(join(stickerDir(), 'index.json'), JSON.stringify(idx, null, 2))
      return sendJson(res, 200, { ok: true, file, stickers: listStickers() })
    }
    if (method === 'POST' && path === 'stickers/delete') {
      const body = await readBody(req)
      const name = String((body && body.file) || '')
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return sendJson(res, 200, { ok: false, error: '非法文件名' })
      try { unlinkSync(join(stickerDir(), name)) } catch {}
      const idx = loadIndex()
      idx.stickers = idx.stickers.filter((x) => x.file !== name)
      writeFileSync(join(stickerDir(), 'index.json'), JSON.stringify(idx, null, 2))
      return sendJson(res, 200, { ok: true, stickers: listStickers() })
    }
    if (method === 'POST' && path === 'stickers/tag') {
      const body = await readBody(req)
      const name = String((body && body.file) || '')
      const tag = String((body && body.tag) || '本尊').slice(0, 20)
      const on = !!(body && body.on)
      const idx = loadIndex()
      const hit = idx.stickers.find((x) => x.file === name)
      if (!hit) return sendJson(res, 200, { ok: false, error: '没找到这张' })
      hit.tags = Array.isArray(hit.tags) ? hit.tags : []
      if (on && !hit.tags.includes(tag)) hit.tags.push(tag)
      if (!on) hit.tags = hit.tags.filter((x) => x !== tag)
      writeFileSync(join(stickerDir(), 'index.json'), JSON.stringify(idx, null, 2))
      return sendJson(res, 200, { ok: true, stickers: listStickers() })
    }


    // ── 长期记忆（手动记下的事，每次进提示词） ──
    if (method === 'GET' && path === 'memories') {
      const cfg = loadConfig()
      return sendJson(res, 200, { ok: true, memories: Array.isArray(cfg.memories) ? cfg.memories : [] })
    }
    // ── 上下文查看 / 编辑 ──
    if (method === 'GET' && path === 'context') {
      const conversation = String(url.searchParams.get('conversation') || '')
      if (!conversation) return sendJson(res, 200, { ok: false, error: '缺少 conversation' })
      const limit = Number(url.searchParams.get('limit') || 200)
      return sendJson(res, 200, { ok: true, conversation, messages: conversationMessages(conversation, limit) })
    }

    // 写操作
    if (method === 'POST' && path === 'memories') {
      const body = await readBody(req)
      const cfg = loadConfig()
      const list = (Array.isArray(cfg.memories) ? cfg.memories : []).filter((m) => m && typeof m === 'object')
      const action = String((body && body.action) || 'add')
      const text = String((body && body.text) || '').trim().slice(0, 500)
      const id = String((body && body.id) || '')
      if (action === 'add') {
        if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
        list.push({ id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, at: Date.now() })
      } else if (action === 'update') {
        const hit = list.find((m) => m.id === id)
        if (!hit) return sendJson(res, 200, { ok: false, error: '没找到这条记忆' })
        if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
        hit.text = text
      } else if (action === 'remove') {
        const idx = list.findIndex((m) => m.id === id)
        if (idx >= 0) list.splice(idx, 1)
      } else if (action === 'clear') {
        list.length = 0
      } else if (action === 'replace') {
        // 面板整块编辑：按行拆，一次覆盖（最简单也最不容易出现半更新）
        const lines = String((body && body.text) || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200)
        list.length = 0
        for (const line of lines) {
          list.push({ id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: line.slice(0, 500), at: Date.now() })
        }
      } else {
        return sendJson(res, 200, { ok: false, error: '未知 action' })
      }
      saveConfig({ memories: list.slice(0, 200) })
      return sendJson(res, 200, { ok: true, memories: list })
    }
    if (method === 'POST' && path === 'context/delete') {
      const body = await readBody(req)
      const conversation = String((body && body.conversation) || '')
      if (!conversation) return sendJson(res, 200, { ok: false, error: '缺少 conversation' })
      const r = deleteMessages(conversation, (body && body.ts) || [])
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (method === 'POST' && path === 'context/clear') {
      const body = await readBody(req)
      const conversation = String((body && body.conversation) || '')
      if (!conversation) return sendJson(res, 200, { ok: false, error: '缺少 conversation' })
      const r = clearConversation(conversation)
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (method === 'POST' && path === 'config') {
      const body = await readBody(req)
      return sendJson(res, 200, bridge.updateConfig(body && body.patch ? body.patch : body))
    }
    if (method === 'POST' && path === 'persona/reset') {
      saveConfig({ persona: DEFAULT_PERSONA })
      return sendJson(res, 200, { ok: true, config: bridge.publicConfig() })
    }
    if (method === 'POST' && path === 'safety/ack') return sendJson(res, 200, bridge.ackSafety())

    if (method === 'POST' && path === 'provision/install') {
      const body = await readBody(req)
      return sendJson(res, 200, await bridge.installNapcat(body || {}))
    }
    if (method === 'POST' && path === 'provision/start') {
      await bridge.startNapcat()
      return sendJson(res, 200, { ok: true, provision: bridge.provisionSnapshot() })
    }
    if (method === 'POST' && path === 'provision/kill-qq') {
      return sendJson(res, 200, await bridge.killQQForNapcat())
    }
    if (method === 'POST' && path === 'provision/stop') {
      await bridge.stopNapcat()
      return sendJson(res, 200, { ok: true, provision: bridge.provisionSnapshot() })
    }
    if (method === 'POST' && path === 'provision/cancel-install') {
      return sendJson(res, 200, bridge.cancelInstall())
    }
    if (method === 'POST' && path === 'provision/detect') {
      await bridge.detectProvision()
      return sendJson(res, 200, { ok: true, provision: bridge.provisionSnapshot() })
    }
    if (method === 'POST' && path === 'provision/setup-external') {
      const body = await readBody(req)
      return sendJson(res, 200, await bridge.setupExternal(body || {}))
    }
    if (method === 'POST' && path === 'provision/use-managed') {
      return sendJson(res, 200, await bridge.useManaged())
    }

    if (method === 'POST' && path === 'login/start') return sendJson(res, 200, await bridge.loginStart())
    if (method === 'POST' && path === 'login/refresh') return sendJson(res, 200, await bridge.loginRefresh())
    if (method === 'POST' && path === 'login/poll') return sendJson(res, 200, await bridge.loginPoll())
    if (method === 'POST' && path === 'login/quick') {
      const body = await readBody(req)
      return sendJson(res, 200, await bridge.quickLogin(body.uin || ''))
    }

    if (method === 'POST' && path === 'send') {
      const body = await readBody(req)
      return sendJson(res, 200, await bridge.sendMessage(body || {}))
    }
    if (method === 'POST' && path === 'contacts/sync') return sendJson(res, 200, await bridge.syncContacts())

    if (method === 'POST' && path === 'push/now') {
      const body = await readBody(req)
      const result = await bridge.pushNow(body && body.target)
      return sendJson(res, 200, result)
    }
    if (method === 'POST' && path === 'whisper/now') return sendJson(res, 200, await bridge.whisperNow())
    if (method === 'POST' && path === 'emergency-stop') return sendJson(res, 200, await bridge.emergencyStop())

    return sendJson(res, 404, { ok: false, error: `未知接口：${method} ${url.pathname}` })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
          } catch (e) {
            const message = String((e && e.message) || e)
            const code = (e && e.code) || 'internal-error'
            if (code === 'internal-error') log.error(`接口出错：${message}`)
            try {
              sendJson(res, 200, { ok: false, error: message, code })
            } catch {}
          }
        },
      }),
    'qq-fish: /api/qq-fish 路由',
  )

  ctx.effect(() => {
    bridge.init().catch((e) => log.error('桥接初始化失败：' + String((e && e.message) || e)))
    // 记忆卡：启动后 30 秒先维护一次，之后每 10 分钟衰减/摄取
    const memTimer = setTimeout(() => {
      try { memoryMaintain(Date.now(), { config: loadConfig() }) } catch (e) { log.warn('记忆卡首次维护失败：' + ((e && e.message) || e)) }
    }, 30_000)
    memTimer.unref?.()
    const memInterval = setInterval(() => {
      try { memoryMaintain(Date.now(), { config: loadConfig() }) } catch (e) { log.warn('记忆卡维护失败：' + ((e && e.message) || e)) }
    }, 10 * 60 * 1000)
    memInterval.unref?.()

    // 【每日任务】日记 / 复盘 / B站日报：每分钟看一眼到点了没，实际是否执行由 needs* 判断
    const dailyTimer = setInterval(async () => {
      try { await runDailyTasks(ctx, log) } catch (e) { log.warn('每日任务失败：' + ((e && e.message) || e)) }
    }, 60 * 1000)
    dailyTimer.unref?.()
    return () => {
      // 卸载时必须停掉这两个，否则每重载一次就多跑一份记忆维护
      try { clearTimeout(memTimer) } catch {}
      try { clearInterval(memInterval) } catch {}
      bridge.dispose()
    }
  }, 'qq-fish: 桥接生命周期')

  log.info(`已挂载 v${PKG.version}，家目录 ${stateHome()}`)
}
