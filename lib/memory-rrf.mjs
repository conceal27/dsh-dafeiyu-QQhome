/**
 * memory-rrf.mjs —— 记忆召回「一条路」
 *
 * 以前是两路各拼一块塞给模型：关键词召回（memory.mjs searchRelated）先拼，
 * 向量召回（memory-vector.mjs searchMemories）后拼，谁先拼谁占位置，互相盖。
 * 现在改成：两路各排自己的序，用 RRF（Reciprocal Rank Fusion）融合成一个名单，
 * 只取前 N 条，由同一个渲染器输出，模型看到的是一份「相关的旧事」。
 *
 * 这样既不需要两套分数可比（关键词分数和余弦相似度量纲不同），也不会因为
 * 某一路排在前面就把另一路挤掉。
 */
import { join } from 'node:path'
import { dateKey } from './memory.mjs'
import { loadMemoryCard, saveMemoryCardOutputs, resolveMemoryCardPaths } from './sc/memory-card.mjs'
import { stateHome, loadConfig } from './store.mjs'

const K_DEFAULT = 60
const LIMIT_DEFAULT = 6
// 召回反馈：先在内存里攒着，攒够条数 / 隔够时间才落盘一次（记忆卡 JSON 不小，不能每条消息都写）。
const RECALL_FLUSH_MS = 5 * 60 * 1000
const RECALL_FLUSH_SIZE = 20
const RECALL_DEDUPE_MS = 5 * 60 * 1000

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:：'"“”‘’（）()【】\[\]…—-]+/g, '')
    .slice(0, 48)
}

function dayOf(item) {
  const t = Number(item && (item.ts || item.at)) || 0
  if (!t) return ''
  return dateKey(t).slice(5)
}

/**
 * RRF 融合。
 * @param {{conv?: any[], sem?: any[], k?: number, limit?: number}} input
 *   conv: searchRelated() 的返回（已按关键词分排序，含 _score / ts / direction / who / text）
 *   sem:  searchMemories() 的返回（已按余弦排序，含 text / score / at）
 * @returns {{items: any[], stats: {conv: number, sem: number, merged: number}}}
 */
export function fuseRecall(input = {}) {
  const conv = Array.isArray(input.conv) ? input.conv : []
  const sem = Array.isArray(input.sem) ? input.sem : []
  const k = Number(input.k) > 0 ? Number(input.k) : K_DEFAULT
  const limit = Number(input.limit) > 0 ? Number(input.limit) : LIMIT_DEFAULT

  const acc = new Map()
  const put = (list, src) => {
    list.forEach((raw, i) => {
      if (!raw) return
      const text = String(raw.text || '').trim()
      if (text.length < 2) return
      const key = normKey(text)
      if (!key) return
      const rrf = 1 / (k + i + 1)
      // 来源标识：记忆卡条目带的 id 直接用；聊天原文退化成 messageId；都没有就用文本 key 对齐。
      const id = String(raw.id || raw.memoryId || raw.messageId || '')
      const hit = acc.get(key)
      if (hit) {
        hit.rrf += rrf
        if (!hit.srcs.includes(src)) hit.srcs.push(src)
        if (!hit.id && id) hit.id = id
        // 两路都命中：取更长的那份文本（信息更全）
        if (text.length > String(hit.text || '').length) hit.text = text
        return
      }
      acc.set(key, {
        key,
        id,
        srcs: [src],
        rrf,
        text,
        ts: Number(raw.ts || raw.at) || 0,
        direction: raw.direction || '',
        who: raw.who || '',
      })
    })
  }
  put(conv, 'conv')
  put(sem, 'mem')

  const items = [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf || b.ts - a.ts)
    .slice(0, limit)
  return { items, stats: { conv: conv.length, sem: sem.length, merged: items.length } }
}

/** 把融合后的名单渲染成 prompt 片段（空则返回 ''） */
export function renderRecall(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) return ''
  const maxLen = Number(opts.maxLen) > 0 ? Number(opts.maxLen) : 110
  return items
    .map((it) => {
      const t = String(it.text || '').replace(/\s+/g, ' ').slice(0, maxLen)
      const d = dayOf(it)
      const stamp = d ? `[${d}] ` : ''
      // 对话原文标出谁说的；记忆卡条目只标「她记得」
      if (it.srcs.includes('conv') && it.direction) {
        const who = it.direction === 'out' ? '你' : (it.who || '对方')
        return `  · ${stamp}${who}：${t}`
      }
      return `  · ${stamp}（她记得）${t}`
    })
    .join('\n')
}

/** 给日志用的一句话统计 */
export function recallDebug(stats, extra = '') {
  const s = stats || {}
  return `记忆召回(RRF): 关键词 ${s.conv || 0} 条 · 向量 ${s.sem || 0} 条 · 融合取 ${s.merged || 0} 条${extra ? ' · ' + extra : ''}`
}

// ── 召回反馈闭环 ──────────────────────────────────────────────────────────
// 记忆卡原来只认「消息里又提到了」才算复习；被检索命中、真正送进 prompt 的那一次
// 不记账，于是「常被想起的记忆」不会变清晰。这一节补上这条回路：
//   fuseRecall 的每条命中带 id（或文本前 48 字的 key）→ 引擎调 markRecalled(ids)
//   → 攒够 20 个不同 id 或隔了 5 分钟，一次性写回记忆卡（recallCount +1 / recalledAt）。
// 写盘只走 memory-card.mjs 现成的 load / save，本文件不自己碰文件。

let recallPending = new Map()
let recallCounted = new Map()
let recallLastFlushAt = 0

function memoryCardConfig() {
  try {
    const cfg = loadConfig()
    return (cfg && cfg.memoryCard) || {}
  } catch {
    return {}
  }
}

/** 命中项 → 对齐 token：优先记忆卡 id，退化成「文本前 48 字」的 normKey。 */
function recallToken(value) {
  if (!value) return ''
  if (typeof value === 'object') {
    const id = String(value.id || value.memoryId || '')
    if (id) return id
    return normKey(value.text || value.key || '')
  }
  return String(value)
}

/**
 * 记一次召回（命中即复习）。
 * 只做内存累积 + 去重；满足「距上次落盘 ≥ 5 分钟」或「攒够 20 个不同 id」才真正写盘。
 * @returns {{ok:boolean, flushed:boolean, tokens:number, pending:number, updated?:number, ids?:string[], error?:string}}
 */
export function markRecalled(ids, now = Date.now()) {
  const at = Number(now) > 0 ? Number(now) : Date.now()
  const list = Array.isArray(ids) ? ids : [ids]
  let fresh = 0
  for (const item of list) {
    const token = recallToken(item)
    if (!token) continue
    const seenAt = recallCounted.get(token)
    if (seenAt && at - seenAt < RECALL_DEDUPE_MS) continue
    if (recallPending.has(token)) continue
    recallPending.set(token, at)
    fresh += 1
  }
  const due = recallPending.size >= RECALL_FLUSH_SIZE || recallLastFlushAt === 0 || at - recallLastFlushAt >= RECALL_FLUSH_MS
  if (due) {
    const res = flushRecalled(at)
    return { ...res, tokens: fresh }
  }
  return { ok: true, flushed: false, tokens: fresh, pending: recallPending.size }
}

/** 强制把攒着的召回落盘（维护 / 退出前用），返回本次真正更新的条数。 */
export function flushRecalled(now = Date.now()) {
  const at = Number(now) > 0 ? Number(now) : Date.now()
  const tokens = [...recallPending.keys()]
  if (!tokens.length) {
    recallLastFlushAt = at
    return { ok: true, flushed: false, tokens: 0, updated: 0, ids: [], pending: 0 }
  }
  let paths = null
  try {
    paths = resolveMemoryCardPaths(join(stateHome(), 'memory'))
  } catch (err) {
    return { ok: false, flushed: false, tokens: tokens.length, updated: 0, ids: [], pending: recallPending.size, error: String((err && err.message) || err) }
  }
  const card = loadMemoryCard(paths)
  if (!card) {
    return { ok: false, flushed: false, tokens: tokens.length, updated: 0, ids: [], pending: recallPending.size, error: '记忆卡读不到' }
  }
  // id 对 id；文本按 normKey 对齐（和 fuseRecall 的去重口径一致：标题:正文 与 标题正文 视为同一条）。
  const byId = new Map()
  const byKey = new Map()
  for (const record of card.records) {
    byId.set(String(record.id), record)
    const keys = [normKey(record.text), normKey(record.title), normKey(`${record.title ? record.title + '：' : ''}${record.text}`)]
    for (const key of keys) {
      if (key && !byKey.has(key)) byKey.set(key, record)
    }
  }
  const stamp = new Date(at).toISOString()
  const hit = new Set()
  for (const token of tokens) {
    const record = byId.get(token) || byKey.get(normKey(token)) || byKey.get(token)
    if (!record || hit.has(record.id)) continue
    hit.add(record.id)
    record.recallCount = Math.min(999, (Number(record.recallCount) || 0) + 1)
    record.recalledAt = stamp
  }
  const ids = [...hit]
  if (ids.length) {
    card.updatedAt = stamp
    try {
      saveMemoryCardOutputs(paths, card, memoryCardConfig(), at)
    } catch (err) {
      return { ok: false, flushed: false, tokens: tokens.length, updated: 0, ids, pending: recallPending.size, error: String((err && err.message) || err) }
    }
  }
  for (const token of tokens) recallCounted.set(token, at)
  if (recallCounted.size > 5000) recallCounted = new Map()
  recallPending = new Map()
  recallLastFlushAt = at
  return { ok: true, flushed: ids.length > 0, tokens: tokens.length, updated: ids.length, ids, pending: 0 }
}

