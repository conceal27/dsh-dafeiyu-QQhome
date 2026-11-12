/**
 * lib/qzone-auto.mjs — 「按心情和事件发说说」
 * ============================================================================
 * 复刻 AstrBot astrbot_plugin_qzone 的 AutoPublish，但从「固定 cron 抽聊天记录」
 * 改成「心情有波动 / 今天真发生了事」才发，并保留原插件的随机偏移、每日限额、
 * 发给主人通知这几个行为。
 *
 * 触发条件（全部满足才发）：
 *   1. qzoneAutoPost 打开；
 *   2. 在 qzoneAutoStart–qzoneAutoEnd 时间窗内；
 *   3. 今天还没发够 qzoneAutoPostPerDay 条；
 *   4. 距上一条超过 qzoneAutoPostMinGapHours 小时；
 *   5. 到了当天的「随机时刻」（每天开局随机排一次，模仿 cron ±offset），
 *      或者刚刚有强情绪 / 新鲜事件（burst 立即发）。
 *
 * 素材：当前心情（vitals）、今天做过的事（daystream）、今天/昨天的日记（diary）。
 * 全部读不到 → 不发（没料就别硬编）。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from './llm.mjs'
import { systemPrompt, cleanReply, parseSkip } from './persona.mjs'
import { stateHome } from './store.mjs'
import { readMood } from './vitals.mjs'
import { renderMoodPrompt } from './sc/mood.mjs'
import { recentActivity } from './daystream.mjs'
import { loadDiary, diaryPath, recentEntries } from './sc/diary.mjs'
import { postQzone, pickQzoneImages, lastQzoneImageFiles, refreshFeedCache } from './qzone.mjs'
import { qzoneImagesFor } from './imagegen.mjs'
import { dayStateBlock } from './selfstate.mjs'
import { scrubPublic } from './privacy.mjs'

const STATE_VERSION = 1
const DAY = 24 * 3600 * 1000

function stateDir(home) {
  return join(home, 'qzone')
}
function statePath(home) {
  return join(stateDir(home), 'auto.json')
}

export function loadAutoState(home) {
  try {
    const j = JSON.parse(readFileSync(statePath(home), 'utf8'))
    return {
      version: STATE_VERSION,
      items: Array.isArray(j.items) ? j.items : [],
      plan: j.plan && typeof j.plan === 'object' ? j.plan : null,
      lastAt: Number(j.lastAt) || 0,
      lastSkipAt: Number(j.lastSkipAt) || 0,
    }
  } catch {
    return { version: STATE_VERSION, items: [], plan: null, lastAt: 0, lastSkipAt: 0 }
  }
}

function saveAutoState(home, st) {
  try {
    mkdirSync(stateDir(home), { recursive: true })
    st.items = st.items.slice(-200)
    writeFileSync(statePath(home), JSON.stringify(st, null, 2), 'utf8')
  } catch {}
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stamp(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 当天随机时刻：在时间窗里挑一个点，但偏向傍晚（人更爱在晚上发空间） */
function planForDay(day, startH, endH, now) {
  const base = new Date(now)
  base.setHours(startH, 0, 0, 0)
  const spanMs = Math.max(1, (endH - startH)) * 3600 * 1000
  // 三段加权：上午 20% / 下午 30% / 晚上 50%
  const r = Math.random()
  const offset = r < 0.2 ? Math.random() * 0.3 : r < 0.5 ? (0.3 + Math.random() * 0.35) : (0.65 + Math.random() * 0.35)
  return { day, atMs: base.getTime() + Math.round(spanMs * offset) }
}

/** 心情强度：最大偏离，0~1 */
function moodIntensity(mood) {
  try {
    let max = 0
    const cur = (mood && mood.current) || {}
    const base = (mood && mood.base) || {}
    for (const k of Object.keys(cur)) {
      const d = Math.abs(Number(cur[k] || 0) - Number(base[k] || 0))
      if (d > max) max = d
    }
    return { intensity: max, label: (mood && mood.composite && mood.composite.label) || '' }
  } catch {
    return { intensity: 0, label: '' }
  }
}

/** 今天/昨天真实发生的事（daystream + 日记） */
function gatherEvents(home, now) {
  const out = []
  try {
    const rows = recentActivity(home, 30)
    for (const e of rows) {
      const at = Number(e && e.at) || 0
      if (now - at > 20 * 3600 * 1000) continue
      const line = String((e && (e.line || e.label || e.text)) || '').trim()
      if (line) out.push({ at, line })
    }
  } catch {}
  try {
    const diary = loadDiary(diaryPath(home))
    const rows = recentEntries(diary, 2)
    for (const e of rows) {
      const at = Number(e && (e.at || e.ts)) || 0
      const text = String((e && (e.text || e.title || e.content)) || '').trim()
      if (text) out.push({ at, line: '日记：' + text.replace(/\s+/g, ' ').slice(0, 160) })
    }
  } catch {}
  out.sort((a, b) => a.at - b.at)
  // 去重 + 最多 6 条
  const seen = new Set()
  const uniq = []
  for (const e of out) {
    const k = e.line.slice(0, 40)
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(e)
  }
  return uniq.slice(-6)
}

/**
 * 每轮 tick 调一次（ProactiveScheduler 的 45s 心跳里）。
 * 永远不抛异常。
 */
let RUNNING = false

export async function tickQzoneAuto(ctx, options = {}) {
  const t0 = Date.now()
  // 45 秒一次的 tick 可能重叠（LLM 一慢就前后两轮同时跑），并发会绕过每日配额
  if (RUNNING) return { ok: true, skipped: 'busy' }
  RUNNING = true
  try {
    const config = (ctx && ctx.config) || {}
    const bridge = ctx && typeof ctx.getBridge === 'function' ? ctx.getBridge() : ctx && ctx.bridge
    const log = (ctx && ctx.log) || console
    const force = options.force === true
    if (!force && config.qzoneAutoPost === false) return { ok: true, skipped: 'off' }
    if (!bridge || bridge.state !== 'online') return { ok: true, skipped: 'bridge-offline' }
    // 顺手刷新「最近的说说」缓存（10 分钟一次），让她在对话里能看到 tid
    try { await refreshFeedCache(bridge, { maxAgeMs: 600_000, limit: 5 }) } catch {}

    const now = Date.now()
    const home = stateHome()
    const startH = Math.min(23, Math.max(0, num(config.qzoneAutoStart, 9)))
    const endH = Math.min(24, Math.max(startH + 1, num(config.qzoneAutoEnd, 23)))
    const hour = new Date(now).getHours()
    if (!force && (hour < startH || hour >= endH)) return { ok: true, skipped: 'quiet-hours' }

    const perDay = Math.min(3, Math.max(0, Math.round(num(config.qzoneAutoPostPerDay, 1))))
    if (!force && perDay <= 0) return { ok: true, skipped: 'per-day-0' }
    const minGapMs = Math.max(1, num(config.qzoneAutoPostMinGapHours, 5)) * 3600 * 1000
    const day = dayKey(now)
    const st = loadAutoState(home)
    const todayItems = st.items.filter((it) => it && it.day === day)
    if (!force && todayItems.length >= perDay) return { ok: true, skipped: 'daily-quota' }
    if (!force && st.lastAt && now - st.lastAt < minGapMs) return { ok: true, skipped: 'min-gap' }

    // 每天排一个随机时刻
    if (!st.plan || st.plan.day !== day || !Number(st.plan.atMs)) {
      st.plan = planForDay(day, startH, endH, now)
      saveAutoState(home, st)
      log.info && log.info(`[空间] 今天排的说说时刻：${stamp(st.plan.atMs)}`)
    }
    const duePlanned = force || now >= Number(st.plan.atMs)
    // 强情绪 / 新事件 → 提前发
    let mood = null
    try { mood = readMood(home, now) } catch {}
    const mi = moodIntensity(mood)
    const events = gatherEvents(home, now)
    const freshEvent = events.some((e) => e.at && now - e.at < 90 * 60 * 1000)
    const strongMood = mi.intensity >= num(config.qzoneAutoMoodThreshold, 0.45)
    const burst = (freshEvent || strongMood) && (now - st.lastAt > Math.min(minGapMs, 90 * 60 * 1000))
    if (!duePlanned && !burst) {
      return { ok: true, skipped: 'not-yet', planAt: st.plan.atMs, mood: mi.intensity }
    }

    // 没料就不编
    const moodLine = (() => { try { return renderMoodPrompt(mood) || '' } catch { return '' } })()
    if (!events.length && !moodLine) {
      st.lastSkipAt = now
      st.plan = { day, atMs: now + 3 * 3600 * 1000 }
      saveAutoState(home, st)
      return { ok: true, skipped: 'no-material' }
    }

    const system = systemPrompt(config, { channel: 'qzone' }) +
      '\n\n【现在要做的不是回消息】你要往自己的 QQ 空间发一条说说：说给好友看的一句话，不是回谁、也不 @ 谁。写完就发出去了。'

    const eventLines = events.map((e) => '· ' + (e.at ? stamp(e.at) + ' ' : '') + e.line).join('\n') || '（今天没什么特别的）'
    const ask = [
      `现在是 ${stamp(now)}（${hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上'}）。`,
      '',
      '【你此刻的心情】',
      moodLine ? moodLine.replace(/^你现在的心情状态：/m, '') : '（平平的，没什么起伏）',
      '',
      dayStateBlock(home, new Date(now), { maxEvents: 6 }),
      '',
      '写一条发到 QQ 空间的说说。要求：',
      '- 就一条，15~120 字，最多两行；',
      '- 第一人称、口语、随口吐槽或感慨，不要作文腔、不要排比抒情、不要总结升华；',
      '- 不要用引号把正文包起来，不要标题、不要解释、不要括号注释；',
      '- emoji 最多一个，不要堆；',
      '- 不提「AI」「模型」「插件」这类身份词；',
      '- 只能用上面【你此刻的真实状态】里写到的内容；状态里没有的场景（搬家、出门、旅游、生病、换工作）一律不许写；',
      '- 不许写主人的隐私：QQ 号、生日、学校/专业/工作单位、住址、手机号，也不要复述你俩私聊里的具体细节；',
      '- 心里确实没什么想说的，就只输出 [跳过]。',
    ].join('\n')

    const result = await generateText(ctx.ctx, {
      system,
      messages: [{ role: 'user', text: ask }],
      config,
      timeoutMs: 60_000,
      log: (line) => log.warn && log.warn(line),
    })
    if (!result || !result.ok) {
      st.lastSkipAt = now
      saveAutoState(home, st)
      return { ok: false, error: `${(result && result.reason) || 'llm'}: ${(result && result.message) || ''}` }
    }
    let text = parseSkip(result.text)
    if (!text) {
      st.lastSkipAt = now
      st.plan = { day, atMs: now + 3 * 3600 * 1000 }
      saveAutoState(home, st)
      log.info && log.info('[空间] 她说这次没什么想发的（[跳过]）')
      return { ok: true, skipped: 'she-skipped' }
    }
    text = cleanReply(text, 220)
      .replace(/\[[^\]\n]{1,40}\]/g, '')     // 清掉 [sticker:..] [voice:..] 之类
      .replace(/^["“」]+|["“”]+$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    text = scrubPublic(text, config)
    if (!text) return { ok: true, skipped: 'empty-after-clean' }

    // 试写（dry）：只生成，不配图不发帖
    if (options.dry) {
      const brief = dayStateBlock(home, new Date(now), { maxEvents: 6 })
      return { ok: true, dry: true, text, brief }
    }

    let images = []
    let genPrompt = ''
    const wantImgs = Number(config.qzonePostImages == null ? 1 : config.qzonePostImages)
    if (wantImgs > 0 && config.qzoneGenImages !== false) {
      try {
        const g = await qzoneImagesFor(ctx.ctx, config, text, { count: wantImgs, log: (line) => log.warn && log.warn('[空间] ' + line) })
        images = g.images || []
        genPrompt = g.prompt || ''
        if (g.error) log.warn && log.warn('[空间] 生图失败，退回表情包：' + g.error)
      } catch (e) {
        log.warn && log.warn('[空间] 生图异常：' + ((e && e.message) || e))
      }
    }
    if (!images.length) {
      try {
        images = pickQzoneImages(config, text + ' ' + (moodLine || ''), wantImgs)
      } catch (e) {
        log.warn && log.warn('[空间] 配图挑选失败：' + ((e && e.message) || e))
      }
    }
    const r = await postQzone(bridge, text, { images, ugcRight: config.qzoneUgcRight || 1 })
    const pickedFiles = lastQzoneImageFiles()
    if (images.length) {
      log.info && log.info('[空间] 配图：' + (genPrompt ? 'AI 生成 · ' + genPrompt.slice(0, 60) : (pickedFiles.join('，') || images.length + ' 张')))
    }
    if (!r.ok) {
      log.warn && log.warn('[空间] 自动说说发送失败：' + r.error)
      st.lastSkipAt = now
      st.plan = { day, atMs: now + 30 * 60 * 1000 }
      saveAutoState(home, st)
      return { ok: false, error: r.error }
    }

    const item = {
      day,
      at: now,
      text,
      mood: moodLine ? moodLine.replace(/\n+/g, ' ').slice(0, 120) : '',
      reason: burst ? (freshEvent ? 'event' : 'mood') : 'planned',
      provider: (result.model && result.model.provider) || '',
      model: (result.model && result.model.model) || '',
      tid: String((r && r.tid) || ''),
      images: images.length,
      imageFiles: genPrompt ? ['generated: ' + genPrompt] : pickedFiles,
      imageSource: genPrompt ? 'ai' : (pickedFiles.length ? 'sticker' : ''),
    }
    st.items.push(item)
    st.lastAt = now
    st.plan = { day, atMs: now + 4 * 3600 * 1000 }
    saveAutoState(home, st)
    log.info && log.info(`[空间] 发了一条说说（${item.reason}）：${text.replace(/\n/g, ' ').slice(0, 50)}`)

    // 复刻旧插件的「通知主人」
    try {
      const adminId = String(config.accessAdminId || config.ownerQq || '').replace(/\D/g, '')
      if (config.qzoneNotifyOwner !== false && adminId && typeof bridge.send === 'function') {
        await bridge.send({ kind: 'private', id: adminId, userId: adminId }, `我在空间发了条说说：\n${text}\n\n（不想让我自己发就去面板关掉「自动说说」）`)
      }
    } catch (e) {
      log.warn && log.warn('[空间] 通知主人失败：' + ((e && e.message) || e))
    }

    return { ok: true, sent: true, text, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    RUNNING = false
  }
}

/** 给面板用：最近发了什么 */
export function autoPostStatus(home, limit = 20) {
  const st = loadAutoState(home)
  return {
    lastAt: st.lastAt,
    plan: st.plan,
    items: st.items.slice(-limit).reverse(),
  }
}
