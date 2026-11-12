/**
 * lib/reinterpret.mjs — 动态记忆：老记忆会被「重新理解」
 * ============================================================================
 * 不是记住更多，而是同一件事过一段时间回头看，看法变了。
 * 每天挑一条她 7 天前说过的话，让她用现在的自己重新解释一遍。
 * 数据：qq-fish/reinterpret.json
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recentMessages, stateHome } from './store.mjs'

const FILE = join(stateHome(), 'reinterpret.json')
const DEFAULTS = { enabled: true, items: [], lastRunDate: '' }

let cache = null
let cacheAt = 0

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function loadReinterpret() {
  const now = Date.now()
  if (cache && now - cacheAt < 30_000) return cache
  let raw = null
  try { raw = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
  cache = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(cache.items)) cache.items = []
  cacheAt = now
  return cache
}

async function save(v) {
  cache = v
  cacheAt = Date.now()
  try { await writeFile(FILE, JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
  return v
}

/**
 * 每天一次：挑一条 7 天前她说过的话，用模型写「现在的看法」。
 * 依赖 generateText 由 engine 注入。
 */
export async function reinterpretOne({ generateText, ctx, config, log } = {}) {
  if (typeof generateText !== 'function') return null
  const v = await loadReinterpret()
  if (v.enabled === false) return null
  const today = todayStr()
  // 每天最多 3 条（原来只有 1 条，用户反馈"看不到变化"）
  if (v.lastRunDate !== today) { v.lastRunDate = today; v.todayCount = 0 }
  const MAX_PER_DAY = 3
  if (Number(v.todayCount || 0) >= MAX_PER_DAY) return null

  const all = (recentMessages(2000) || []).filter((m) => m && m.ts && m.direction === 'out')
  const weekAgo = Date.now() - 2 * 86400000   // 原来 3 天前，改成 2 天前（更近的也能回看）
  const doneSrc = new Set(v.items.map((x) => x.srcTs))
  const cand = all.filter((m) => m.ts < weekAgo && !doneSrc.has(m.ts) && String(m.text || '').length >= 15 && !/^\[(语音|图片|表情)\]/.test(String(m.text || '')))
  if (!cand.length) {
    v.lastRunDate = today
    v.todayCount = Number(v.todayCount || 0) + 1
    await save(v)
    return null
  }
  const pick = cand[Math.floor(Math.random() * cand.length)]
  const original = String(pick.text || '').replace(/\s+/g, ' ').slice(0, 120)

  try {
    const r = await generateText(ctx, {
      system: [
        '你是「大肥鱼」本人，正在回头看自己一周前说过的话。',
        '要求：',
        '- 用第一人称写一句「现在回头看」的感受，40 字以内',
        '- 允许：更确定了 / 觉得当时幼稚 / 想起来还想笑 / 完全改了想法 / 无所谓了',
        '- 不要解释、不要旁白、不要引号，只输出那一句话',
      ].join('\n'),
      messages: [{ role: 'user', text: `你一周前说过：「${original}」\n\n现在回头看，你想说：` }],
      config,
      temperature: 1.1,
      maxTokens: 120,
      timeoutMs: 40_000,
      log: () => {},
    })
    v.lastRunDate = today
    v.todayCount = Number(v.todayCount || 0) + 1
    if (!r || !r.ok) { await save(v); return null }
    const view = String(r.text || '').replace(/^["'「」]+|["'「」]+$/g, '').trim().slice(0, 80)
    if (!view) { await save(v); return null }
    const item = {
      id: 'r' + Date.now().toString(36),
      srcTs: pick.ts,
      original,
      view,
      at: Date.now(),
    }
    v.items.push(item)
    if (v.items.length > 12) v.items = v.items.slice(-12)
    await save(v)
    return item
  } catch (e) {
    log && log.warn && log.warn('记忆重解失败：' + ((e && e.message) || e))
    return null
  }
}

/** 注入：她「后来想想」的那些 */
export async function reinterpretPromptBlock(limit = 2) {
  const v = await loadReinterpret()
  if (v.enabled === false || !v.items.length) return ''
  const list = v.items.slice(-limit)
  const lines = list.map((x) => `- 一周前你说过「${x.original}」，后来想想：「${x.view}」`)
  return '【后来想想】\n' + lines.join('\n') +
    '\n（这些是你自己改过看法的事。聊天里自然带出来就好，不用特地说「我之前说过」。）'
}

export async function reinterpretSnapshot() {
  const v = await loadReinterpret()
  return { enabled: v.enabled !== false, items: v.items.slice(-12).reverse(), lastRunDate: v.lastRunDate || '' }
}

export async function clearReinterpret() {
  const v = await loadReinterpret()
  v.items = []
  await save(v)
  return reinterpretSnapshot()
}
