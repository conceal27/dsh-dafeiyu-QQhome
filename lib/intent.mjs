/**
 * lib/intent.mjs — 自主意图：不是「到点该说话了」，而是「我今天想干这个」
 * ============================================================================
 * 每天生成 1-2 个意图（想做的事），存在 intent.json。
 * 主动搭话时优先执行意图；精力不够或时机不对就往后拖，拖久了自弃（跟 dsh-identity 的思路一致）。
 * 数据：qq-fish/intent.json
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const FILE = join(stateHome(), 'intent.json')

const DEFAULTS = {
  enabled: true,
  items: [], // { id, text, kind, reason, createdAt, dueAt, doneAt, droppedAt }
  lastGenerateDate: '',
  doneTotal: 0,
}

let cache = null
let cacheAt = 0

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function loadIntent() {
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

/** 当前活着的意图（没做完、没放弃、没过期的） */
export async function activeIntents() {
  const v = await loadIntent()
  if (v.enabled === false) return []
  const now = Date.now()
  return v.items.filter((x) => !x.doneAt && !x.droppedAt && (!x.dueAt || x.dueAt > now - 6 * 3600 * 1000))
}

/** 加一条意图 */
export async function addIntent(text, { kind = 'want', reason = '', ttlHours = 30 } = {}) {
  const t = String(text || '').trim().slice(0, 120)
  if (!t) return null
  const v = await loadIntent()
  const item = {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: t,
    kind,
    reason: String(reason || '').slice(0, 120),
    createdAt: Date.now(),
    dueAt: Date.now() + ttlHours * 3600 * 1000,
    doneAt: 0,
    droppedAt: 0,
  }
  v.items.push(item)
  if (v.items.length > 30) {
    const old = v.items.filter((x) => x.doneAt || x.droppedAt).sort((a, b) => (a.doneAt || a.droppedAt) - (b.doneAt || b.droppedAt))
    const drop = new Set(old.slice(0, v.items.length - 30).map((x) => x.id))
    v.items = v.items.filter((x) => !drop.has(x.id))
  }
  await save(v)
  return item
}

export async function finishIntent(id) {
  const v = await loadIntent()
  const it = v.items.find((x) => x.id === id)
  if (!it) return
  it.doneAt = Date.now()
  v.doneTotal = (Number(v.doneTotal) || 0) + 1
  await save(v)
}

export async function dropIntent(id) {
  const v = await loadIntent()
  const it = v.items.find((x) => x.id === id)
  if (!it) return
  it.droppedAt = Date.now()
  await save(v)
}

/** 过期的自动放弃（下次读取时顺手做） */
export async function expireIntents() {
  const v = await loadIntent()
  const now = Date.now()
  let changed = false
  for (const it of v.items) {
    if (!it.doneAt && !it.droppedAt && it.dueAt && it.dueAt < now) {
      it.droppedAt = now
      changed = true
    }
  }
  if (changed) await save(v)
  return changed
}

/** 注入：她今天想做的事 */
export async function intentPromptBlock() {
  const list = await activeIntents()
  if (!list.length) return ''
  const lines = list.slice(0, 2).map((x) => `- ${x.text}${x.reason ? '（' + x.reason + '）' : ''}`)
  return '【你今天想做的事】\n' +
    lines.join('\n') +
    '\n这些是你自己冒出来的念头，不是任务。有合适的机会就去做，做成了就当没发生一样顺口提一句；' +
    '没机会就搁着，别硬找场合汇报。'
}

/**
 * 用模型生成 1-2 条新意图。每天最多一次。
 * 依赖 generateText，由 engine 传进来（避免这个模块直接依赖 llm）。
 */
export async function generateIntents({ generateText, ctx, config, log, context = '', max = 2 } = {}) {
  if (typeof generateText !== 'function') return []
  const v = await loadIntent()
  if (v.enabled === false) return []
  const today = todayStr()
  if (v.lastGenerateDate === today) return []
  const active = await activeIntents()
  if (active.length >= 3) return [] // 已经积压了，先别加

  const sys = [
    '你在帮一个叫「大肥鱼」的 QQ 角色想她今天自己想做的小事。',
    '要求：',
    '- 每条 30 字以内，第一人称（我想… / 我想问… / 我想吐槽…）',
    '- 必须是日常小事：想尝尝什么、想问一个好奇的事、想吐槽某个话题、想找主人聊某件事',
    '- 不要写成任务清单，不要「今天要完成」这种口气',
    '- 不要涉及隐私、不要提具体功能、不要重复已有的',
    '只输出 JSON 数组，例如 ["我想问问主人那个新梗是什么意思","我想吐槽一下今天的天气"]，不要别的字。',
  ].join('\n')
  try {
    const r = await generateText(ctx, {
      system: sys,
      messages: [{ role: 'user', text: (context || '最近没什么特别的事。') + '\n\n已有的念头：\n' + (active.map((x) => '- ' + x.text).join('\n') || '（无）') }],
      config,
      temperature: 1.0,
      maxTokens: 200,
      timeoutMs: 40_000,
      log: () => {},
    })
    if (!r || !r.ok) return []
    const text = String(r.text || '')
    const m = /\[[\s\S]*\]/.exec(text)
    if (!m) return []
    const arr = JSON.parse(m[0])
    const added = []
    for (const t of arr.slice(0, max)) {
      const it = await addIntent(String(t), { kind: 'want', reason: '自己想出来的' })
      if (it) added.push(it)
    }
    if (added.length) {
      v.lastGenerateDate = today
      await save(v)
    }
    return added
  } catch (e) {
    log && log.warn && log.warn('生成意图失败：' + ((e && e.message) || e))
    return []
  }
}

/** 面板用 */
export async function intentSnapshot() {
  const v = await loadIntent()
  await expireIntents()
  const active = v.items.filter((x) => !x.doneAt && !x.droppedAt)
  const recent = v.items.slice(-10).reverse()
  return {
    enabled: v.enabled !== false,
    active,
    recent,
    doneTotal: v.doneTotal || 0,
    lastGenerateDate: v.lastGenerateDate || '',
  }
}

export async function clearIntents() {
  const v = await loadIntent()
  v.items = []
  await save(v)
  return intentSnapshot()
}
