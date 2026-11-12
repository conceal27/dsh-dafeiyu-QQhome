/**
 * lib/cross-search.mjs — 跨群原文检索（隐私安全）
 * ============================================================================
 * 目的：她要能翻出「同一个人在别的群说过的话」的【原文】，而不只是摘要。
 *
 * 隐私边界（写死）：
 *   · 只读【当前说话这个人】发的消息（sender.user_id === userId）
 *   · 其他人的消息一律丢弃，不进 prompt、不记录
 *   · 只在以下情况触发：用户在问「我说过什么 / 找一下 / 记不记得」这类
 *   · 单次最多查 3 个群、每群 40 条，避免拖慢回复
 * ============================================================================
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function auditPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'qq-fish')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return join(dir, 'cross-search-audit.jsonl')
}

/** 审计：每次检索记一笔（时间/目标/群/命中数），便于回溯 */
export function appendAudit(entry) {
  try {
    appendFileSync(auditPath(), JSON.stringify({
      at: Date.now(),
      userId: String(entry.userId || ''),
      groups: Array.isArray(entry.groups) ? entry.groups : [],
      hits: Number(entry.hits) || 0,
      keywords: Array.isArray(entry.keywords) ? entry.keywords.slice(0, 12) : [],
      reason: String(entry.reason || ''),
    }) + String.fromCharCode(10), 'utf8')
  } catch {}
}

/** 读最近 N 条审计 */
export function readAudit(limit = 50) {
  try {
    const p = auditPath()
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse().map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 群列表缓存（5 分钟） */
let groupCache = { at: 0, list: [] }

export async function listGroups(bridge, { force = false } = {}) {
  const now = Date.now()
  if (!force && groupCache.list.length && now - groupCache.at < 5 * 60 * 1000) {
    return groupCache.list
  }
  try {
    const resp = await bridge.call('get_group_list', {})
    // call 已经解包过一次：可能是直接数组，也可能还包着 data
    const list = Array.isArray(resp) ? resp : (Array.isArray(resp && resp.data) ? resp.data : [])
    groupCache = { at: now, list }
    return list
  } catch {
    return groupCache.list
  }
}

/** 把 OneBot 段数组转成纯文本（只取 text，图片转占位） */
function segmentsToText(segs) {
  if (!Array.isArray(segs)) return ''
  const out = []
  for (const s of segs) {
    if (!s || !s.type) continue
    if (s.type === 'text') out.push(String((s.data && s.data.text) || ''))
    else if (s.type === 'image') out.push('[图片]')
    else if (s.type === 'at') out.push('@' + String((s.data && s.data.qq) || ''))
    else if (s.type === 'face') out.push('[表情]')
  }
  return out.join('').replace(/\s+/g, ' ').trim()
}

/**
 * 在多个群里搜「同一个人」说过的原文。
 * @param {object} bridge OneBotClient（有 call）
 * @param {string} userId 目标 QQ（只查他本人的消息）
 * @param {object} opts { keywords, limitPerGroup, maxGroups, excludeGroupId }
 * @returns {Promise<Array<{groupName, at, text, score}>>}
 */
export async function searchAcrossGroups(bridge, userId, opts = {}) {
  const uid = String(userId || '').trim()
  if (!uid) return []
  const limitPerGroup = Math.max(10, Math.min(80, Number(opts.limitPerGroup) || 40))
  const maxGroups = Math.max(1, Math.min(6, Number(opts.maxGroups) || 3))
  const exclude = String(opts.excludeGroupId || '')
  const kws = Array.isArray(opts.keywords) ? opts.keywords.filter((k) => String(k).length >= 2) : []

  const groups = await listGroups(bridge)
  // 白名单：只查允许的群（空 = 全部允许）
  const allowRaw = String(opts.allowGroups || '').trim()
  const allowSet = new Set(allowRaw ? allowRaw.split(/[,，\s]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean) : [])
  const targets = groups
    .filter((g) => String(g.group_id) !== exclude)
    .filter((g) => !allowSet.size || allowSet.has(String(g.group_id)))
    .slice(0, maxGroups)
  const hits = []
  for (const g of targets) {
    const gid = Number(g.group_id)
    const gname = String(g.group_name || gid)
    try {
      const resp = await bridge.call('get_group_msg_history', { group_id: gid, count: limitPerGroup })
      const msgs = (resp && resp.messages) || (resp && resp.data && resp.data.messages) || (Array.isArray(resp) ? resp : [])
      for (const m of msgs) {
        const sender = m && m.sender && typeof m.sender === 'object' ? String(m.sender.user_id || '') : ''
        // 【隐私】只保留这个人本人发的
        if (sender !== uid) continue
        const text = segmentsToText(m.message)
        if (!text || text.length < 2) continue
        const at = Number(m.time ? m.time * 1000 : 0) || 0
        let score = 0
        for (const k of kws) if (text.includes(k)) score += 1
        hits.push({ groupName: gname, groupId: gid, at, text, score })
      }
    } catch {
      // 单个群失败不影响其他群
    }
  }
  // 有关键词命中就优先，否则按时间倒序
  const anyHit = hits.some((h) => h.score > 0)
  hits.sort((a, b) => (anyHit ? b.score - a.score : 0) || b.at - a.at)
  return hits
}

/** 渲染成 prompt 片段（只含这个人自己的原文） */
export function renderCrossHits(hits, limit = 6) {
  if (!Array.isArray(hits) || !hits.length) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const lines = hits.slice(0, limit).map((h) => {
    const d = new Date(h.at || Date.now())
    return `- ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}【${h.groupName}】${h.text.slice(0, 160)}`
  })
  return lines.join('\n')
}

/** 判断这条消息是不是在问「我在别的群说过什么」 */
export function wantsCrossSearch(text) {
  const s = String(text || '')
  if (!s) return false
  return /(我说过|我说了什么|找一下|找找|搜一下|有没有说过|记不记得我说|别的群|其他群|跨群|群里说过)/.test(s)
}
