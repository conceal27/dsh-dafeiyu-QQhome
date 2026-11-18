/**
 * lib/memory.mjs — 长期记忆 / 跨天上下文（追加模块，不改原文件结构）
 * ============================================================================
 * 目标：让她「记得几天前说过的话」，而不是只看最近 N 条。
 * 做法：
 *   1) 关键词提取（中文 2-gram + 英文词），从当前消息里抽意图词
 *   2) 历史检索：在本地 messages.jsonl 里按关键词打分，捞出最相关的旧对话
 *   3) 每日摘要：按天把长对话压成几句（懒生成，第一次需要时才算）
 * 注意：不是把全部记录塞进 prompt（token 会爆），而是「最近完整 + 相关召回」。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function stateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-fish')
}
function notesPath() {
  return join(stateDir(), 'daily-notes.json')
}

/** 中文停用词（避免无关词主导检索） */
const STOP = new Set([
  '什么','怎么','这个','那个','一个','我们','你们','他们','它们','就是','不是','可以','没有','知道',
  '现在','然后','因为','所以','但是','如果','还是','真的','觉得','应该','已经','一直','这样','那样',
  '自己','时候','东西','事情','地方','问题','感觉','可能','要不','是不','是有','我就','你就','他就',
  '她说','我说','说是','有点','有些','而且','不过','其实','反正','好像','估计','大概','一下','一点',
  '你还','还记','记得','得我','我昨','昨天','天说','说的','的那','串的','我看','看到','到了','了个',
  '能不','不能','什么','么事','事情','后来','怎么','么样','你还','还知','知道','道的',
])

/** 从一条消息里抽关键词（中文 2-gram + 英文/数字词），去停用词 */
export function extractKeywords(text, max = 24) {
  const raw = String(text || '')
  const words = new Set()
  // 英文/数字
  for (const w of raw.split(/[^A-Za-z0-9]+/)) {
    const s = w.trim().toLowerCase()
    if (s.length >= 3 && s.length <= 20) words.add(s)
  }
  // 中文 2-gram / 3-gram
  const cn = raw.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i < cn.length - 1; i++) {
    const g2 = cn.slice(i, i + 2)
    if (!STOP.has(g2)) words.add(g2)
  }
  for (let i = 0; i < cn.length - 2; i++) {
    const g3 = cn.slice(i, i + 3)
    if (!STOP.has(g3)) words.add(g3)
  }
  return [...words].slice(0, max)
}

/**
 * 在某个会话的历史里检索与 keywords 相关的消息。
 * @param {Array} rows 全量消息（recentMessages 的返回）
 * @param {string} conversation 会话 key
 * @param {string[]} keywords
 * @param {object} opts { limit, excludeTs:Set, minScore }
 * @returns {Array} 命中的消息（按分数降序，带 _score）
 */
export function searchRelated(rows, conversation, keywords, opts = {}) {
  const limit = Math.max(1, Math.min(30, Number(opts.limit) || 8))
  const minScore = Number(opts.minScore) || 2
  const exclude = opts.excludeTs instanceof Set ? opts.excludeTs : new Set(opts.excludeTs || [])
  if (!keywords || !keywords.length) return []
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
  const scored = []
  for (const m of rows) {
    if (!m || m.conversation !== conversation) continue
    if (exclude.has(String(m.ts))) continue
    const text = String(m.text || '').toLowerCase()
    if (!text || text.length < 2) continue
    let score = 0
    let hitLong = 0
    for (const k of kws) {
      if (k.length >= 3) {
        if (text.includes(k)) { score += 5; hitLong += 1 }
      } else if (text.includes(k)) {
        score += 2
      }
    }
    // 至少命中一个 >=3 字的词，或总分够高，才算相关（防噪音）
    if (hitLong === 0 && score < minScore) continue
    scored.push({ m, score })
  }
  scored.sort((a, b) => b.score - a.score || b.m.ts - a.m.ts)
  return scored.slice(0, limit).map((x) => ({ ...x.m, _score: x.score }))
}

/** 读取每日摘要库 */
export function loadNotes() {
  try {
    if (!existsSync(notesPath())) return {}
    const j = JSON.parse(readFileSync(notesPath(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** 写入某会话某天的摘要 */
export function saveNote(conversation, date, note) {
  const all = loadNotes()
  if (!all[conversation]) all[conversation] = {}
  all[conversation][date] = {
    text: String(note.text || '').slice(0, 800),
    msgCount: Number(note.msgCount) || 0,
    updatedAt: Date.now(),
  }
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(notesPath(), JSON.stringify(all, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 把 ts 转成本地日期 YYYY-MM-DD */
export function dateKey(ts) {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 取某会话最近 N 天的摘要（按时间倒序） */
export function recentNotes(conversation, days = 5) {
  const all = loadNotes()[conversation] || {}
  const today = dateKey(Date.now())
  const keys = Object.keys(all).filter((k) => k < today).sort().reverse().slice(0, days)
  return keys.map((k) => ({ date: k, ...all[k] }))
}

/**
 * 把「相关历史」渲染成 prompt 片段。
 * @returns {string} 空串表示没有
 */
export function renderRelated(related) {
  if (!Array.isArray(related) || !related.length) return ''
  const lines = related.map((m) => {
    const who = m.direction === 'out' ? '你' : (m.who || '对方')
    const t = String(m.text || '').replace(/\s+/g, ' ').slice(0, 120)
    const d = dateKey(m.ts).slice(5)
    return `  · [${d}] ${who}：${t}`
  })
  return lines.join('\n')
}

/** 把「每日摘要」渲染成 prompt 片段 */
export function renderNotes(notes) {
  if (!Array.isArray(notes) || !notes.length) return ''
  return notes
    .map((n) => `  · ${n.date}：${String(n.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n')
}
