/**
 * lib/notes.mjs — 她自己的笔记本（对齐 AstrBot astrbot_plugin_notes）
 * ============================================================================
 * 存的是一篇一篇的「笔记」，不是聊天记忆：课题任务清单、活动信息、查到的资料。
 * 文件：$DSH_HOME/qq-fish/notes/notes.jsonl（一行一篇，追加写，坏了也只坏一行）
 *
 * 用法（模型侧）：
 *   [skill:note 写 标题|正文]
 *   [skill:note 查 关键词]
 *   [skill:note 列]
 *   [skill:note 改 id前缀|新正文]
 * ============================================================================
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const DIR = 'notes'
const FILE = 'notes.jsonl'

export function notesDir(home) { return join(home, DIR) }
export function notesPath(home) { return join(notesDir(home), FILE) }

function ensure(home) {
  try { mkdirSync(notesDir(home), { recursive: true }) } catch {}
}

export function loadNotes(home) {
  const out = []
  try {
    const raw = readFileSync(notesPath(home), 'utf8')
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try { out.push(JSON.parse(s)) } catch {}
    }
  } catch {}
  return out
}

function saveAll(home, notes) {
  ensure(home)
  writeFileSync(notesPath(home), notes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8')
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

export function writeNote(home, { title, body, source = '', tags = [] } = {}) {
  const t = clip(title, 80)
  const b = String(body || '').trim()
  if (!t && !b) return { ok: false, error: '标题和正文都是空的' }
  const now = Date.now()
  const note = {
    id: createHash('sha1').update(t + '|' + b + '|' + now).digest('hex').slice(0, 12),
    title: t || clip(b, 40),
    body: b,
    source: clip(source, 120),
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    createdAt: now,
    updatedAt: now,
    hits: 0,
  }
  ensure(home)
  appendFileSync(notesPath(home), JSON.stringify(note) + '\n', 'utf8')
  return { ok: true, note }
}

export function searchNotes(home, kw, limit = 5) {
  const q = String(kw || '').trim()
  const all = loadNotes(home)
  const hit = q
    ? all.filter((n) => (n.title + '\n' + n.body + '\n' + (n.tags || []).join(',')).includes(q))
    : all.slice(-limit)
  return hit.slice(-limit).reverse()
}

export function getNote(home, idPrefix) {
  const p = String(idPrefix || '').trim()
  if (!p) return null
  return loadNotes(home).find((n) => String(n.id).startsWith(p)) || null
}

export function updateNote(home, idPrefix, body) {
  const all = loadNotes(home)
  const i = all.findIndex((n) => String(n.id).startsWith(String(idPrefix || '').trim()))
  if (i < 0) return { ok: false, error: '没找到这篇笔记：' + idPrefix }
  all[i] = { ...all[i], body: String(body || ''), updatedAt: Date.now() }
  saveAll(home, all)
  return { ok: true, note: all[i] }
}

export function notesPromptBlock(home, config = {}) {
  const list = loadNotes(home)
  if (!list.length) return ''
  const lines = list.slice(-6).map((n) => '- [' + n.id.slice(0, 6) + '] ' + clip(n.title, 40))
  return '【你的笔记本】\n' + lines.join('\n') + '\n（要翻全文用 [skill:notes 关键词]，想记新东西用 [skill:note 标题|正文]）'
}

export function notesStats(home) {
  const all = loadNotes(home)
  return { count: all.length, lastAt: all.length ? all[all.length - 1].updatedAt : 0 }
}
