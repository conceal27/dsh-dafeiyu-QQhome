/**
 * lib/memory-decay.mjs — 记忆衰减（移植自 SurfCore 的 memory-card.js）
 * ============================================================================
 * 能力：
 *   · 摄取：把 QQ 聊天记录转成记忆条目（会去重，同一条只记一次）
 *   · 衰减：每天递减清晰度 vivid → clear → fuzzy → trace → forgotten
 *   · 注入：把「还清晰」的记忆渲染成 prompt 块
 *   · 容量：80/90/100% 告警，超 100% 自动压缩
 * 存储：$DSH_HOME/qq-fish/memory/
 * ============================================================================
 */
import { join } from 'node:path'
import {
  resolveMemoryCardPaths,
  loadMemoryCard,
  createEmptyCard,
  maintainMemoryCard,
  readPromptBlock,
  memoryCardStatus,
  addManualMemory,
  saveMemoryCardOutputs,
} from './sc/memory-card.mjs'
import { recentMessages, stateHome } from './store.mjs'

export function memoryDir() {
  return join(stateHome(), 'memory')
}
export function memoryPaths() {
  return resolveMemoryCardPaths(memoryDir())
}

/** 把最近聊天记录转成 inbox 行（JSON 字符串数组），供摄取使用 */
function buildInboxLines(limit = 200) {
  const rows = recentMessages(Math.max(50, limit))
  const out = []
  for (const m of rows) {
    if (!m || !m.text) continue
    const text = String(m.text).trim()
    if (!text) continue
    // 纯占位符没有记忆价值
    // 纯占位符
    if (/^\[(图片|表情|视频|语音|文件|卡片消息|聊天记录)\]$/.test(text)) continue
    if (/^\[sticker:[^\]]*\]$/.test(text)) continue
    // 纯 @（@123456 或 @123456 空格）
    if (/^@\d+\s*$/.test(text)) continue
    // 含 base64 / data URI（图片转存痕迹）
    if (/base64:\/\//i.test(text)) continue
    if (/data:image\//i.test(text)) continue
    // 太短（1 个字没记忆价值）
    if (text.length < 2) continue
    // 反复刷屏的单字/表情
    if (/^[?？!！.。~～]+$/.test(text)) continue
    const conv = String(m.conversation || '')
    const isPrivate = conv.startsWith('private:')
    out.push(JSON.stringify({
      at: Number(m.ts) || Date.now(),
      text: text.slice(0, 400),
      senderId: m.direction === 'out' ? 'self' : String(m.uin || ''),
      isOwner: false,
      private: isPrivate,
      kind: isPrivate ? 'private' : 'group',
      direct: false,
      conversationKey: conv,
      platform: 'qq',
      isSelf: m.direction === 'out',
    }))
  }
  return out
}

/** 一次维护：摄取 + 衰减 + 压缩 + 写盘。返回统计。 */
export function maintain(now = Date.now(), { limit = 200, forceDecay = false, config = {} } = {}) {
  const paths = memoryPaths()
  const lines = buildInboxLines(limit)
  const memCfg = (config && config.memoryCard) || config || {}
  const result = maintainMemoryCard({ paths, config: memCfg, inboxLines: lines, now, forceDecay })
  return result
}

/** 读注入块（给 systemPrompt 用） */
export function promptBlock() {
  try {
    return readPromptBlock(memoryPaths(), 'qq')
  } catch {
    return ''
  }
}

/** 记忆卡状态（容量、清晰度分布） */
export function status(now = Date.now(), config = {}) {
  const paths = memoryPaths()
  const card = loadMemoryCard(paths) || createEmptyCard(now)
  const memCfg = (config && config.memoryCard) || config || {}
  return memoryCardStatus(card, memCfg, now)
}

/** 手动加一条记忆 */
export function addMemory(text, { importance = 70, scope = 'qq', config = {} } = {}, now = Date.now()) {
  const paths = memoryPaths()
  const card = loadMemoryCard(paths) || createEmptyCard(now)
  const memCfg = (config && config.memoryCard) || config || {}
  addManualMemory(card, { text: String(text || '').slice(0, 500), importance, scope }, memCfg, now)
  saveMemoryCardOutputs(paths, card, memCfg, now)
  return status(now, config)
}
