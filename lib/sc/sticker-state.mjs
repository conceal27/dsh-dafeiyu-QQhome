/**
 * lib/sc/sticker-state.mjs — 表情包发送状态（参考 ohwhale 的挑图策略）
 * ============================================================================
 * 解决「连着甩同一张图」「刷屏」「半夜也发」这些不像真人的问题。
 *
 * 规则（可面板调）：
 *   · 冷却：两次发表情包至少隔 N 秒（默认 45）
 *   · 每日上限：每天最多发 N 张（默认 25）
 *   · 去重：最近 N 张用过的图不再用（默认 6）
 *
 * 存储：$DSH_HOME/qq-fish/sticker-state.json
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

export const STICKER_STATE_VERSION = 1

export function stickerStatePath(stateHome) {
  return path.join(stateHome, 'sticker-state.json')
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function createEmptyState(now = Date.now()) {
  return { version: STICKER_STATE_VERSION, date: todayKey(now), count: 0, recent: [], lastTs: 0 }
}

export function loadStickerState(diskPath, now = Date.now()) {
  try {
    if (!fs.existsSync(diskPath)) return createEmptyState(now)
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    const state = {
      version: STICKER_STATE_VERSION,
      date: String((raw && raw.date) || todayKey(now)),
      count: Number((raw && raw.count) || 0),
      recent: Array.isArray(raw && raw.recent) ? raw.recent.filter(Boolean).slice(-20) : [],
      lastTs: Number((raw && raw.lastTs) || 0),
    }
    // 跨天自动重置
    if (state.date !== todayKey(now)) return createEmptyState(now)
    return state
  } catch {
    return createEmptyState(now)
  }
}

export function saveStickerState(diskPath, state) {
  try {
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const tmp = diskPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, diskPath)
  } catch {}
}

/**
 * 现在能不能发。
 * @returns {{ok: boolean, reason?: string}}
 */
export function canSendSticker(state, now, opts = {}) {
  const cooldownMs = Math.max(0, Number(opts.cooldownSec != null ? opts.cooldownSec : 45)) * 1000
  const maxPerDay = Math.max(1, Number(opts.maxPerDay != null ? opts.maxPerDay : 25))
  if (now - Number(state.lastTs || 0) < cooldownMs) {
    return { ok: false, reason: '冷却中（' + Math.ceil((cooldownMs - (now - state.lastTs)) / 1000) + ' 秒）' }
  }
  if (Number(state.count || 0) >= maxPerDay) {
    return { ok: false, reason: '今天额度用完了（' + maxPerDay + ' 张）' }
  }
  return { ok: true }
}

/** 从候选池里剔掉最近用过的 */
export function filterRecent(pool, state, keep = 6) {
  const recent = new Set((state.recent || []).slice(-keep))
  const fresh = pool.filter((x) => !recent.has(String(x.file || x.id || '')))
  return fresh.length ? fresh : pool
}

/** 发完记一笔 */
export function recordStickerSend(state, fileOrId, now = Date.now(), keep = 6) {
  const next = {
    ...state,
    date: todayKey(now),
    count: Number(state.count || 0) + 1,
    lastTs: now,
    recent: [...(state.recent || []), String(fileOrId || '')].filter(Boolean).slice(-Math.max(1, keep)),
  }
  return next
}

/** 给面板的状态摘要 */
export function stickerStateSummary(state, opts = {}) {
  const cooldownSec = Math.max(0, Number(opts.cooldownSec != null ? opts.cooldownSec : 45))
  const maxPerDay = Math.max(1, Number(opts.maxPerDay != null ? opts.maxPerDay : 25))
  const now = Date.now()
  const cdLeft = Math.max(0, Math.ceil((cooldownSec * 1000 - (now - Number(state.lastTs || 0))) / 1000))
  return {
    date: state.date,
    count: Number(state.count || 0),
    maxPerDay,
    cooldownLeftSec: cdLeft,
    recentCount: (state.recent || []).length,
    canSend: cdLeft === 0 && Number(state.count || 0) < maxPerDay,
  }
}
