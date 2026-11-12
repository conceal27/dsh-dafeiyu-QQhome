/**
 * lib/push.mjs — 主动推送 + 碎碎念（归属：xingzhu）
 * ============================================================================
 * 两件「小肥鱼主动开口」的事：
 *   1. 主动推送  ：隔一阵由她先发一条（关心/接上文/刚想到的事）；
 *   2. 碎碎念    ：隔一阵自言自语一条（今天看到什么、值不值得）。
 * 安全默认：
 *   - 默认关；开了以后也只在 activeStart–activeEnd（默认 09:00–23:00）内发；
 *   - 每 pushMinIntervalMinutes / whisperMinIntervalMinutes 才发一次；
 *   - 全局每小时最多 maxProactivePerHour 条；
 *   - pushOnlyAfterTalk 打开时，没有聊过天的对象不主动开口（防骚扰）；
 *   - 模型觉得没必要可输出 [跳过]，我们就真的不发。
 * ============================================================================
 */
import { generateText, normalizeUsage } from './llm.mjs'
import { cleanReply, parseSkip, pushPrompt, systemPrompt, whisperPrompt } from './persona.mjs'
import { extractKeywords, searchRelated, recentNotes, renderRelated, renderNotes } from './memory.mjs'
import { purposeGate, recordDelivered, recordSkip, status as purposeStatus, inQuiet, coolingGate, recordCoolingSent, recordCoolingSkip } from './purpose.mjs'
import { computeDrive } from './drive.mjs'
import { recordProactive } from './social.mjs'
import { findRepeat } from './reply-guard.mjs'
import { activeIntents, finishIntent } from './intent.mjs'
import { shareAllowance, pickShareCandidate, markShared, sharePromptBlock, buildShareCard, shareChannelHint } from './bilishare.mjs'
import { sendDm as biliSendDm } from './bili/dm.mjs'
import { dynamicBudget } from './bili/dynamic.mjs'
import { commentBudget } from './bili/comment.mjs'
import { tick as daystreamTick } from './daystream.mjs'
import { addWakes, takeOneDue, wakePrompt } from './selfwake.mjs'
import { extractStateMarker, setState } from './her-state.mjs'
import { runDynamic, runComment } from './bili/auto.mjs'
import { runDmReply } from './bili/dm-chat.mjs'
import { runSummary, loadSummaryState, saveSummaryState, dayKey, weekKey } from './bili/summary.mjs'
import { runReplyLoop } from './bili/reply-loop.mjs'
import { runAtLoop } from './bili/at-loop.mjs'
import { watchOne } from './biliwatch.mjs'
import { biliAutoAllowed, sleepState, sleepReason } from './bili/awake.mjs'
import { askHerWill, recordHerWatch, willSnapshot as biliWillSnapshot } from './bili/will.mjs'
import { ensureBiliSchedule, dueSlot, markSlotTriggered } from './bili/schedule.mjs'
import { webSearch } from './search.mjs'
import { loadAuth, getCommentReplies } from './bili/client.mjs'
import { readFileSync as fsRead, writeFileSync as fsWrite } from 'node:fs'
import { splitIntoBubbles } from './bubbles.mjs'
import { ensureDailyClaim } from './breeze-claim.mjs'

/**
 * 按气泡把一段文字分条发出去。
 * 以前主动消息/B站分享直接 bridge.send(整段)，文字里的换行在 QQ 里就是"一条大长条"。
 */
async function sendBubbles(bridge, target, body, config, log) {
  const text = String(body || '').trim()
  if (!text) return
  let chunks = [text]
  try {
    if (!config || config.splitBubbles !== false) {
      const got = splitIntoBubbles(text, config || {})
      if (got && got.length) chunks = got
    }
  } catch {}
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      const gap = 600 + Math.floor(Math.random() * 1200)
      await new Promise((r) => setTimeout(r, gap))
    }
    try { log && log.info('[气泡] (推送) ' + (i + 1) + '/' + chunks.length + ' ' + String(chunks[i]).length + '字：' + String(chunks[i]).slice(0, 40)) } catch {}
    await bridge.send(target, chunks[i])
  }
}

import { addMemory } from './memory-decay.mjs'
import { diaryPath, loadDiary, saveDiary, appendEntry, needsDiary, generateDiary } from './sc/diary.mjs'
import { readOne } from './reading.mjs'
import { tickOrganic, restoreTension } from './organic.mjs'
import { readMood, writeMood, driftMood } from './vitals.mjs'
import { tickQzoneAuto } from './qzone-auto.mjs'
import { tickQzoneScroll } from './qzone-scroll.mjs'

/** 主动推送/碎碎念没有发图能力：把模型写出的 [sticker:xxx] / [[sticker:xxx]] 占位符清掉 */
function stripStickerMarkers(text) {
  return String(text || '')
    .replace(/\[{1,2}\s*sticker\s*:[^\]\n]{1,80}\]{1,2}/gi, '')
    .replace(/\[{1,2}\s*img\s*:[^\]\n]{1,200}\]{1,2}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
import { maskUin } from './redact.mjs'
import { appendMessage, bumpStats, loadConfig, pathOf, readJson, recentMessages, writeJsonAtomic, stateHome } from './store.mjs'
import { syncTasks } from './memo.mjs'
import { recordUsage } from './usage.mjs'
import { loadDay, saveDay, generateDay, dateStr, injectionText as dayplanInjection } from './dayplan.mjs'
import { currentWeather, weatherPromptBlock } from './weather.mjs'
import { distill as selfDistill } from './self-distill.mjs'

const HOUR = 3_600_000

function timeText(date = new Date()) {
  const h = date.getHours()
  const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  return `${emoji} ${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function inActiveHours(config, date = new Date()) {
  const hour = date.getHours()
  const start = Number(config.activeStart)
  const end = Number(config.activeEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return true
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end // 跨午夜
}

function targetLabel(target) {
  if (!target) return ''
  return target.name ? `${target.name}（${maskUin(target.id)}）` : maskUin(target.id)
}

/**
 * 把插件内部的目标（{kind,id,name}，来自 config 或会话列表）翻译成 OneBotClient 要的形状：
 * 私聊 {kind:'private', userId, id, name} / 群聊 {kind:'group', groupId, id, name}。
 * 注意：config 里只存 kind/id/name，没有 userId/groupId —— 直接把它丢给 bridge.send
 * 会导致 user_id=null 发不出去（2026-10-26 真机验证抓到的 bug）。
 */
export function toOneBotTarget(target) {
  if (!target) return null
  const kind = target.kind === 'group' ? 'group' : 'private'
  const id = String(target.id || target.groupId || target.userId || '').replace(/\D/g, '')
  if (!id) return null
  const name = String(target.name || '')
  return kind === 'group' ? { kind, id, groupId: id, name } : { kind, id, userId: id, name }
}

function sameTarget(a, b) {
  if (!a || !b) return false
  return a.kind === b.kind && String(a.id) === String(b.id)
}

export class ProactiveScheduler {
  constructor(options) {
    this.ctx = options.ctx
    this.getBridge = options.getBridge
    this.getConfig = options.getConfig || loadConfig
    this.log = options.log || console
    this.timer = null
    this.state = readJson(pathOf('scheduler.json'), { lastPushAt: 0, lastWhisperAt: 0, proactiveTimes: [] })
    this.running = false
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 45_000)
    // 启动 20 秒后先跑一次，用户不用等下一个 tick
    this.bootTimer = setTimeout(() => this.tick(), 20_000)
    this.bootTimer.unref?.()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.bootTimer) {
      clearTimeout(this.bootTimer)
      this.bootTimer = null
    }
  }

  save() {
    this.state.proactiveTimes = (this.state.proactiveTimes || []).filter((t) => Date.now() - t < HOUR)
    writeJsonAtomic(pathOf('scheduler.json'), this.state)
  }

  /** 面板用：上次/下次时间与是否处于安静时段 */
  snapshot(config) {
    const cfg = config || this.getConfig()
    const lastPushAt = Number(this.state.lastPushAt || 0)
    const lastWhisperAt = Number(this.state.lastWhisperAt || 0)
    const pushGap = Math.max(15, Number(cfg.pushMinIntervalMinutes || 90)) * 60_000
    const whisperGap = Math.max(15, Number(cfg.whisperMinIntervalMinutes || 45)) * 60_000
    return {
      push: { lastAt: lastPushAt, nextAt: lastPushAt ? lastPushAt + pushGap : Date.now() },
      whisper: { lastAt: lastWhisperAt, nextAt: lastWhisperAt ? lastWhisperAt + whisperGap : Date.now() },
      quietNow: !inActiveHours(cfg),
    }
  }

  /** 最近一次聊过天的私聊/群聊对象（用来给「没显式指定目标」的情况兜底） */
  lastConversation() {
    const rows = recentMessages(300)
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (!row || row.direction !== 'in') continue
      if (!row.uin) continue
      return {
        kind: row.channel === 'group' ? 'group' : 'private',
        id: String(row.uin),
        name: row.who || '',
      }
    }
    return null
  }

  resolveTarget(config) {
    const explicit = config.pushTarget || null
    if (explicit) return explicit
    if (!config.pushOnlyAfterTalk) return null
    return this.lastConversation()
  }

  resolveWhisperTarget(config) {
    if (config.whisperTarget) return config.whisperTarget
    return this.resolveTarget(config)
  }

  canProactive(config, now) {
    if (!this.getBridge() || this.getBridge().state !== 'online') return { ok: false, reason: 'QQ 桥不在线' }
    // 这里只留技术性保护，不再有「行为围栏」：
    //  · 一分钟内不重复发（防连发）
    //  · 一小时最多 10 条（QQ 对高频发言有风控，这是保号，不是限制她想不想说）
    // 「她该不该少说」交给 social.mjs 的社交状态决定。
    const lastPushAt = Number(this.state.lastPushAt || 0)
    if (lastPushAt && now - lastPushAt < 60_000) return { ok: false, reason: '刚说过话' }
    const times = (this.state.proactiveTimes || []).filter((t) => now - t < HOUR)
    if (times.length >= 10) return { ok: false, reason: '本小时发言过多（防风控）' }
    return { ok: true }
  }

  /**
   * 【生活循环】纯规则推进，零 token：
   *   - 日程里的室外安排碰上雨雪 → 就地改成室内（不然她说"晒太阳"外面在下暴雨）
   *   - 只改「当前及之后」的条目，过去的记录不动
   * 这里**故意不调模型**：这是每天跑几十次的东西，调一次就是在烧钱。
   */
  async lifeTick(config, now) {
    try {
      const home = stateHome()
      const d = new Date(now)
      const day = loadDay(home, dateStr(d))
      if (!day || !Array.isArray(day.items) || !day.items.length) return { ok: false, reason: '没日程' }
      let wx = null
      try { wx = await currentWeather(undefined, config) } catch {}
      const kind = String((wx && (wx.kind || wx.weather || wx.code)) || '').toLowerCase()
      const wet = /rain|snow|thunder|storm|drizzle/.test(kind)
      if (!wet) return { ok: true, changed: 0 }
      const minute = d.getHours() * 60 + d.getMinutes()
      const toMin = (t) => { const p = String(t || '00:00').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0) }
      let changed = 0
      for (const it of day.items) {
        if (toMin(it.end) <= minute) continue
        const outdoor = it.indoor === false || (!it.indoor && /出门|出去|散步|逛逛|晒太阳|公园|街上|超市|便利店|露台|阳台/.test(String(it.activity || '') + ' ' + String(it.location || '')))
        if (!outdoor) continue
        it.activity = '被雨困在屋里'
        it.location = '客厅'
        it.indoor = true
        it.detail = (it.detail ? it.detail + '；' : '') + '外面下' + (/snow/.test(kind) ? '雪' : '雨') + '，原计划泡汤了'
        changed++
      }
      if (changed) {
        saveDay(home, day)
        this.log.info('[生活] 天气变了，改了 ' + changed + ' 段室外安排')
      }
      return { ok: true, changed }
    } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  }

  /** B站自己逛的冷却参数：复用主动消息那套 purpose-engine 判定，只是间隔/上限换成 B 站自己的键 */
  biliWatchCooling(config) {
    return {
      gapMinMs: Math.max(30, Number((config && config.biliWatchMinGapMinutes) || 180)) * 60_000,
      gapMaxMs: Math.max(30, Number((config && config.biliWatchMaxGapMinutes) || 180)) * 60_000,
      dailyMax: Math.max(1, Number((config && config.biliWatchDailyMax) || 4)),
      idleThresholdMs: Math.max(5, Number((config && config.biliWatchOwnerIdleMinutes) || 30)) * 60_000,
    }
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      const config = this.getConfig()
      const now = Date.now()
      // 【B站闸门·统一】2026-11-12（第三版，按主人三句话重划）
      //   ①「他睡觉了不要刷b站了」       → 会到他眼前的动作（分享/私信/@/评论接话/日报）他睡了就不做
      //   ②「如果他晚上决定熬夜可以晚上刷」→ 他醒着，她也可以醒着
      //   ③「就是让他根据自己来，给他权利让他决定自己要做什么」→ 她自己做的事不做钟点排班
      // 这个变量只用来挡「会到他眼前」的那几种（reply/at/dm 在 350 行附近用到）；
      // 她自己逛/动态/评论的判定在各自段落里用 biliAutoAllowed(kind)，语义不同，别混用。
      const sleepSt = (() => { try { return sleepState({ now, config }) } catch { return { blocked: false, asleep: false, ownerAsleep: false } } })()
      const biliSleeping = !!sleepSt.blocked
      const biliOwnerAsleep = !!sleepSt.ownerAsleep
      if ((biliSleeping || biliOwnerAsleep) && (!this.state._lastBiliSleepGateLogAt || now - this.state._lastBiliSleepGateLogAt > 60 * 60 * 1000)) {
        this.state._lastBiliSleepGateLogAt = now
        let why = ''
        try { why = sleepReason(sleepSt) } catch {}
        if (biliOwnerAsleep) why = '主人那边安静了（他睡了），会到他眼前的 B 站动作都不做'
        this.log.info('[B站·闸门] ' + (why || '睡着/安静时段'))
      }
      // 【备忘】到点的定时任务塞进 selfwake，下一段自唤醒逻辑会当真发出去
      try { syncTasks(stateHome(), now, this.log) } catch (e) { this.log.warn('备忘同步失败：' + ((e && e.message) || e)) }
      // 【断片】上次心跳隔太久 = 中间死过。她该知道自己断过，而不是当没发生。
      try {
        const lastTickAt = Number(this.state.lastTickAt || 0)
        if (lastTickAt && now - lastTickAt > 5 * 60 * 1000) {
          const min = Math.round((now - lastTickAt) / 60000)
          this.log.info('[断片] 中间断了 ' + min + ' 分钟')
          try { addMemory('我断片了 ' + min + ' 分钟，中间发生什么完全不记得', { importance: 72, config }) } catch {}
        }
        this.state.lastTickAt = now
      } catch {}
      // 【自唤醒】她自己约的时间到了 —— 当成她想起来了，不是闹钟响
      // 措辞在 wakePrompt() 里：给处境不给台词，说不说她自己定
      try {
        const w = takeOneDue(stateHome(), now)
        if (w) {
          const tgt = this.resolveTarget(config)
          const br = this.getBridge()
          if (tgt && br && br.state === 'online') {
            const res = await generateText(this.ctx, {
              system: systemPrompt(config, { channel: 'push', ownerMode: true, personaOverride: String(config.personaOwner || '').trim() }),
              messages: [{ role: 'user', text: wakePrompt(w) }],
              config,
              temperature: 1.05,
              maxTokens: 320,
              timeoutMs: 45_000,
              log: (line) => this.log.warn(line),
            })
            const raw = res && res.ok ? String(res.text || '') : ''
            const txt = raw ? cleanReply(parseSkip(raw), 300) : ''
            if (txt && txt.trim()) {
              await br.send(toOneBotTarget(tgt), txt)
              this.log.info('[自唤醒] ' + w.hhmm + ' 她开口了：' + txt.slice(0, 40))
            } else {
              this.log.info('[自唤醒] ' + w.hhmm + ' 她这次没说（' + (raw ? '自己跳过' : '生成失败') + '）')
            }
          }
        }
      } catch (e) { this.log.warn('[自唤醒] 出错：' + ((e && e.message) || e)) }
      // 【Breeze 每日额度】网页端每天送 100 字（Discord 会员更多），官方 API 不开放签到，
      // 只能用网页 cookie 打 /api/credits/daily-claim。每 10 分钟看一次，领过就静默。
      try {
        const lastBz = Number(this.state.lastBreezeClaimCheckAt || 0)
        if (now - lastBz > 10 * 60 * 1000) {
          this.state.lastBreezeClaimCheckAt = now
          try { this.save() } catch {}
          const bz = await ensureDailyClaim()
          if (bz && bz.claimed) this.log.info('[Breeze] 每日额度已领：+' + (bz.amount == null ? '?' : bz.amount) + '（余额 ' + (bz.balance == null ? '?' : bz.balance) + '）')
          else if (bz && bz.error) this.log.warn('[Breeze] 每日额度没领成：' + bz.error)
        }
      } catch (e) { this.log.warn('[Breeze] 领取检查出错：' + ((e && e.message) || e)) }
      // 【她的一天】到点就记一条"这会儿在干嘛"（纯状态推，零 token，不打扰任何人）
      try {
        const ds = daystreamTick(stateHome(), config, this.state || {})
        if (ds) this.log.info('[一天] ' + ds.label + '：' + ds.line)
      } catch (e) { this.log.warn('[一天] 出错：' + ((e && e.message) || e)) }
      // 【B站反馈】每 6 小时查一次：她发过的评论有没有人回（有就记住，这是"话被接住"）
      try {
        const lastFb = Number(this.state.lastFeedbackAt || 0)
        if (now - lastFb > 6 * 3600 * 1000) {
          this.state.lastFeedbackAt = now
          let items = []
          try { items = JSON.parse(fsRead(stateHome() + '/comment-log.json', 'utf8')).items || [] } catch {}
          const pending = items.filter((x) => x && !x.done && x.aid && x.rpid).slice(-3)
          if (pending.length) {
            let acc = null
            try { acc = loadAuth() } catch {}
            if (acc && acc.cookie) {
              for (const it of pending) {
                try {
                  const reps = await getCommentReplies(acc, it.aid, it.rpid, 3)
                  if (reps.length) {
                    const r0 = reps[0]
                    try { addMemory('有人在我 B 站评论下回我了：' + String(r0.user || '') + ' 说「' + String(r0.text || '').slice(0, 60) + '」', { importance: 62, config }) } catch {}
                    this.log.info('[反馈] 有人回我的评论了：' + String(r0.user || ''))
                    it.done = true
                  }
                } catch {}
              }
              try { fsWrite(stateHome() + '/comment-log.json', JSON.stringify({ items })) } catch {}
            }
          }
        }
      } catch (e) { this.log.warn('[反馈] 出错：' + ((e && e.message) || e)) }
      // 【评论区接话】有人（默认只认主人）回她的评论，她就接着回（楼中楼）
      try {
        if (config.biliCommentReplyEnabled !== false && biliAutoAllowed('reply', { now, config }).ok) {
          const gap = Math.max(1, Number(config.biliCommentReplyMinutes || 4)) * 60_000
          const lastRL = Number(this.state.lastBiliReplyLoopAt || 0)
          if (now - lastRL > gap) {
            this.state.lastBiliReplyLoopAt = now
            this.save()
            const r = await runReplyLoop(this.ctx, config, this.log, {})
            if (r && r.replied) this.log.info('[B站] 评论区接话 ' + r.count + ' 条：' + String(r.text || '').slice(0, 30))
            else if (r && r.ok === false) this.log.warn('[B站] 评论区接话失败：' + (r.error || ''))
          }
        }
      } catch (e) {
        this.log.warn('[B站] 评论区接话出错：' + ((e && e.message) || e))
      }
      // 【@ 我的】有人在别的评论区 @ 她（不挂在她评论下面），走 B 站消息中心的 @ 提醒接上
      try {
        if (config.biliAtReplyEnabled !== false && biliAutoAllowed('at', { now, config }).ok) {
          const gapAt = Math.max(1, Number(config.biliAtReplyMinutes || 5)) * 60_000
          const lastAt = Number(this.state.lastBiliAtLoopAt || 0)
          if (now - lastAt > gapAt) {
            this.state.lastBiliAtLoopAt = now
            this.save()
            const ra = await runAtLoop(this.ctx, config, this.log, {})
            if (ra && ra.replied) this.log.info('[B站] 回了 ' + ra.count + ' 个 @：' + String(ra.text || '').slice(0, 30))
            else if (ra && ra.ok === false) this.log.warn('[B站] 回 @ 失败：' + (ra.error || ''))
          }
        }
      } catch (e) {
        this.log.warn('[B站] 回 @ 出错：' + ((e && e.message) || e))
      }
      // 【自主浏览】每 12 小时一次机会：她挑个自己关心的话题去搜，结果存 browse-log（纯数据，不调模型）
      try {
        const lastB = Number(this.state.lastBrowseAt || 0)
        if (now - lastB > 12 * 3600 * 1000) {
          // 先记时间再搜：搜不到/超时也不重试。原先失败时不记时间，导致每 45 秒重试一次、一天几百次。
          this.state.lastBrowseAt = now
          this.save()
          if (Math.random() < 0.3) {
            let q = ''
            try {
              const wv = JSON.parse(fsRead(stateHome() + '/worldview.json', 'utf8'))
              const topics = (wv.items || []).map((x) => x.topic).filter(Boolean)
              if (topics.length) q = topics[Math.floor(Math.random() * topics.length)]
            } catch {}
            if (!q) q = '今天 新闻'
            // webSearch 返回 {ok, results, provider}，不是数组；原先 Array.isArray 恒 false → 从来没写进 browse-log。
            const sr = await webSearch(q, { limit: 3, timeoutMs: 12000 })
            const hits = (sr && Array.isArray(sr.results)) ? sr.results : []
            if (hits.length) {
              const bp = stateHome() + '/browse-log.json'
              let bl = []
              try { bl = JSON.parse(fsRead(bp, 'utf8')).items || [] } catch {}
              bl.push({ at: now, query: q, hits: hits.slice(0, 3).map((h) => ({ title: String(h.title || '').slice(0, 80), url: String(h.url || '') })) })
              fsWrite(bp, JSON.stringify({ items: bl.slice(-60) }))
              this.log.info('[浏览] 搜了「' + q + '」，' + hits.length + ' 条结果')
            } else {
              this.log.info('[浏览] 「' + q + '」没搜到（' + String((sr && sr.error) || '空') + '）')
            }
          }
        }
      } catch (e) { this.log.warn('[浏览] 出错：' + ((e && e.message) || e)) }
      // 【自我蒸馏】每天一次：从她自己的日志里提炼"我学到了什么"（零 token 规则版）
      try {
        const dr = selfDistill({ now, config })
        if (dr && dr.added) this.log.info('[蒸馏] 新增 ' + dr.added + ' 条，共 ' + dr.methods + ' 条经验')
      } catch (e) { this.log.warn('[蒸馏] 出错：' + ((e && e.message) || e)) }
      // 【日记】22~24 点，今天还没写就写一篇（L1 轻模型，短 prompt）
      try {
        const hh = new Date(now).getHours()
        if (hh >= 22 && hh < 24) {
          const dp = diaryPath(stateHome())
          const di = loadDiary(dp)
          if (needsDiary(di, now)) {
            const day0 = new Date(now).toDateString()
            const todayMsgs = recentMessages(300).filter((m) => new Date(Number(m.ts) || 0).toDateString() === day0)
            if (todayMsgs.length >= 3) {
              const r = await generateDiary(this.ctx, { stateHome: stateHome(), config, log: this.log, now, messages: todayMsgs })
              if (r && r.ok && r.text) {
                appendEntry(di, { text: r.text, source: 'auto', createdAt: now })
                saveDiary(dp, di)
                this.log.info('[日记] 写了一篇：' + String(r.text).slice(0, 30))
              }
            }
          }
        }
      } catch (e) { this.log.warn('[日记] 出错：' + ((e && e.message) || e)) }
      // 【生活循环】每 30 分钟推进一次"她在过日子"：纯规则，不调模型（省 token）
      try {
        const lastLife = Number(this.state.lastLifeTick || 0)
        if (now - lastLife >= 30 * 60 * 1000) {
          this.state.lastLifeTick = now
          this.save()
          await this.lifeTick(config, now)
        }
      } catch (e) { this.log.warn('生活循环出错：' + ((e && e.message) || e)) }
      // 【每日日程】每晚 22 点后生成明天的；今天没有也补一份
      try {
        const hour = new Date(now).getHours()
        const today = dateStr(new Date(now))
        let wx = ''
        try { const w = await currentWeather(undefined, config); wx = weatherPromptBlock(w) || '' } catch {}
        const t = new Date(now + 86400000)
        const tomorrow = dateStr(t)
        // 今天缺 → 补
        if (!loadDay(stateHome(), today)) {
          const r = await generateDay({ generateText, ctx: this.ctx, config, home: stateHome(), date: today, weather: wx })
          if (r.ok) this.log.info('[日程] 今天补上了（' + (r.template ? '模板' : '模型') + '，' + r.day.items.length + ' 段）')
        }
        // 22 点后 → 生成明天
        if (hour >= 22 && !loadDay(stateHome(), tomorrow)) {
          const r = await generateDay({ generateText, ctx: this.ctx, config, home: stateHome(), date: tomorrow, weather: wx })
          if (r.ok) this.log.info('[日程] 明天排好了（' + (r.template ? '模板' : '模型') + '，' + r.day.items.length + ' 段）')
        }
      } catch (e) { this.log.warn('日程生成失败：' + ((e && e.message) || e)) }

      // 【生理漂移】每 60 秒推进一次身体状态。没有心跳，她只在被说话时才活
      try {
        const m = readMood(stateHome())
        const age = now - Number(m.last_update || 0)
        // 注意：第一次 readMood 返回默认值时 last_update = now，age 恒为 0。
        // 所以不能只靠 age 判断，否则永远不落盘（实测 bug）。
        const next = driftMood(m, now)
        writeMood(stateHome(), next)
        if (age < 1000) this.log.info('[生理] 初始化 vitals.json')
      } catch (e) {
        this.log.warn('生理漂移失败：' + ((e && e.message) || e))
      }
      if (config.pushEnabled) {
        // 【神经-体液】张力是连续累积的，涨满了就开口——不靠定时器到点
        let sentByOrganic = false
        try {
          const org = tickOrganic({ config, now })
          if (org.fire) {
            const why = org.notes.length ? org.notes.join(' ') : '无额外调节'
            this.log.info(`[张力] 涨满了（${org.tension}/85，速率 ${org.rate}/分，${why}）→ 开口`)
            const r = await this.pushOnce(config, { manual: false })
            if (r && r.ok && !r.skipped) {
              recordDelivered(now)
              try { await recordProactive((r && r.text) || '') } catch {}
              sentByOrganic = true
              this.log.info('[张力] 已开口，张力回落到 ' + (org.tension - 70))
            } else if (r && r.ok && r.skipped) {
              this.log.info('[张力] 生成了但没发：' + (r.reason || ''))
            } else if (r && r.error) {
              this.log.info('[张力] 发送失败：' + r.error)
              // 没真发出去：把刚才扣掉的张力还回去，别让她白攒一场
              try { restoreTension() } catch {}
            }
          }
          if (org.tension >= 60) this.log.info('[张力] ' + org.tension + '/85（速率 ' + org.rate + '/分）')
        } catch (e) {
          this.log.warn('张力计算失败：' + ((e && e.message) || e))
        }
        // 【目的机制】不再用固定间隔，改由 SurfCore 的 purpose-engine 决策：
        // 安静时段 / 主人刚说过话 / 每日上限 / 随机间隔 150-300 分钟
        const gate = purposeGate({ now, config })
        if (!sentByOrganic && gate.run) {
          const r = await this.pushOnce(config, { manual: false })
          if (r && r.ok) { recordDelivered(now); try { await recordProactive((r && r.text) || '') } catch {} }
          else recordSkip((r && r.error) || 'failed', now)
        } else {
          // 【冲动破例】定时器还没到，但她有具体想做的事 / 想问的问题，而且精力心情都对得上
          // 这时候允许提前开口——「她想说」而不是「到点了」
          let broke = false
          try {
            const d = await computeDrive({ config, now })
            const can = this.canProactive(config, now)
            // 主人明确要「她想说就说」：这里不再用安静时段拦截。
            // 仍受最小间隔（pushMinIntervalMinutes）和每小时上限保护，不会刷屏。
            // 硬间隔：距上次开口不足 30 分钟，绝不破例（5 分钟连发两条追问就是这么来的）
            const lastPushGap = now - Number(this.state.lastPushAt || 0)
            if (d.breakIn && can.ok && lastPushGap >= 30 * 60 * 1000) {
              this.log.info(`[冲动] drive=${d.drive} 动机=${d.motive} · ${String(d.reason).slice(0, 30)} → 破例开口`)
              const r = await this.pushOnce(config, { manual: false, reason: d.reason })
              if (r && r.ok && !r.skipped) {
                recordDelivered(now)
                try { await recordProactive((r && r.text) || '') } catch {}
                // 用掉这个动机：同一件事不反复说第二次
                try {
                  if (d.motive === 'intent') {
                    const list = await activeIntents()
                    if (list[0]) await finishIntent(list[0].id)
                  }
                } catch {}
                broke = true
              } else if (r && r.ok && r.skipped) {
                this.log.info('[冲动] 生成了但没发：' + (r.reason || ''))
              } else {
                recordSkip((r && r.error) || 'failed', now)
              }
            }
          } catch (e) {
            this.log.warn('冲动计算失败：' + ((e && e.message) || e))
          }
          if (!broke && gate.reason !== 'waiting' && gate.reason !== 'owner-active') {
            // 降噪：同 reason + nextFireAt 10 分钟内只打一次（原先每 tick 都打，占日志四成）
            const gk = gate.reason + '|' + (gate.nextFireAt || 0)
            const now2 = Date.now()
            const lastG = this.state._lastGateLog
            if (!lastG || lastG.k !== gk || now2 - lastG.at > 600000) {
              this.state._lastGateLog = { k: gk, at: now2 }
              this.log.info('[目的] 暂不发送：' + gate.reason + (gate.nextFireAt ? '（下次 ' + new Date(gate.nextFireAt).toLocaleTimeString('zh-CN') + '）' : ''))
            }
          }
        }
      }
      // 【QQ 空间】她自己刷好友动态：真去看，感兴趣才点赞/评论（每 2 小时最多一轮）
      try {
        const sc = await tickQzoneScroll({ ctx: this.ctx, config, log: this.log, getBridge: () => this.getBridge() })
        if (sc && sc.counted) this.log.info('[空间] 自己刷：这次动了 ' + sc.counted + ' 下')
      } catch (e) {
        this.log.warn('[空间] 自己刷出错：' + ((e && e.message) || e))
      }
      // 【QQ 空间】按心情和今天发生的事，自己发一条说说（复刻 astrbot_plugin_qzone 的 AutoPublish）
      try {
        const qz = await tickQzoneAuto({ ctx: this.ctx, config, log: this.log, getBridge: () => this.getBridge() })
        if (qz && qz.sent) this.log.info('[空间] 自动说说已发出')
        else if (qz && qz.error) this.log.warn('[空间] 自动说说失败：' + qz.error)
      } catch (e) {
        this.log.warn('[空间] 自动说说出错：' + ((e && e.message) || e))
      }
      // 【B 站】她自己决定刷不刷
      // 【2026-11-12 · 第三版】主人在三句话里把这件事定下来了：
      //   ①「他睡觉了不要刷b站了」       ②「如果他晚上决定熬夜可以晚上刷」
      //   ③「就是让他根据自己来，给他权利让他决定自己要做什么」
      // 第③句是关键：所以**不再由钟点替她排班**。老版本的「每天 4 个固定时间点」是
      // AstrBot 那套定时任务的思路，主人明确不要。现在：
      //   · 硬约束只剩两条物理事实：她真的睡过去了（vitals.asleep）→ 跳过；
      //     会到他眼前的动作（分享/私信/@/评论接话/日报）→ 他睡了就不做。
      //   · 「自己逛」交给她本人决定：lib/bili/will.mjs 把此刻处境摆给她看
      //     （现在几点、身体困不困、主人醒着没、今天刷过几次、今天在干嘛），问她一句「想刷吗」。
      //     她说刷就刷——包括半夜；说不刷/睡了就不刷。
      //   · 冷却仍在（coolingGate，复用 purpose-engine），但它只是「别太频繁」，
      //     不是「几点必须刷」；而且只在**她决定要刷**之后才起作用。
      //   · 防「每晚固定刷」：夜里刷过的次数记在 will.json 的 nightWatches，连续几晚都在夜里刷时，
      //     问她的那句话里会摆出这个事实（她自己的习惯，让她自己看着办）。
      try {
        const g = biliAutoAllowed('watch', { now, config })
        // 她说「刷」之后才谈冷却：先问冷却能不能刷，能刷再问她想不想
        // 冷却参数走 B 站自己的键（biliWatchMinGapMinutes 等），缺省才用 purpose 的默认值
        const cw = coolingGate('bili-watch', { now, config, ...this.biliWatchCooling(config) })
        const askGapMs = Math.max(20, Number(config.biliWillAskMinutes || 90)) * 60_000
        if (!g.ok) {
          if (!this.state._lastBiliWatchGateLogAt || now - this.state._lastBiliWatchGateLogAt > 60 * 60 * 1000) {
            this.state._lastBiliWatchGateLogAt = now
            this.log.info('[B站·闸门] 自己逛跳过：' + g.reason)
          }
        } else if (!cw.run) {
          // 冷却里：不打扰她，也不问（省一次模型调用）
          if (!this.state._lastBiliWatchCoolLogAt || now - this.state._lastBiliWatchCoolLogAt > 60 * 60 * 1000) {
            this.state._lastBiliWatchCoolLogAt = now
            this.log.info('[B站·闸门] 自己逛冷却中：' + (cw.reason || 'cooldown'))
          }
        } else if (this.state.lastBiliWillAskAt && now - Number(this.state.lastBiliWillAskAt) < askGapMs) {
          // 刚问过她，别追问
        } else if (config.biliWatchSelfDirected === false) {
          // 关掉「她自己决定」= 退回定时表那套（保留开关，方便对照）
          const es = ensureBiliSchedule({ now, count: Number(config.biliWatchSlots || 4) })
          const schState = es && es.state ? es.state : null
          const due = schState ? dueSlot({ now, state: schState }) : null
          if (due && due.time) {
            markSlotTriggered({ now, time: due.time })
            const r = await watchOne({ ctx: this.ctx, config, log: this.log })
            if (r && r.ok) this.log.info('[B站] 按时间表刷完（' + due.time + '）：' + String(r.item && r.item.title || '').slice(0, 24))
          }
        } else {
          // 问她本人：想刷吗？
          this.state.lastBiliWillAskAt = now
          this.save()
          const will = await askHerWill(this.ctx, config, { now, home: stateHome(), log: (line) => this.log.warn(line) })
          if (!will.ok) {
            this.log.warn('[B站·她自己决定] 问她没问成：' + will.reason)
          } else if (will.choice === 'yes') {
            const sit = will.situation || {}
            this.log.info('[B站·她自己决定] 她说刷（' + (will.raw || '') + '；' + sit.clock + '，身体：' + (sit.body || '') + '）')
            const r = await watchOne({ ctx: this.ctx, config, log: this.log })
            if (r && r.ok) {
              recordCoolingSent('bili-watch', { now, config, ...this.biliWatchCooling(config) })
              recordHerWatch({ now, home: stateHome(), inSleepWindow: !!sit.inSleepWindow, config })
              this.state.lastBiliWatchAt = now
              this.save()
              this.log.info('[B站] 刷完：' + String(r.item && r.item.title || '').slice(0, 24))
            } else if (r && r.error) {
              recordCoolingSkip('bili-watch', { now, config, reason: String(r.error).slice(0, 40), ...this.biliWatchCooling(config) })
              this.log.info('[B站] 没看成：' + r.error)
            }
          } else {
            // 她说不刷 / 睡了：尊重她，这一轮就不刷，也不用记冷却
            this.log.info('[B站·她自己决定] 她这次不刷（' + (will.choice || 'unclear') + '：' + (will.reason || '') + '）')
          }
        }
      } catch (e) {
        this.log.warn('[B站] 看视频出错：' + ((e && e.message) || e))
      }
      // 【读书】她自己从书架挑一本中文公版书读一段，读完写一条看法（每 5 小时最多一次）
      try {
        const lastRead = Number(this.state.lastReadingAt || 0)
        const gapMs = 5 * 3600 * 1000
        let nightNow = false
        try { nightNow = inQuiet(now, config) } catch {}
        const chance = nightNow ? 0.10 : 0.30
        if (now - lastRead > gapMs && Math.random() < chance) {
          const r = await readOne({ ctx: this.ctx, config, log: this.log })
          if (r && r.ok) {
            this.state.lastReadingAt = now
            this.log.info('[读书] 读了《' + String(r.item && r.item.title || '').slice(0, 30) + '》，' + String((r.item && r.item.view) || '').slice(0, 50))
            this.save()
          } else if (r && r.error) {
            this.log.info('[读书] 没读成：' + r.error)
          }
        }
      } catch (e) {
        this.log.warn('[读书] 出错：' + ((e && e.message) || e))
      }
      // 【B 站分享】她自己逛到有意思的，发给你
      // 【2026-11-12】原来是「allow + !asleepNow + 随机概率」。主人要「和主动消息一样的冷却时间」，
      // 所以整个判定换成 biliAutoAllowed('share') 闸门 + coolingGate('bili-share')（复用 purpose-engine：
      // 最小/最大间隔 + 每日上限 + 主人刚说话不插话 + 冷却重试）。
      try {
        const g = biliAutoAllowed('share', { now, config })
        if (!g.ok) {
          if (!this.state._lastBiliShareGateLogAt || now - this.state._lastBiliShareGateLogAt > 60 * 60 * 1000) {
            this.state._lastBiliShareGateLogAt = now
            this.log.info('[B站·闸门] 分享跳过：' + g.reason)
          }
        } else {
          const shareOpts = {
            gapMinMs: Math.max(30, Number(config.biliShareMinGapMinutes || 120)) * 60_000,
            gapMaxMs: Math.max(30, Number(config.biliShareMaxGapMinutes || 240)) * 60_000,
            dailyMax: Math.max(0, Number(config.biliSharePerDay == null ? 2 : config.biliSharePerDay)),
            idleThresholdMs: 30 * 60_000,
          }
          // dailyMax=0 = 主人今天不想收分享：coolingGate 内部 dailyMax 最小 1，这里先挡一道
          const c = Number(shareOpts.dailyMax) <= 0
            ? { run: false, reason: 'dailyMax=0（今天不分享）' }
            : coolingGate('bili-share', { now, config, ...shareOpts })
          if (!c.run) {
            if (!this.state._lastBiliShareCoolLogAt || now - this.state._lastBiliShareCoolLogAt > 60 * 60 * 1000) {
              this.state._lastBiliShareCoolLogAt = now
              this.log.info('[B站·闸门] 分享冷却中：' + (c.reason || 'cooldown'))
            }
          } else {
            const pick = await pickShareCandidate()
            if (pick.ok) {
              const sent = await this.shareVideo(config, pick, now)
              if (sent) {
                markShared(pick.video.bvid, now)
                recordCoolingSent('bili-share', { now, config, ...shareOpts })
                try { await recordProactive(sent) } catch {}
                this.log.info(`[B站] 分享了一个视频：${String(pick.video.title).slice(0, 26)}`)
              }
            } else {
              recordCoolingSkip('bili-share', { now, config, reason: String(pick.error || '').slice(0, 40), ...shareOpts })
              this.log.info('[B站] 这次没分享：' + pick.error)
            }
          }
        }
      } catch (e) {
        this.log.warn('[B站] 分享失败：' + ((e && e.message) || e))
      }
      // 【B 站动态】她自己在自己号上发一条动态：每天最多 1 条、间隔 6 小时，深夜概率压低
      try {
        if (config.biliAutoDynamic !== false && biliAutoAllowed('dynamic', { now, config }).ok) {
          const allow = dynamicBudget()
          const night = inQuiet(now, config)
          const lastDyn = Number(this.state.lastBiliDynamicAt || 0)
          // 她自己做的事：只被「真的睡过去了」挡，不被作息窗口挡（主人要的是她自己决定）
          if (!sleepSt.moodAsleep && allow.remaining > 0 && now - lastDyn > 6 * HOUR && Math.random() < (night ? 0.05 : 0.12)) {
            const r = await this.postDynamicOnce(config, now)
            if (r && r.skipped) this.log.info('[B站] 这次没发动态：她觉得没什么好说的')
          }
        }
      } catch (e) {
        this.log.warn('[B站] 动态出错：' + ((e && e.message) || e))
      }
      // 【B 站评论】只在他自己的视频下留一条：每天最多 1 条、间隔 12 小时、同一个视频只评一次
      try {
        if (config.biliAutoComment !== false && biliAutoAllowed('comment', { now, config }).ok) {
          const allow = commentBudget()
          const lastCmt = Number(this.state.lastBiliCommentAt || 0)
          const night = inQuiet(now, config)
          const gapMs = Math.max(1, Number(config.commentMinGapMinutes || 8)) * 60_000
          const chance = Number.isFinite(Number(config.commentChance)) ? Number(config.commentChance) : 0.5
          // 同上：她醒着就有权决定要不要评论，不按钟点禁
          if (!sleepSt.moodAsleep && allow.remaining > 0 && now - lastCmt > gapMs && Math.random() < (night ? chance * 0.5 : chance)) {
            const r = await this.postCommentOnce(config, now)
            if (r && r.skipped && r.reason) this.log.info('[B站] 这次不评论：' + r.reason)
          }
        }
      } catch (e) {
        this.log.warn('[B站] 评论出错：' + ((e && e.message) || e))
      }
      // 【B 站私信】收主人的私信并回一条（对齐 AstrBot 的 PRIVATE_MESSAGE_*）
      try {
        if (config.biliDmReply !== false && biliAutoAllowed('dm', { now, config }).ok) {
          const gap = Math.max(3, Number(config.biliDmPollMinutes || 10)) * 60_000
          const lastDm = Number(this.state.lastBiliDmAt || 0)
          if (now - lastDm > gap) {
            this.state.lastBiliDmAt = now
            this.save()
            const r = await runDmReply(this.ctx, config, this.log, {})
            if (r && r.replied) this.log.info('[B站] 私信回了主人：' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 30))
            else if (r && r.ok === false) this.log.warn('[B站] 私信回复失败：' + (r.error || ''))
          }
        }
      } catch (e) {
        this.log.warn('[B站] 私信出错：' + ((e && e.message) || e))
      }
      // 【B 站日报/周报】每天 config.biliSummaryHour 点、每周 config.biliSummaryWeekday 复盘一次
      try {
        if (config.biliSummaryEnabled !== false && biliAutoAllowed('summary', { now, config }).ok) {
          // 睡眠闸门：biliSummaryHour 默认 23 点，但主人可能把它调到凌晨——
          // 那样日报会在她睡着时发出去。上面 biliAutoAllowed('summary') 已经拦住了。
          const st = loadSummaryState()
          const day = dayKey(now)
          const hourNow = new Date(now).getHours()
          const weekdayNow = new Date(now).getDay()
          const wantDaily = hourNow === Number(config.biliSummaryHour ?? 23) && st.lastDaily !== day
          const wantWeekly = weekdayNow === Number(config.biliSummaryWeekday ?? 6) && hourNow === Number(config.biliSummaryHour ?? 23) && st.lastWeekly !== weekKey(now)
          if (wantDaily || wantWeekly) {
            const kind = wantWeekly ? 'weekly' : 'daily'
            const r = await runSummary(this.ctx, config, this.log, { kind })
            if (r && r.text) {
              const tgt = this.resolveTarget(config)
              const br = this.getBridge()
              if (tgt && br && br.state === 'online') await sendBubbles(br, toOneBotTarget(tgt), r.text, config, this.log)
              this.log.info('[B站] ' + (kind === 'weekly' ? '周报' : '日报') + '：' + String(r.text).slice(0, 30))
            } else if (r && r.ok === false) {
              this.log.warn('[B站] 总结生成失败：' + (r.error || ''))
            }
            if (!wantWeekly) { st.lastDaily = day; saveSummaryState(undefined, st) }
            else { st.lastDaily = day; st.lastWeekly = weekKey(now); saveSummaryState(undefined, st) }
          }
        }
      } catch (e) {
        this.log.warn('[B站] 日报出错：' + ((e && e.message) || e))
      }
      if (config.whisperEnabled) {
        const last = Number(this.state.lastWhisperAt || 0)
        if (now - last >= Math.max(15, Number(config.whisperMinIntervalMinutes || 45)) * 60_000) {
          await this.whisperOnce(config, { manual: false })
        }
      }
    } catch (e) {
      this.log.error('定时任务出错：' + String((e && e.message) || e))
    } finally {
      this.running = false
    }
  }

  /** 把「逗号/换行分隔的 ID 串」拆成数组 */
  idListOf(text) {
    return String(text || '')
      .split(/[,，;；\s\n\r]+/)
      .map((x) => String(x).replace(/\D/g, ''))
      .filter((x) => x.length >= 5 && x.length <= 12)
  }

  /**
   * 她能主动去找的人/群：最近聊过的私聊 + 群（白名单开着时只留名单内的）。
   * 顺序：面板里显式指定的目标优先，其余按最近聊天时间。
   */
  candidateTargets(config) {
    let rows = []
    try { rows = recentMessages(600) } catch { rows = [] }
    const map = new Map()
    for (const r of rows) {
      if (!r || !r.uin || !r.conversation) continue
      const kind = r.channel === 'group' ? 'group' : 'private'
      const key = kind + ':' + String(r.uin)
      const prev = map.get(key)
      const text = String(r.text || '').replace(/\s+/g, ' ').slice(0, 50)
      if (!prev) {
        map.set(key, {
          kind,
          id: String(r.uin),
          name: kind === 'group' ? '群 ' + maskUin(r.uin) : String(r.who || maskUin(r.uin)),
          lastAt: Number(r.ts) || 0,
          lastText: text,
          lastFromMe: r.direction === 'out',
          members: [],
        })
      } else if ((Number(r.ts) || 0) >= prev.lastAt) {
        prev.lastAt = Number(r.ts) || 0
        prev.lastText = text
        prev.lastFromMe = r.direction === 'out'
      }
      // 群友名单（最近说过话的人），让她能 @ 具体的人
      const cur = map.get(key)
      if (kind === 'group' && r.direction === 'in' && r.senderId) {
        const qq = String(r.senderId).replace(/\D/g, '')
        if (qq && qq !== String(config && config.accessAdminId || '') || qq) {
          if (qq && !cur.members.some((m) => m.qq === qq)) {
            cur.members.push({ qq, name: String(r.who || '').slice(0, 16) || qq })
            if (cur.members.length > 6) cur.members.shift()
          }
        }
      }
    }
    let list = [...map.values()].sort((x, y) => y.lastAt - x.lastAt)
    if (config && config.accessWhitelistEnabled === true) {
      const wl = this.idListOf(config.accessWhitelist)
      list = list.filter((c) => wl.includes(String(c.id)))
    }
    const explicit = config && config.pushTarget
    if (explicit) {
      list = [Object.assign({}, explicit, { lastAt: Date.now(), lastText: '', lastFromMe: false }), ...list.filter((c) => !sameTarget(c, explicit))]
    }
    return list.slice(0, 6)
  }

  /**
   * 让她自己决定：现在主动找谁说话、要不要说。
   * 一次调用同时完成「选谁」和「要不要发」，不写消息内容。
   */
  async pickProactiveTarget(config, now) {
    const cands = this.candidateTargets(config)
    if (!cands.length) return { ok: false, reason: '还没有可以主动找的人' }
    let rows = []
    try { rows = recentMessages(400) } catch { rows = [] }
    const lines = cands.map((c, i) => {
      const convKey = (c.kind === 'group' ? 'group:' : 'private:') + c.id
      const recent = rows
        .filter((r) => r && r.conversation === convKey)
        .slice(-3)
        .map((r) => (r.direction === 'out' ? '你' : String(r.who || '对方').slice(0, 10)) + '：' + String(r.text || '').slice(0, 36))
        .join(' / ')
      const who = c.kind === 'group' && c.members && c.members.length
        ? '；群里最近说话的人：' + c.members.slice(-4).map((m) => m.name + '(' + m.qq + ')').join('、')
        : ''
      return `${i + 1}) ${c.kind === 'group' ? '群' : '私聊'} ${c.name}${c.lastFromMe ? '（最后一句是你说，他还没回）' : ''} 最近：${recent || '没聊过'}${who}`
    })
    const lastAt = Number(this.state.lastPushAt || 0)
    const gap = lastAt ? `距你上次主动 ${Math.max(0, Math.round((now - lastAt) / 60000))} 分钟` : '你还没主动找过谁'
    const system = [
      `你是「${String((config && config.personaName) || '小肥鱼')}」。`,
      String((config && config.persona) || '').slice(0, 900),
      '你要决定：现在主动找谁说话、要不要说。不要写消息内容。',
    ].join('\n')
    const prompt = [
      `现在是 ${new Date(now).toLocaleString('zh-CN')}。`,
      '你可以找的人 / 群：',
      ...lines,
      gap,
      '怎么判断：',
      '- 想主人了就选私聊。群**只在有人明确提到你、或在聊你正在说的那件事**时才选；他们自己之间的闲聊，再热闹也别插嘴——没人叫你就别自己冒出来。',
      '- 那个人最后一句是你说的、他还没回 → 不发，别追。',
      '- 这个点他可能在睡/在忙 → 不发。',
      '- 没什么想说的 → 不发。',
      '- 选群时，如果你想专门跟某个人说话，可以 @ 他（用括号里的 QQ 号）；不 @ 就是随口在群里说一句。',
      '只输出一行，三种格式任选：',
      '  编号|发|理由',
      '  编号|发|@QQ号|理由',
      '  编号|不发|理由',
    ].join('\n')
    let result
    try {
      result = await generateText(this.ctx, {
        system,
        messages: [{ role: 'user', text: prompt }],
        config,
        temperature: 0.4,
        maxTokens: 60,
        timeoutMs: 25_000,
        log: (line) => this.log.warn(line),
      })
    } catch (e) {
      return { ok: true, target: cands[0], reason: '判断出错，按最近会话发' }
    }
    if (!result || !result.ok) return { ok: true, target: cands[0], reason: '判断失败，按最近会话发' }
    const v = String(result.text || '').trim()
    if (this.log && v) this.log.info('[主动] 她选：' + v.slice(0, 50))
    const m = v.match(/(\d+)\s*[|｜]\s*(不发|发)\s*(?:[|｜]\s*@?\s*(\d{5,12})\s*)?[|｜]?\s*(.*)/)
    if (!m) return { ok: true, target: cands[0], reason: '没看懂她选的，按最近会话发' }
    const idx = Math.max(1, Math.min(cands.length, Number(m[1]))) - 1
    if (m[2] === '不发') return { ok: false, reason: (m[4] || '她不想发').slice(0, 40) }
    const candidate = cands[idx]
    let atQq = ''
    if (m[3] && candidate.kind === 'group') {
      // 只能 @ 这个群里的人
      const ok = (candidate.members || []).some((x) => x.qq === String(m[3]))
      if (ok) atQq = String(m[3])
    }
    return { ok: true, target: candidate, atQq, reason: (m[4] || '').slice(0, 40) }
  }

  /** 生成并发送一条主动消息；manual=true 时忽略时段/间隔限制（但仍记速率） */
  async pushOnce(config, options = {}) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return { ok: false, error: 'QQ 桥不在线' }
    let target = options.target || this.resolveTarget(config)
    const now = Date.now()
    const gate = this.canProactive(config, now)
    if (!gate.ok && !options.manual) return { ok: false, error: gate.reason }

    // 【自己判断】先决定找谁、要不要发，再决定写什么
    let pick = { ok: true, target, reason: '' }
    if (!options.manual && config.pushSelfCheck !== false) {
      pick = await this.pickProactiveTarget(config, now)
      if (!pick.ok) {
        this.state.lastPushAt = now
        this.save()
        return { ok: true, skipped: true, reason: '她想了想，这次不主动：' + (pick.reason || '') }
      }
      if (pick.target) target = pick.target
    }
    if (!target) return { ok: false, error: '还没有可以主动发消息的对象（先和人聊一句，或在面板里选一个）' }
    const pickAtQq = String(pick.atQq || '')
    const history = this.historyForTarget(target)
    // 主动找的是主人 → 用恋人版人设
    const system = systemPrompt(config, { channel: 'push', ownerMode: true, personaOverride: String(config.personaOwner || '').trim() })
    let system2 = system
    try { const dp = dayplanInjection(stateHome(), config); if (dp) system2 = system + '\n\n' + dp } catch {}
    // 【连续性·事实】把最近几条自己说过的话摆出来：主动推送也要接得上，不能上一句吃完、下一句还在吃
    try {
      const rows = recentMessages(200).filter((m) => m && m.direction === 'out')
      const mine = rows.slice(-4).map((m) => '· ' + String(m.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter((x) => x.length > 3)
      if (mine.length) system2 += '\n\n【连续性·事实】\n你最近说过的：\n' + mine.join('\n') + '\n\n上面这些是你自己的话，就是事实：吃了什么、在哪、在干嘛都要接得上，不能下一秒变成没做过；时间过了多久，动作就要相应推进（该吃完就吃完、该洗碗就洗碗）。拿不准就模糊带过，别新编细节。'
    } catch {}
    // 主动开话题：带上记忆、几天前摘要、相关旧对话
    let memBlock = ''
    let notesBlock = ''
    let relatedBlock = ''
    try {
      const mems = Array.isArray(config && config.memories) ? config.memories.filter((m) => m && m.text) : []
      if (mems.length) memBlock = mems.map((m) => '- ' + String(m.text).slice(0, 120)).join('\n')
      const conv = String((history.length && history[history.length - 1] && history[history.length - 1].conversation) || '')
      if (conv) {
        const notes = recentNotes(conv, 3)
        if (notes.length) notesBlock = renderNotes(notes)
        const recentTexts = history.slice(-6).map((h) => String(h.text || '')).join(' ')
        const kws = extractKeywords(recentTexts)
        if (kws.length) {
          const allRows = recentMessages(1500)
          const rel = searchRelated(allRows, conv, kws, { limit: 4 })
          if (rel.length) relatedBlock = renderRelated(rel)
        }
      }
    } catch (err) {
      this.log.warn('推送记忆组装失败：' + ((err && err.message) || err))
    }
    const prompt = pushPrompt({
      who: targetLabel(target),
      timeText: timeText(),
      lastMessage: history.length ? history[history.length - 1].text : '',
      // 只给对方说过的话：把她自己的话也喂进去，她会模仿自己上一句的句式，
      // 于是「喂，杂鱼……我碗都端稳了」能连着说八遍。她要接的是对方，不是自己。
      recent: history.filter((h) => h.role !== 'assistant').slice(-6).map((h) => (h.who ? h.who + '：' : '') + String(h.text || '')).join(' / '),
      memories: memBlock,
      notes: notesBlock,
      related: relatedBlock,
    })
    const NO_HALLUCINATION = '\n\n（**不许编造他说过的话**。你要引用他的话，只能用最近聊天里真实出现的原话；记不清、或者根本没这回事，就直接问「你是不是说过…」，别张口就说「你上回说过」。编出来的“你说过”会让他一头雾水。）'
    const NO_REPORT = '\n\n（别汇报行程。你此刻在干嘛不用一条条报给他听——那是日程表不是说话。说你心里冒出来的念头、刚看到的东西、或者问他一句在干嘛都行。）'
    const finalPrompt = target.kind === 'group'
      ? prompt + '\n\n（你现在是在一个群里说话，不用特意 @ 谁，就像随口插一句。）' + NO_REPORT + NO_HALLUCINATION
      : prompt + NO_REPORT + NO_HALLUCINATION
    const result = await generateText(this.ctx, {
      system: system2,
      messages: [{ role: 'user', text: finalPrompt }],
      config,
      timeoutMs: 60_000,
      log: (line) => this.log.warn(line),
    })
    if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
    let text = parseSkip(result.text)
    if (!text) {
      this.state.lastPushAt = now
      this.save()
      return { ok: true, skipped: true }
    }
    // 清掉表情占位符；清完为空就当跳过
    text = stripStickerMarkers(text)
    if (!text) {
      this.state.lastPushAt = now
      this.save()
      return { ok: true, skipped: true, note: '只有表情占位符，已跳过' }
    }
    let body = cleanReply(text, config.maxReplyChars)
    // 【现场】主动消息也可能带 [state:...]：engine 那条路径管不到这里，不剥就会泄漏到正文
    try {
      const st = extractStateMarker(body)
      if (st.state) {
        setState(stateHome(), st.state)
        this.log.info('[现场] ' + String(st.state).slice(0, 40))
        body = st.text
      }
    } catch (err) { this.log.warn('[现场] 解析失败：' + ((err && err.message) || err)) }
    // 【自唤醒标记】push 主动消息里如果带 [wake:HH:MM:理由]，登记并剥离，别让主人看到
    try {
      const wv = addWakes(stateHome(), body)
      if (wv.length) body = body.replace(/\[wake:\d{1,2}:\d{2}:[^\]]{1,200}\]/g, '').trim()
    } catch (e) { this.log.warn('[自唤醒] 登记失败：' + ((e && e.message) || e)) }
    // 【别复读】和最近她自己说过的话太像 → 这次不开口。
    // 不是外部拦着，是她自己也觉得「这话我说过了」，没意思就不说。
    // （之前 33 分钟发了 8 条「喂，杂鱼……我碗都端稳了」就是缺这道闸）
    try {
      const recentOwn = recentMessages(300)
        .filter((m) => m && m.direction === 'out')
        .slice(-10)
        .map((m) => ({ text: String(m.text || '') }))
      const dup = findRepeat(body, recentOwn)
      if (dup) {
        this.log.info(`[主动] 太像说过的话（${Number(dup.score).toFixed(2)}），这次不开口`)
        this.state.lastPushAt = now
        this.save()
        return { ok: true, skipped: true, reason: '内容和最近说过的太像' }
      }
    } catch {}
    if (!body || !String(body).trim()) {
      this.log.info('[主动] 清洗后为空，这次不开口')
      return { ok: true, skipped: true, reason: '清洗后为空' }
    }
    if (pickAtQq && target.kind === 'group') body = '[at:' + pickAtQq + '] ' + body
    // 【别插嘴】上面检查完到真正发出去中间要生成十几秒——这中间他要说话了，这条就撤
    try {
      const rows = recentMessages(4)
      const lastIn = [...rows].reverse().find((m) => m && m.direction === 'in')
      const lastOut = [...rows].reverse().find((m) => m && m.direction === 'out')
      if (lastIn && (!lastOut || Number(lastIn.ts) > Number(lastOut.ts)) && Date.now() - Number(lastIn.ts) < 3 * 60 * 1000) {
        this.log.info('[主动] 刚要发他就说话了，这条撤了')
        return { ok: true, skipped: true, reason: '他刚说话' }
      }
    } catch {}
    try {
      await sendBubbles(bridge, toOneBotTarget(target), body, config, this.log)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    this.state.lastPushAt = now
    this.state.proactiveTimes = [...(this.state.proactiveTimes || []), now]
    this.save()
    this.afterSend(config, target, body, 'push', result)
    return { ok: true, text: body }
  }

  /** 在他最新（且没评过）的视频下留一条评论（生成与发布都在 lib/bili/auto.mjs） */
  async postCommentOnce(config, now) {
    const r = await runComment(this.ctx, config, (line) => this.log.warn(line))
    if (!r.ok) {
      if (r.error) this.log.warn('[B站] 评论没发出去：' + r.error)
      return null
    }
    if (r.skipped) return { ok: true, skipped: true, reason: r.error || '' }
    this.state.lastBiliCommentAt = now
    this.save()
    const where = "在他的《" + String((r.video && r.video.title) || '').slice(0, 20) + '》下'
    const what = String(r.text).replace(/\s+/g, ' ').slice(0, 30)
    if (r.visible === true) this.log.info('[B站] ' + where + '评论已展示：' + what)
    else if (r.visible === false) this.log.info('[B站] ' + where + '评论已提交（审核中/暂不展示，state=' + r.state + '）：' + what)
    else this.log.info('[B站] ' + where + '评论已提交（未能确认是否展示）：' + what)
    return { ok: true, text: r.text, video: r.video }
  }

  /** 在她自己的 B 站账号上发一条文字动态（生成与发布都在 lib/bili/auto.mjs） */
  async postDynamicOnce(config, now) {
    const r = await runDynamic(this.ctx, config, (line) => this.log.warn(line))
    if (!r.ok) {
      if (r.error) this.log.warn('[B站] 动态没发出去：' + r.error)
      return null
    }
    if (r.skipped) return { ok: true, skipped: true }
    this.state.lastBiliDynamicAt = now
    this.save()
    this.log.info('[B站] 她发了一条动态：' + String(r.text).replace(/\s+/g, ' ').slice(0, 34))
    return { ok: true, text: r.text }
  }

  /** 把一个 B 站视频发给他（她自己的话 + 链接） */
  async shareVideo(config, pick, now) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return null
    const target = this.resolveTarget(config)
    if (!target) return null
    const system = systemPrompt(config, { channel: 'push', ownerMode: true, personaOverride: String(config.personaOwner || '').trim() })
    let system2 = system
    try { const dp = dayplanInjection(stateHome(), config); if (dp) system2 = system + '\n\n' + dp } catch {}
    // 【连续性·事实】把最近几条自己说过的话摆出来：主动推送也要接得上，不能上一句吃完、下一句还在吃
    try {
      const rows = recentMessages(200).filter((m) => m && m.direction === 'out')
      const mine = rows.slice(-4).map((m) => '· ' + String(m.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter((x) => x.length > 3)
      if (mine.length) system2 += '\n\n【连续性·事实】\n你最近说过的：\n' + mine.join('\n') + '\n\n上面这些是你自己的话，就是事实：吃了什么、在哪、在干嘛都要接得上，不能下一秒变成没做过；时间过了多久，动作就要相应推进（该吃完就吃完、该洗碗就洗碗）。拿不准就模糊带过，别新编细节。'
    } catch {}
    const result = await generateText(this.ctx, {
      system: system2,
      messages: [{ role: 'user', text: sharePromptBlock(pick.video, pick.url) + '\n\n' + shareChannelHint() }],
      config,
      timeoutMs: 45_000,
      log: (line) => this.log.warn(line),
    })
    if (!result.ok) return null
    let text = parseSkip(result.text)
    if (!text) return null
    text = stripStickerMarkers(text)
    if (!text) return null
    let body = cleanReply(text, config.maxReplyChars)
    // 【现场】同 pushOnce：主动消息也可能带 [state:...]，不剥会泄漏
    try {
      const st2 = extractStateMarker(body)
      if (st2.state) { setState(stateHome(), st2.state); this.log.info('[现场] ' + String(st2.state).slice(0, 40)); body = st2.text }
    } catch (err) { this.log.warn('[现场] 解析失败：' + ((err && err.message) || err)) }
    // 【自唤醒标记】push 主动消息里如果带 [wake:HH:MM:理由]，登记并剥离，别让主人看到
    try {
      const wv = addWakes(stateHome(), body)
      if (wv.length) body = body.replace(/\[wake:\d{1,2}:\d{2}:[^\]]{1,200}\]/g, '').trim()
    } catch (e) { this.log.warn('[自唤醒] 登记失败：' + ((e && e.message) || e)) }
    // 统一成「话在前、链接在后」。模型经常把链接写在开头，看着像转发机器人。
    // 如果去掉链接后一个字都不剩（她只甩了个 URL），这条就不发——纯链接太难看。
    // 去掉链接 + 零宽/全角空白后如果没剩下字，就是「只甩了个链接」——这条不发
    const words = String(body)
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\u200b-\u200f\ufeff\u3000]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!words || words.replace(/[\s\u3000]/g, '').length < 2) {
      this.log.info('[B站] 只生成了链接没说话，这条不发')
      return null
    }
    // 渠道：默认走 B 站私信（在他眼皮底下 @ 他），只有私信不通、或她明写 [qq] 才发 QQ
    const wantQq = /\[qq\]/i.test(String(text))
    body = words.replace(/\[(dm|qq)\]/gi, '').trim() + '\n' + pick.url
    const ownerMid = String(config.ownerBiliMid || '').trim()
    if (!wantQq && ownerMid) {
      const r = await biliSendDm(undefined, ownerMid, String(pick.video.title || '') + '\n' + pick.url)
      if (r.ok) {
        this.log.info('[B站] 私信分享了一个视频：' + String(pick.video.title || '').slice(0, 26))
        this.state.lastPushAt = now
        this.save()
        try { this.afterSend(config, target, '[B站私信] ' + String(pick.video.title || ''), 'bili', result) } catch {}
        return body
      }
      this.log.warn('[B站] 私信发送失败：' + r.error + '，退回 QQ')
    }
    // 【别插嘴】上面检查完到真正发出去中间要生成十几秒——这中间他要说话了，这条就撤
    try {
      const rows = recentMessages(4)
      const lastIn = [...rows].reverse().find((m) => m && m.direction === 'in')
      const lastOut = [...rows].reverse().find((m) => m && m.direction === 'out')
      if (lastIn && (!lastOut || Number(lastIn.ts) > Number(lastOut.ts)) && Date.now() - Number(lastIn.ts) < 3 * 60 * 1000) {
        this.log.info('[主动] 刚要发他就说话了，这条撤了')
        return null
      }
    } catch {}
    try {
      await sendBubbles(bridge, toOneBotTarget(target), body, config, this.log)
    } catch (e) {
      this.log.warn('[B站] 发送失败：' + ((e && e.message) || e))
      return null
    }
    this.state.lastPushAt = now
    this.state.proactiveTimes = [...(this.state.proactiveTimes || []), now]
    this.save()
    // 【必须记进对话】不然她自己的上下文里没有这条，被问「你发的视频」时只能瞎猜
    try { this.afterSend(config, target, body, 'bili', result) } catch {}
    return body
  }

  async whisperOnce(config, options = {}) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return { ok: false, error: 'QQ 桥不在线' }
    const target = options.target || this.resolveWhisperTarget(config)
    if (!target) return { ok: false, error: '还没有碎碎念的发送对象' }
    const now = Date.now()
    const gate = this.canProactive(config, now)
    if (!gate.ok && !options.manual) return { ok: false, error: gate.reason }
    // 碎碎念也遵守安静时段（和目的机制共用一套，避免半夜发）
    if (!options.manual && inQuiet(now, config)) return { ok: false, error: '安静时段' }
    const last = this.lastWhisperText()
    const system = systemPrompt(config, { channel: 'whisper', ownerMode: true, personaOverride: String(config.personaOwner || '').trim() })
    let system2 = system
    try { const dp = dayplanInjection(stateHome(), config); if (dp) system2 = system + '\n\n' + dp } catch {}
    // 【连续性·事实】把最近几条自己说过的话摆出来：主动推送也要接得上，不能上一句吃完、下一句还在吃
    try {
      const rows = recentMessages(200).filter((m) => m && m.direction === 'out')
      const mine = rows.slice(-4).map((m) => '· ' + String(m.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter((x) => x.length > 3)
      if (mine.length) system2 += '\n\n【连续性·事实】\n你最近说过的：\n' + mine.join('\n') + '\n\n上面这些是你自己的话，就是事实：吃了什么、在哪、在干嘛都要接得上，不能下一秒变成没做过；时间过了多久，动作就要相应推进（该吃完就吃完、该洗碗就洗碗）。拿不准就模糊带过，别新编细节。'
    } catch {}
    const prompt = whisperPrompt({ timeText: timeText(), lastWhisper: last })
    const result = await generateText(this.ctx, {
      system: system2,
      messages: [{ role: 'user', text: prompt }],
      config,
      timeoutMs: 60_000,
      log: (line) => this.log.warn(line),
    })
    if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
    let text = parseSkip(result.text)
    if (!text) {
      this.state.lastWhisperAt = now
      this.save()
      return { ok: true, skipped: true }
    }
    text = stripStickerMarkers(text)
    if (!text) return { ok: true, skipped: true, note: '只有表情占位符，已跳过' }
    let body = cleanReply(text, Math.min(200, config.maxReplyChars || 200))
    try {
      const st3 = extractStateMarker(body)
      if (st3.state) { setState(stateHome(), st3.state); this.log.info('[现场] ' + String(st3.state).slice(0, 40)); body = st3.text }
    } catch (err) { this.log.warn('[现场] 解析失败：' + ((err && err.message) || err)) }
    // 【自唤醒标记】push 主动消息里如果带 [wake:HH:MM:理由]，登记并剥离，别让主人看到
    try {
      const wv = addWakes(stateHome(), body)
      if (wv.length) body = body.replace(/\[wake:\d{1,2}:\d{2}:[^\]]{1,200}\]/g, '').trim()
    } catch (e) { this.log.warn('[自唤醒] 登记失败：' + ((e && e.message) || e)) }
    // 【别插嘴】上面检查完到真正发出去中间要生成十几秒——这中间他要说话了，这条就撤
    try {
      const rows = recentMessages(4)
      const lastIn = [...rows].reverse().find((m) => m && m.direction === 'in')
      const lastOut = [...rows].reverse().find((m) => m && m.direction === 'out')
      if (lastIn && (!lastOut || Number(lastIn.ts) > Number(lastOut.ts)) && Date.now() - Number(lastIn.ts) < 3 * 60 * 1000) {
        this.log.info('[主动] 刚要发他就说话了，这条撤了')
        return { ok: true, skipped: true, note: '他刚说话' }
      }
    } catch {}
    try {
      await sendBubbles(bridge, toOneBotTarget(target), body, config, this.log)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    this.state.lastWhisperAt = now
    this.state.proactiveTimes = [...(this.state.proactiveTimes || []), now]
    this.save()
    this.afterSend(config, target, body, 'whisper', result)
    return { ok: true, text: body }
  }

  historyForTarget(target) {
    const conversation = `${target.kind}:${target.id}`
    const rows = recentMessages(300).filter((m) => m && m.conversation === conversation)
    return rows.slice(-6)
  }

  lastWhisperText() {
    const rows = recentMessages(100).filter((m) => m && m.generatedBy === 'whisper')
    return rows.length ? rows[rows.length - 1].text : ''
  }

  afterSend(config, target, text, kind, result) {
    const usage = normalizeUsage(result.usage)
    recordUsage(usage, { kind, provider: result.model && result.model.provider, model: result.model && result.model.model })
    appendMessage({
      ts: Date.now(),
      direction: 'out',
      channel: target.kind === 'group' ? 'group' : 'private',
      conversation: `${target.kind}:${target.id}`,
      uin: target.id,
      who: config.personaName || '小肥鱼',
      text,
      generatedBy: kind,
      model: result.model,
      usage: usage || undefined,
    })
    bumpStats('sent')
  }
}
