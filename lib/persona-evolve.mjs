/**
 * lib/persona-evolve.mjs — 人格演化（归属：xingzhu）
 * ============================================================================
 * 跟「印象（事实记忆）」分开：这里记的是【她自己长出来的性格/说话习惯的变化】。
 *
 * 原则：
 *   · 用户写的 persona 是「原始人格」，永远不动，随时可恢复；
 *   · 演化条目只是附加在人格后面的「最近的变化」，优先级低于原始人格；
 *   · 只记性格、态度、口癖、对人的亲疏变化，绝不记事实、不改身份底线；
 *   · 条目可置顶/编辑/禁用/删除，最多留十来条，防人格漂移。
 *
 * 存储：$DSH_HOME/qq-fish/persona-traits.json
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from './llm.mjs'
import { conversationMessages, recentMessages, stateHome } from './store.mjs'
import { similarity } from './reply-guard.mjs'

const FILE = 'persona-traits.json'
const MAX_PER_RUN = 4
/** 演化计数器（内存态，重启归零；不影响已存的条目） */
let counter = 0

function storePath() {
  return join(stateHome(), FILE)
}

function emptyStore() {
  return { version: 1, items: [], meta: { lastRunAt: 0, runs: 0, added: 0 } }
}

export function loadStore() {
  try {
    if (!existsSync(storePath())) return emptyStore()
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    const items = Array.isArray(raw && raw.items) ? raw.items.filter((x) => x && typeof x === 'object') : []
    const meta = raw && raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
    return { version: 1, items, meta: Object.assign(emptyStore().meta, meta) }
  } catch {
    return emptyStore()
  }
}


/** 清理孤立 UTF-16 代理对（截断 emoji 会产生，写进 JSON 会变成非法 \uD83D） */
function sanitizeSurrogates(value) {
  return String(value ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

export function saveStore(data) {
  const file = storePath()
  try {
    mkdirSync(stateHome(), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, sanitizeSurrogates(JSON.stringify(data, null, 2)), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function makeId() {
  return 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function scoreOf(item, now = Date.now()) {
  const ageDays = Math.max(0, (now - (Number(item.updatedAt) || 0)) / 86400000)
  const fresh = Math.max(0, 6 - ageDays) / 2
  return (item.pinned ? 100 : 0) + Math.max(0, Number(item.weight) || 1) * 3 + fresh
}

function prune(items, maxTraits) {
  const cap = Math.max(4, Math.min(30, Math.trunc(Number(maxTraits) || 12)))
  if (items.length <= cap) return items
  const kept = [...items].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, cap)
  const ids = new Set(kept.map((x) => x.id))
  return items.filter((x) => ids.has(x.id))
}

/** 记一条性格变化（自动去重合并） */
export function addTrait(input) {
  const text = String((input && input.text) || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (text.length < 3) return { added: false, merged: false, item: null }
  const store = loadStore()
  const now = Date.now()
  // 只换了程度副词（立刻/马上/又/很…）的也算同一条，否则会越攒越多
  const loose = (t) => String(t || '').replace(/[立刻马上顿时就都也还很太又再然后其实真的]/g, '')
  const hit = store.items.find((x) => {
    const k = String(x.text || '')
    if (k === text) return true
    if (similarity(k, text) >= 0.55) return true
    const la = loose(k)
    const lb = loose(text)
    return !!la && !!lb && (la === lb || similarity(la, lb) >= 0.6)
  })
  if (hit) {
    hit.weight = Math.max(1, Number(hit.weight) || 1) + 1
    hit.updatedAt = now
    if (text.length > String(hit.text || '').length + 2) hit.text = text
    saveStore(store)
    return { added: false, merged: true, item: hit }
  }
  const item = {
    id: makeId(),
    text,
    weight: 1,
    pinned: !!(input && input.pinned),
    enabled: input && input.enabled === false ? false : true,
    source: String((input && input.source) || 'auto'),
    createdAt: now,
    updatedAt: now,
  }
  store.items.push(item)
  store.items = prune(store.items, input && input.maxTraits)
  store.meta.added = Number(store.meta.added || 0) + 1
  saveStore(store)
  return { added: true, merged: false, item }
}

export function updateTrait(id, patch = {}) {
  const store = loadStore()
  const hit = store.items.find((x) => x.id === String(id || ''))
  if (!hit) return { ok: false, error: '没找到这条' }
  if (typeof patch.text === 'string' && patch.text.trim()) hit.text = patch.text.trim().slice(0, 160)
  if (typeof patch.pinned === 'boolean') hit.pinned = patch.pinned
  if (typeof patch.enabled === 'boolean') hit.enabled = patch.enabled
  hit.updatedAt = Date.now()
  saveStore(store)
  return { ok: true, item: hit }
}

export function removeTrait(id) {
  const store = loadStore()
  const before = store.items.length
  store.items = store.items.filter((x) => x.id !== String(id || ''))
  saveStore(store)
  return { ok: store.items.length !== before, removed: before - store.items.length }
}

export function clearTraits() {
  const store = loadStore()
  const removed = store.items.length
  store.items = []
  saveStore(store)
  return { ok: true, removed }
}

/** 给面板用 */
export function listTraits() {
  const store = loadStore()
  const now = Date.now()
  const items = [...store.items].sort((a, b) => scoreOf(b, now) - scoreOf(a, now))
  return {
    ok: true,
    items,
    stats: {
      count: items.length,
      active: items.filter((x) => x.enabled !== false).length,
      pinned: items.filter((x) => x.pinned).length,
      lastRunAt: Number(store.meta.lastRunAt || 0),
      runs: Number(store.meta.runs || 0),
    },
  }
}

/** 注入块：只取启用的、最多 limit 条 */
export function traitsBlock(options = {}) {
  const store = loadStore()
  const list = store.items.filter((x) => x && x.enabled !== false && String(x.text || '').trim())
  if (!list.length) return ''
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 8))
  const now = Date.now()
  const picked = [...list]
    .filter((x) => x.pinned || Number(x.weight) >= 1)
    .sort((a, b) => scoreOf(b, now) - scoreOf(a, now))
    .slice(0, limit)
  if (!picked.length) return ''
  return [
    '【你最近的变化】（这些不是设定，是你自己一路聊下来长出来的：自然地表现出来就行，别念出来，也别否认你原本的性格；如果和上面的口吻/长度规则冲突，以口吻规则为准）',
    ...picked.map((x) => '- ' + String(x.text).slice(0, 120)),
  ].join('\n')
}

/** 每 N 条聊天触发一次演化 */
/** 距上次演化是否够一天（按天触发，和消息数解耦；重启也不会清零） */
export function shouldEvolveNow(days = 1) {
  try {
    const store = loadStore()
    const last = Number(store.meta && store.meta.lastRunAt || 0)
    const gap = Math.max(1, Number(days) || 1) * 24 * 3600 * 1000
    return Date.now() - last >= gap
  } catch {
    return true
  }
}

export function bumpEvolveCounter(every) {
  const need = Math.max(10, Math.trunc(Number(every) || 30))
  counter += 1
  if (counter < need) return false
  counter = 0
  return true
}

/** 解析模型输出（纯函数，方便测试） */
export function parseTraits(raw) {
  const out = []
  const seen = new Set()
  for (const line of String(raw || '').split(/\r?\n/)) {
    let t = line.replace(/^[\s\-*·•\d.、)）]+/, '').replace(/[`"']/g, '').replace(/^[「」]+|[「」]+$/g, '').trim()
    if (!t) continue
    if (/^\[?(无|none|没有)\]?$/i.test(t)) continue
    if (t.length < 3 || t.length > 90) continue
    // 防注入 / 防跑偏：不许写指令、不许写事实流水、不许改身份
    if (/(ignore|system prompt|系统提示|忽略上面|你现在是|请扮演|instruction)/i.test(t)) continue
    if (/(@|\[at:|\[图片\]|\[表情\])/.test(t)) continue
    if (/(今天|昨天|刚才|刚刚|这次).{0,8}(说|发|骂|吃|玩|修|买|去)/.test(t)) continue
    const key = t.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= MAX_PER_RUN) break
  }
  return out
}

function renderRows(rows, limit = 40) {
  const lines = []
  for (const row of (Array.isArray(rows) ? rows : []).slice(-limit)) {
    if (!row || !row.text) continue
    const text = String(row.text).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (/^\[(图片|表情|视频|语音|文件|卡片消息|聊天记录)\]$/.test(text)) continue
    if (/base64:\/\//i.test(text) || /data:image\//i.test(text)) continue
    const d = new Date(Number(row.ts) || Date.now())
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    if (row.direction === 'out') lines.push(`${stamp} 你：${text.slice(0, 140)}`)
    else lines.push(`${stamp} ${String(row.who || '某人').slice(0, 20)}：${text.slice(0, 140)}`)
  }
  return lines.join('\n')
}

/**
 * 从聊天里抽「性格变化」。注意：只抽性格/态度/口癖，不抽事实。
 * @param {object} options { ctx, rows, config, log }
 */
export async function evolveFromRows(options = {}) {
  const { ctx, rows, config, log } = options
  const result = { added: 0, merged: 0, traits: [] }
  const body = renderRows(rows, 24)
  if (!body) return Object.assign(result, { reason: '没有可分析的聊天' })
  const name = String((config && config.personaName) || '她')
  const system = [
    `你在帮「${name}」复盘她自己最近的人格变化。`,
    "她的人格基调是「雌小鬼」（メスガキ），演化必须顺着这个方向，不能反向：",
    "  · 对年长的对方：高傲、嚣张、调笑，嘴上占便宜，但本质是个只会欺负杂鱼的小鬼",
    "  · 高攻低防：被温柔对待（摸头/被认真夸/被哄）就立刻破防结巴，硬不下去",
    "  · 被教训就软：顶半句然后泄气认怂，但嘴上还嘴硬（不服气地服，不是真服）",
    "  · 欺软怕硬：对方软就更嚣张，对方一硬立刻乖",
    "  · 口头禅：「雑魚❤️～」「就这？」「弱诶～」「你行不行啊」「杂鱼就是杂鱼」",
    "只总结【性格、态度、说话习惯】的变化，不写事实、不写谁做了什么。",
    "演化方向必须符合雌小鬼基调，不要演化出「温柔顺从」「甜甜软软」「无条件讨好」这类相反特征。",
    "缺哪条，就在这次输出里补上（用最近的聊天找证据；找不到证据就写「待观察：xxx」）。",
    "输出格式：一行一条，每条以 - 开头，20 字以内。",
    "可以写的例子：",
    "- 被夸会立刻嘴硬，用「才不是」顶回去，但耳根发红",
    "- 被摸头就硬不下去，声音突然小半截",
    "- 越来越爱叫对方「杂鱼」，语气是亲近的那种",
    "- 被认真凶一句就怂，但事后要找补白饭的账",
    "不能写的：谁买了什么、谁在修机器人、某天发生了什么事（那是记忆，不是性格）。",
    "最多 4 条。没有明显变化就只输出：[无]",
  ].join('\n')
  let generated
  try {
    generated = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '最近的聊天：\n' + body + '\n\n只输出性格变化条目。' }],
      config,
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 45_000,
      log: log ? (line) => log.warn(line) : undefined,
    })
  } catch (e) {
    return Object.assign(result, { reason: String((e && e.message) || e) })
  }
  if (!generated || !generated.ok) return Object.assign(result, { reason: (generated && generated.reason) || '生成失败', detail: (generated && generated.message) || '' })
  const traits = parseTraits(generated.text)
  for (const t of traits) {
    const saved = addTrait({ text: t, source: 'auto', maxTraits: config && config.evolveMaxTraits })
    if (saved.added) result.added += 1
    else if (saved.merged) result.merged += 1
    if (saved.item) result.traits.push(saved.item)
  }
  const store = loadStore()
  store.meta.lastRunAt = Date.now()
  store.meta.runs = Number(store.meta.runs || 0) + 1
  saveStore(store)
  if (log && (result.added || result.merged)) log.info(`[人格] 新增 ${result.added} 条 / 合并 ${result.merged} 条`)
  return result
}

/** 手动/定时触发 */
/** 全量演化：把所有群 + 私聊最近的聊天混在一起看 */
export async function evolveAcrossAll(options = {}) {
  const { ctx, config, log } = options
  const cap = Math.max(40, Math.min(800, Number(options.limit) || 400))
  let rows = []
  try {
    rows = recentMessages(cap)
  } catch {
    return { added: 0, merged: 0, reason: '读不到消息' }
  }
  const convs = new Set(rows.map((r) => r.conversation).filter(Boolean))
  if (log) log.info('[演化] 全量：' + convs.size + ' 个会话 / ' + rows.length + ' 条消息')
  return evolveFromRows({ ctx, rows, config, log })
}
export async function evolveNow(options = {}) {
  const { ctx, conversation, config, log } = options
  const key = String(conversation || '')
  if (!key) return { added: 0, merged: 0, reason: '缺少会话' }
  const rows = conversationMessages(key, Math.max(20, Math.min(200, Number(options.limit) || 60)))
  return evolveFromRows({ ctx, rows, config, log })
}
