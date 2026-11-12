/**
 * lib/social.mjs — 社交状态：分寸长在她自己身上
 * ============================================================================
 * 不用「每小时最多 4 条」「间隔 90 分钟」这种外部围栏去裁剪她的行为，
 * 而是让她记得：我上次主动找你、你回没回、我是不是烦到你了。
 *
 * 于是「少说」不是被拦下的，是她自己不想说：
 *   - 连发几条你都没回 → 她会觉得没意思，慢慢安静，最后赌气
 *   - 你回了 → 她高兴，下次更敢找你
 *   - 她自己在赌气时，就算真有想说的也憋着（这才是人）
 *
 * 数据：qq-fish/social.json
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const FILE = join(stateHome(), 'social.json')

const DEFAULTS = {
  lastProactiveAt: 0,
  lastProactiveText: '',
  noReplyStreak: 0, // 连续几次主动之后你都没回
  repliedAfterProactive: 0, // 主动之后你回了几次
  lastReplyAt: 0,
  sulkUntil: 0, // 赌气到什么时候
  sulkReason: '',
  totalProactive: 0,
  totalReplied: 0,
}

let cache = null
let cacheAt = 0

export async function loadSocial() {
  const now = Date.now()
  if (cache && now - cacheAt < 20_000) return cache
  let raw = null
  try { raw = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
  cache = { ...DEFAULTS, ...(raw || {}) }
  cacheAt = now
  return cache
}

async function save(v) {
  cache = v
  cacheAt = Date.now()
  try { await writeFile(FILE, JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
  return v
}

/** 她主动发了一条 */
export async function recordProactive(text = '') {
  const v = await loadSocial()
  v.lastProactiveAt = Date.now()
  v.lastProactiveText = String(text || '').slice(0, 120)
  v.totalProactive = (Number(v.totalProactive) || 0) + 1
  // 上一轮如果还没被回，这次又发了 → 未回计数 +1
  v.noReplyStreak = (Number(v.noReplyStreak) || 0) + 1
  // 连发 4 条都没回：开始赌气（6 小时），这是「活」的一部分
  if (v.noReplyStreak >= 4 && !v.sulkUntil) {
    v.sulkUntil = Date.now() + 6 * 3600 * 1000
    v.sulkReason = `我主动找了 ${v.noReplyStreak} 次，你一次都没理我`
  }
  return save(v)
}

/** 主人回了（任何一句都算） */
export async function recordOwnerReply() {
  const v = await loadSocial()
  const now = Date.now()
  v.lastReplyAt = now
  // 如果她之前主动过、而且是在等回复的窗口里（2 小时内）
  if (v.lastProactiveAt && now - v.lastProactiveAt < 2 * 3600 * 1000) {
    v.repliedAfterProactive = (Number(v.repliedAfterProactive) || 0) + 1
    v.totalReplied = (Number(v.totalReplied) || 0) + 1
  }
  v.noReplyStreak = 0
  v.sulkUntil = 0
  v.sulkReason = ''
  return save(v)
}

/** 现在是不是在赌气 */
export async function sulkState() {
  const v = await loadSocial()
  if (v.sulkUntil && v.sulkUntil > Date.now()) {
    return { sulking: true, until: v.sulkUntil, reason: v.sulkReason || '', leftMin: Math.round((v.sulkUntil - Date.now()) / 60000) }
  }
  // 过期了顺手清掉
  if (v.sulkUntil) {
    v.sulkUntil = 0
    v.sulkReason = ''
    await save(v)
  }
  return { sulking: false, until: 0, reason: '', leftMin: 0 }
}

/**
 * 社交系数 0~1：直接乘进开口冲动里。
 * 不是硬阈值，是「她现在有多想主动找你」。
 */
export async function socialFactor() {
  const v = await loadSocial()
  const streak = Number(v.noReplyStreak) || 0
  if (streak <= 0) return 1
  if (streak === 1) return 0.85 // 刚发过一条，还在等
  if (streak === 2) return 0.62 // 有点在意了
  if (streak === 3) return 0.35 // 开始觉得自己烦人
  return 0.15 // 快赌气了
}

/** 面板用 */
export async function socialSnapshot() {
  const v = await loadSocial()
  const s = await sulkState()
  return {
    ...v,
    sulking: s.sulking,
    sulkLeftMin: s.leftMin,
    sulkReasonText: s.reason,
    replyRate: v.totalProactive ? Math.round((v.totalReplied / v.totalProactive) * 100) : 0,
  }
}

export async function clearSulk() {
  const v = await loadSocial()
  v.sulkUntil = 0
  v.noReplyStreak = 0
  v.sulkReason = ''
  return save(v)
}
