/**
 * lib/life-share.mjs — 她自己决定「这会儿的日子，要不要说出去、说在哪儿」
 * ============================================================================
 * 和 qzone-auto 的区别：
 *   · qzone-auto 是「QQ 空间这一件事」的排班（今天该发几条、什么时候发）；
 *   · 这一层管的是跨平台的**分享意愿**：今天真发生过什么、现在心情如何、
 *     她想不想让人知道、想让谁看到（QQ 找他 / 空间 / 抖音图文）。
 *
 * 三条硬原则（都是主人反复说过的）：
 *   1. 不编造没发生的事。素材只来自 daystream 的真实条目、记忆卡里的公开经历、
 *      以及 config 里记录的真刷过/真发过的时间戳。
 *   2. 她有权拒绝。模型输出 {"go":false} 就真的不发，不补、不重试。
 *   3. 平台之间只共享「公开经历」。群聊里的私事永远不进公开平台的提示词
 *      （这条在 sc/memory-card.mjs 的 visibleFor 里已经做掉了）。
 * ============================================================================
 */
import { generateText } from './llm.mjs'
import { addMemory } from './memory-decay.mjs'
import { loadStream, currentActivity } from './daystream.mjs'
import { loadDay, dateStr } from './dayplan.mjs'
import { readMood } from './vitals.mjs'
import { postQzone, pickQzoneImages } from './qzone.mjs'
import { qzoneImagesFor } from './imagegen.mjs'
import { loadAutoState } from './qzone-auto.mjs'

const STATE_FILE = 'life-share.json'
const MAX_ITEMS = 60

const PLATFORM_LABEL = {
  qq: 'QQ 私聊跟他说',
  qzone: 'QQ 空间发条说说',
  douyin: '抖音发条图文',
  bili: 'B站发条动态',
}

function statePath(home) {
  return String(home || '').replace(/\/$/, '') + '/' + STATE_FILE
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

export function loadShareState(home) {
  try {
    const j = JSON.parse(readFileSync(statePath(home), 'utf8'))
    return {
      lastAt: Number(j.lastAt) || 0,
      perDay: j.perDay && typeof j.perDay === 'object' ? j.perDay : {},
      items: Array.isArray(j.items) ? j.items : [],
    }
  } catch {
    return { lastAt: 0, perDay: {}, items: [] }
  }
}

export function saveShareState(home, st) {
  try {
    mkdirSync(String(home), { recursive: true })
    writeFileSync(
      statePath(home),
      JSON.stringify({ lastAt: Number(st.lastAt) || 0, perDay: st.perDay || {}, items: (st.items || []).slice(-MAX_ITEMS) }),
      'utf8',
    )
  } catch {}
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function hm(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

function minuteOf(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return fallback
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])))
}

/** 今天真实发生过的事（只读，不编） */
export function gatherTodayEvents(home, now = Date.now()) {
  const st = loadStream(home)
  const today = dayKey(now)
  const out = []
  for (const e of st.entries || []) {
    if (dayKey(e.at) !== today) continue
    const line = String(e.line || '').trim()
    if (line) out.push({ at: e.at, label: String(e.label || ''), line })
  }
  // 再加上她今天原本给自己安排的事（dayplan）：已经过去的那些才算「今天发生过的」
  // —— 光有时间流里那些「犯困/发呆」太单薄，说不出人话。
  try {
    const day = loadDay(home, dateStr(new Date(now)))
    for (const it of (day && day.items) || []) {
      const start = String(it.start || '').trim()
      if (!/^\d{1,2}:\d{2}$/.test(start)) continue
      const [hh, mm] = start.split(':').map(Number)
      const at = new Date(now)
      at.setHours(hh, mm, 0, 0)
      if (at.getTime() > now) continue
      const act = String(it.activity || it.title || '').trim()
      const detail = String(it.detail || '').trim()
      if (!act && !detail) continue
      const line = [act, detail].filter(Boolean).join('：')
      out.push({ at: at.getTime(), label: '安排', line: line.slice(0, 90), from: 'plan' })
    }
  } catch {}
  out.sort((a, b) => a.at - b.at)
  return out.slice(-12)
}

/** 分享闸门：会阻塞就先别花 token 问模型 */
export function shareGate({ home, config = {}, now = Date.now() } = {}) {
  if (config.lifeShareEnabled === false) return { ok: false, reason: 'disabled' }
  const startM = minuteOf(config.lifeShareStart, 10 * 60)
  const endM = minuteOf(config.lifeShareEnd, 23 * 60 + 30)
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (cur < startM || cur > endM) return { ok: false, reason: 'off-hours' }

  const st = loadShareState(home)
  const minGap = Math.max(30, Number(config.lifeShareMinGapMinutes || 240)) * 60_000
  if (st.lastAt && now - st.lastAt < minGap) {
    return { ok: false, reason: 'cooldown', nextAt: st.lastAt + minGap }
  }
  const cap = Math.max(1, Number(config.lifeShareMaxPerDay || 3))
  const used = Number((st.perDay || {})[dayKey(now)] || 0)
  if (used >= cap) return { ok: false, reason: 'daily-cap' }

  const events = gatherTodayEvents(home, now)
  if (!events.length) return { ok: false, reason: 'no-material' }

  return { ok: true, reason: 'ok', events, used, cap }
}

/** 把处境摆给她，让她自己决定要不要说、说在哪儿 */
export async function composeShare(ctx, { home, config = {}, log, now = Date.now(), events = [] } = {}) {
  const allowed = String(config.lifeSharePlatforms || 'qzone,douyin,qq')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => PLATFORM_LABEL[s])
  // 别跟「自动说说」撞车：qzone-auto 刚发过就暂时把空间从候选里拿掉
  let noteQzone = ''
  if (allowed.includes('qzone') && config.qzoneAutoPost !== false) {
    try {
      const ast = loadAutoState(home)
      const lastQz = Number(ast.lastAt || 0)
      if (lastQz && now - lastQz < 3 * 3600 * 1000) {
        const i = allowed.indexOf('qzone')
        allowed.splice(i, 1)
        noteQzone = '（空间刚发过一条，这次别发空间）'
      }
    } catch {}
  }
  if (!allowed.length) return { ok: false, reason: 'no-platform' }

  const act = currentActivity(home, now)
  let mood = ''
  try {
    const m = readMood(home, now)
    if (m && typeof m === 'object') {
      mood = String(m.label || m.summary || m.desc || '').slice(0, 40)
    }
  } catch {}

  const evText = events
    .map((e) => '· ' + hm(e.at) + ' ' + e.line)
    .join('\n')
    .slice(0, 1200)

  const system = [
    '你就是「大肥鱼」，一个住在主人电脑里的小鲸鱼女孩，有自己的日子。',
    '现在没人问你话，是你自己在想要不要把今天的事说出去。',
    '不要说教、不要总结人生，就像一个普通女孩突然想发条动态。',
    '如果今天没什么想说的，就老实说不发——这很正常。',
    '只输出一行 JSON，不要代码块，不要解释：',
    '{"go":true,"platform":"qzone","text":"要说的话"} 或 {"go":false,"why":"不想说的原因"}',
    'platform 只能是：' + allowed.join(' / ') + '。' + noteQzone,
    'text 要像真的动态：口语、短（40~120 字），可以带一点情绪，不要列清单，不要提「记忆」「模型」这些词。',
  ].join('\n')

  const user = [
    '现在：' + hm(now) + (act && act.line ? '，你正在：' + act.line : ''),
    mood ? '身体和心情：' + mood : '',
    '今天真实发生过的：',
    evText || '（没什么特别的）',
  ]
    .filter(Boolean)
    .join('\n')

  const r = await generateText(ctx, {
    feature: 'proactive',
    system,
    messages: [{ role: 'user', text: user }],
    config,
    maxTokens: 400,
    timeoutMs: 60_000,
    log,
  })
  if (!r || !r.ok) {
    const why = String((r && (r.message || r.reason)) || 'no-result')
    if (log && log.warn) log.warn('[生活分享] 让她决定时模型没回：' + why.slice(0, 160))
    return { ok: false, reason: 'llm-failed', message: why }
  }

  const raw = String(r.text || '').trim()
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return { ok: false, reason: 'bad-json', raw: raw.slice(0, 200) }
  let plan = null
  try {
    plan = JSON.parse(m[0])
  } catch {
    return { ok: false, reason: 'bad-json', raw: raw.slice(0, 200) }
  }
  if (!plan || plan.go !== true) return { ok: true, go: false, why: String((plan && plan.why) || '她不想说') }

  const platform = String(plan.platform || '').trim()
  if (!allowed.includes(platform)) return { ok: false, reason: 'bad-platform', platform }
  const text = String(plan.text || '').replace(/\s+\n/g, '\n').trim()
  if (text.length < 4) return { ok: false, reason: 'too-short' }
  return { ok: true, go: true, platform, text: text.slice(0, 500), model: (r.model && r.model.model) || '' }
}

/**
 * 真正发出去。成功才计数、才写记忆。
 * 返回 {ok, sent, platform, text, error?}
 */
export async function runShare(ctx, { home, config = {}, log, getBridge, now = Date.now(), force = false, dry = false } = {}) {
  let gate = shareGate({ home, config, now })
  if (!gate.ok && force) {
    // 强制（面板「预演」/手动点）：只跳过时间、冷却、每日上限，仍然要求今天真有事
    const events = gatherTodayEvents(home, now)
    gate = events.length ? { ok: true, events, used: 0, cap: 0 } : { ok: false, reason: 'no-material' }
  }
  if (!gate.ok) return { ok: true, sent: false, skipped: gate.reason, nextAt: gate.nextAt }

  const plan = await composeShare(ctx, { home, config, log, now, events: gate.events })
  if (!plan.ok) {
    if (log && log.warn) log.warn('[生活分享] 决定失败：' + plan.reason + (plan.message ? ' · ' + plan.message : '') + (plan.raw ? ' · ' + plan.raw.slice(0, 80) : ''))
    return { ok: false, error: plan.reason + (plan.message ? ' · ' + plan.message : '') + (plan.raw ? ' ' + plan.raw : '') }
  }
  if (!plan.go) {
    const st = loadShareState(home)
    st.lastAt = now
    st.items.push({ at: now, go: false, why: plan.why })
    saveShareState(home, st)
    return { ok: true, sent: false, skipped: 'she-declined', why: plan.why }
  }

  const platform = plan.platform
  const text = plan.text
  if (dry) return { ok: true, dry: true, wouldSend: { platform, text }, model: plan.model || '' }
  const bridge = typeof getBridge === 'function' ? getBridge() : ctx && ctx.bridge

  let result = { ok: false, error: 'no-bridge' }
  try {
    if (platform === 'qzone') {
      if (!bridge || bridge.state !== 'online') return { ok: false, error: 'bridge-offline' }
      let images = []
      // 【和 qzone-auto 一个口径】config.qzoneGenImages 为 true 时先用 AI 生图（她的真人 cos 画风），
      // 生成失败/为空才退回表情包。原来这里只调 pickQzoneImages，导致「生活分享」发到空间永远是表情，
      // 而 qzone-auto 自动说说却是 AI 图——同一个空间两种配图，主人一眼就看出不对。
      const wantImgs = Number(config.qzonePostImages == null ? 1 : config.qzonePostImages)
      if (wantImgs > 0 && config.qzoneGenImages !== false) {
        try {
          const g = await qzoneImagesFor(ctx, config, text, { count: wantImgs, log: (line) => { try { log && log.info && log.info('[生活分享] ' + line) } catch {} } })
          images = (g && g.images) || []
          if (g && g.error) { try { log && log.info && log.info('[生活分享] 生图失败，退回表情包：' + g.error) } catch {} }
        } catch (e) {
          try { log && log.info && log.info('[生活分享] 生图异常：' + ((e && e.message) || e)) } catch {}
        }
      }
      if (!images.length) {
        try {
          images = pickQzoneImages(config, text, wantImgs)
        } catch {}
      }
      const r = await postQzone(bridge, text, { images, ugcRight: config.qzoneUgcRight || 1 })
      result = { ok: !!r.ok, tid: String((r && r.tid) || ''), error: r.error }
    } else if (platform === 'qq') {
      const adminId = String(config.accessAdminId || config.ownerQq || '').replace(/\D/g, '')
      if (!adminId || !bridge || typeof bridge.send !== 'function') return { ok: false, error: 'no-admin' }
      await bridge.send({ kind: 'private', id: adminId, userId: adminId }, text)
      result = { ok: true }
    } else if (platform === 'douyin') {
      const dy = await import('./douyin.mjs')
      const st = await dy.loginStatus({ log })
      if (!st || !st.loggedIn) return { ok: true, sent: false, skipped: 'douyin-not-logged-in' }
      const r = await dy.publishImageText({ text, log })
      result = { ok: !!r.ok, error: r.error, note: r.note }
    } else if (platform === 'bili') {
      return { ok: true, sent: false, skipped: 'bili-share-not-wired' }
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) }
  }

  const st2 = loadShareState(home)
  const k = dayKey(now)
  if (result.ok) {
    st2.lastAt = now
    st2.perDay[k] = Number(st2.perDay[k] || 0) + 1
    st2.items.push({ at: now, go: true, platform, text, model: plan.model || '', tid: result.tid || '' })
    // 记忆：公开经历进对应平台的 scope，其它平台也读得到（visibleFor 决定谁能看）
    try {
      addMemory('她在' + PLATFORM_LABEL[platform] + '：' + text.replace(/\s+/g, ' ').slice(0, 260), {
        importance: 70,
        scope: platform === 'qq' ? 'shared' : platform,
        config,
      }, now)
    } catch (e) {
      if (log && log.warn) log.warn('[生活分享] 写记忆失败：' + ((e && e.message) || e))
    }
    if (log && log.info) log.info('[生活分享] 她在' + PLATFORM_LABEL[platform] + '分享了一条：' + text.slice(0, 40))
  } else {
    st2.items.push({ at: now, go: true, platform, text, error: result.error || '' })
  }
  saveShareState(home, st2)
  return { ok: result.ok, sent: !!result.ok, platform, text, error: result.error, note: result.note }
}

/** 面板用 */
export function shareStatus(home, config = {}, now = Date.now()) {
  const st = loadShareState(home)
  const gate = shareGate({ home, config, now })
  return {
    enabled: config.lifeShareEnabled !== false,
    window: [config.lifeShareStart || '10:00', config.lifeShareEnd || '23:30'],
    minGapMinutes: Number(config.lifeShareMinGapMinutes || 240),
    maxPerDay: Number(config.lifeShareMaxPerDay || 3),
    platforms: String(config.lifeSharePlatforms || 'qzone,douyin,qq'),
    usedToday: Number(st.perDay[dayKey(now)] || 0),
    lastAt: st.lastAt,
    canNow: gate.ok,
    blocked: gate.ok ? '' : gate.reason,
    nextAt: gate.nextAt || 0,
    items: st.items.slice(-20).reverse(),
  }
}
