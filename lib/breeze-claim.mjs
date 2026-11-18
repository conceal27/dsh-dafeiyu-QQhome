import { homedir } from 'node:os'
/**
 * lib/breeze-claim.mjs — BreezeBlue 每日额度自动领取
 * ============================================================================
 * 官方 API 不开放签到，但网页端有：
 *   GET  /api/credits/summary   → daily_claim_available / daily_claim_claimed_today / amount
 *   POST /api/credits/daily-claim [body {reward_tier}]
 * 需要浏览器登录态的 cookie（breeze_blue_session 等），放：
 *   $DSH_HOME/qq-fish/breeze-web-cookie.txt（首选）
 *   $DSH_HOME/qq-fish/breeze-web-cookie.txt（兜底，就是用户贴的那串）
 * 每天 00:00 UTC（北京时间 08:00）重置；领取是幂等的，重复调只会返回已领。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const BASE = 'https://breezeblue.ai'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function cookiePaths() {
  return [
    process.env.BREEZE_WEB_COOKIE_FILE || '',
    join(stateHome(), 'breeze-web-cookie.txt'),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-fish', 'breeze-web-cookie.txt'),
  ].filter(Boolean)
}

export function loadCookie() {
  for (const p of cookiePaths()) {
    try {
      if (!existsSync(p)) continue
      const raw = readFileSync(p, 'utf8')
      const line = raw.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
      if (line) return line
    } catch {}
  }
  return ''
}

function statePath() {
  return join(stateHome(), 'breeze-claim.json')
}

export function readClaimState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return { version: 1, history: [] } }
}

function saveClaimState(st) {
  try {
    st.updatedAt = Date.now()
    st.history = (st.history || []).slice(-60)
    writeFileSync(statePath(), JSON.stringify(st, null, 2) + '\n', 'utf8')
  } catch {}
}

async function call(pathname, { method = 'GET', cookie = '', body = null, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        Cookie: cookie,
        'User-Agent': UA,
        Accept: 'application/json',
        // 2026-11-16 修：POST /api/credits/daily-claim 会校验来源，缺 Origin 直接
        // {"ok":false,"code":"FORBIDDEN","detail":"Request origin is not allowed."}。
        // 网页端是从 https://breezeblue.ai 发的，所以这里把 Origin/Referer 补成同一个源。
        // GET summary 不带也能过，但带上无副作用，统一加省得以后再踩。
        Origin: BASE,
        Referer: BASE + '/',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 300) } }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 读网页端积分摘要（余额 + 今天能不能领） */
export async function creditsSummary({ cookie = '' } = {}) {
  const ck = cookie || loadCookie()
  if (!ck) return { ok: false, error: '没有网页 cookie（breeze-web-cookie.txt）' }
  const r = await call('/api/credits/summary', { cookie: ck })
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 140) }
  const d = r.data || {}
  return {
    ok: true,
    balance: Number(d.balance) || 0,
    available: !!d.daily_claim_available,
    claimedToday: !!d.daily_claim_claimed_today,
    amount: Number(d.daily_claim_amount) || 0,
    standardAmount: Number(d.daily_claim_standard_amount) || 0,
    discordAmount: Number(d.daily_claim_discord_amount) || 0,
    nextResetAt: d.daily_claim_next_reset_at || '',
  }
}

/**
 * 该试哪一档：两档额度差 4 倍，优先高档。
 * 传入 summary（creditsSummary 的结果）判断 discord 档是否比 standard 高；
 * 拿不到 summary 就默认试 discord —— 失败会自动退回默认档，不会丢当天额度。
 */
function pickRewardTier(summary) {
  const s = summary && summary.ok ? summary : null
  const std = s ? Number(s.standardAmount) || 0 : 100
  const dis = s ? Number(s.discordAmount) || 0 : 400
  return dis > std ? 'discord' : ''
}

/** 领今天的额度；已经领过就当成功（幂等） */
export async function claimDaily({ cookie = '', rewardTier = '' } = {}) {
  const ck = cookie || loadCookie()
  if (!ck) return { ok: false, error: '没有网页 cookie（breeze-web-cookie.txt）' }
  const before = await creditsSummary({ cookie: ck }).catch(() => null)
  if (before && before.ok && before.claimedToday) {
    return { ok: true, already: true, balance: before.balance, amount: 0, summary: before }
  }
  // 【档位】服务端有两档：standard=100/天、discord=400/天（2026-11-16 实测：
  // 传 reward_tier=discord 会被接受并回显，未绑 Discord 的号才有可能失败）。
  // 所以默认「先试高档、失败退回默认档」，一个账号一天只能领一次，退档不会吞掉当天额度。
  const tier = String(rewardTier || '').trim() || pickRewardTier(before)
  let r = await call('/api/credits/daily-claim', {
    method: 'POST',
    cookie: ck,
    body: tier ? { reward_tier: tier } : null,
  })
  const triedTier = tier
  if (!r.ok && tier) {
    // 高档没成（没绑 Discord / 不认这个 tier）→ 立刻按默认档再试一次，别白丢一天
    const fallback = await call('/api/credits/daily-claim', { method: 'POST', cookie: ck, body: null })
    if (fallback.ok) {
      r = fallback
    } else {
      r = { ...fallback, tierError: JSON.stringify(r.data).slice(0, 160) }
    }
  }
  const after = await creditsSummary({ cookie: ck }).catch(() => null)
  const st = readClaimState()
  const entry = {
    at: Date.now(),
    ok: r.ok,
    status: r.status,
    tier: triedTier || 'default',
    amount: after && before && after.ok && before.ok ? Math.round((after.balance - before.balance) * 100) / 100 : null,
    balance: after && after.ok ? after.balance : null,
    error: r.ok ? '' : JSON.stringify(r.data).slice(0, 200),
  }
  st.history.push(entry)
  st.lastClaimAt = entry.at
  st.lastBalance = entry.balance
  saveClaimState(st)
  if (!r.ok) return { ok: false, error: entry.error, status: r.status, summary: after }
  return { ok: true, claimed: true, amount: entry.amount, balance: entry.balance, summary: after }
}

/** 定时用：能领就领，领过就静默 */
export async function ensureDailyClaim() {
  try {
    const s = await creditsSummary()
    if (!s.ok) return { ok: false, error: s.error }
    if (s.claimedToday || !s.available) {
      return { ok: true, skipped: true, balance: s.balance, nextResetAt: s.nextResetAt }
    }
    return await claimDaily()
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
