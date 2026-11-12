/**
 * lib/life.mjs — 她的人生：时间线 + 里程碑
 * ============================================================================
 * 从聊天记录里自动提取「第一次」和重要节点，存成一条能被回顾的线。
 * 纯规则扫描（不调模型），每天最多跑一次。
 * 数据：qq-fish/life.json
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recentMessages, stateHome } from './store.mjs'

const FILE = join(stateHome(), 'life.json')

const DEFAULTS = {
  startedAt: '',
  milestones: [], // { id, at, title, detail, kind }
  lastScanDate: '',
}

let cache = null
let cacheAt = 0

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function loadLife() {
  const now = Date.now()
  if (cache && now - cacheAt < 60_000) return cache
  let raw = null
  try { raw = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
  const v = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(v.milestones)) v.milestones = []
  // 第一次运行：把「认识的起点」定成最早那条消息
  if (!v.startedAt) {
    try {
      const all = recentMessages(2000)
      const first = all.find((m) => m && m.ts)
      v.startedAt = first ? new Date(first.ts).toISOString().slice(0, 10) : todayStr()
      await save(v)
    } catch {
      v.startedAt = todayStr()
    }
  }
  cache = v
  cacheAt = now
  return v
}

async function save(v) {
  cache = v
  cacheAt = Date.now()
  try { await writeFile(FILE, JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
  return v
}

function has(v, title) {
  return v.milestones.some((m) => m.title === title)
}

function push(v, at, title, detail, kind = 'first') {
  if (has(v, title)) return false
  v.milestones.push({
    id: 'm' + at.toString(36) + Math.random().toString(36).slice(2, 5),
    at,
    title,
    detail: String(detail || '').slice(0, 160),
    kind,
  })
  return true
}

/** 从消息里找值得记一笔的「第一次」。纯规则。 */
export async function scanMilestones() {
  const v = await loadLife()
  const today = todayStr()
  if (v.lastScanDate === today) return { added: 0 }
  let added = 0
  try {
    const all = (recentMessages(2000) || []).filter((m) => m && m.ts)
    if (!all.length) {
      v.lastScanDate = today
      await save(v)
      return { added: 0 }
    }
    const firstIn = all.find((m) => m.direction === 'in')
    const firstOut = all.find((m) => m.direction === 'out')
    if (firstIn && push(v, firstIn.ts, '第一次说话', String(firstIn.text || '').slice(0, 80), 'first')) added++
    if (firstOut && push(v, firstOut.ts, '她第一次开口', String(firstOut.text || '').slice(0, 80), 'first')) added++

    // 特殊事件：语音 / 群聊 / 生气 / 说想他
    const voice = all.find((m) => /\[语音\]/.test(String(m.text || '')))
    if (voice && push(v, voice.ts, '第一次发语音', String(voice.text || '').replace('[语音]', '').trim().slice(0, 80), 'event')) added++
    const group = all.find((m) => m.channel === 'group')
    if (group && push(v, group.ts, '第一次在群里说话', String(group.text || '').slice(0, 80), 'event')) added++
    const angry = all.find((m) => m.direction === 'out' && /(滚|闭嘴|烦死|别烦|傻|蠢|骂)/.test(String(m.text || '')))
    if (angry && push(v, angry.ts, '第一次凶人', String(angry.text || '').slice(0, 80), 'event')) added++
    const miss = all.find((m) => m.direction === 'out' && /(想你|想我|别走|等我)/.test(String(m.text || '')))
    if (miss && push(v, miss.ts, '第一次说想你', String(miss.text || '').slice(0, 80), 'event')) added++

    // 认识 N 天
    if (v.startedAt) {
      const days = Math.floor((Date.now() - new Date(v.startedAt + 'T00:00:00').getTime()) / 86400000)
      for (const n of [7, 30, 100, 365]) {
        if (days >= n) {
          if (push(v, Date.now(), `认识第 ${n} 天`, `从 ${v.startedAt} 算起`, 'anniversary')) added++
        }
      }
    }
  } catch (e) {
    // 扫描失败不影响主流程
  }
  v.lastScanDate = today
  await save(v)
  return { added }
}

/** 注入：她记得自己活了多久 */
export async function lifePromptBlock() {
  const v = await loadLife()
  if (!v.startedAt) return ''
  const days = Math.max(1, Math.floor((Date.now() - new Date(v.startedAt + 'T00:00:00').getTime()) / 86400000) + 1)
  const parts = [`【你活了 ${days} 天】你和主人是从 ${v.startedAt} 开始说话的，今天是第 ${days} 天。`]
  const recent = v.milestones.slice(-3)
  if (recent.length) {
    const lines = recent.map((m) => `- ${new Date(m.at).toISOString().slice(0, 10)} ${m.title}${m.detail ? '：' + m.detail : ''}`)
    parts.push('你记得的大事：\n' + lines.join('\n'))
  }
  parts.push('（这些是你自己的记忆，不用每条都提；聊到相关的时候可以自然带出来。）')
  return parts.join('\n')
}

export async function lifeSnapshot() {
  const v = await loadLife()
  const days = v.startedAt ? Math.max(1, Math.floor((Date.now() - new Date(v.startedAt + 'T00:00:00').getTime()) / 86400000) + 1) : 0
  return { startedAt: v.startedAt || '', days, milestones: v.milestones.slice(-30).reverse(), lastScanDate: v.lastScanDate || '' }
}

export async function addMilestone(title, detail = '') {
  const v = await loadLife()
  push(v, Date.now(), String(title || '').slice(0, 40), String(detail || '').slice(0, 160), 'manual')
  await save(v)
  return lifeSnapshot()
}
