/**
 * lib/quota.mjs — 积分 / 余额查询（归属：迁移自 AstrBot 的 deepseek_balance + workbuddy 面板）
 * ============================================================================
 * 两只口袋：
 *   · workbuddy 账号池积分 —— 走 DSH 里 dsh-connect-workbuddy 插件自己的只读接口
 *     （/plugins/dsh-connect-workbuddy/account-credits，loopback 免鉴权）
 *   · DeepSeek 官方余额 —— 直连 https://api.deepseek.com/user/balance，key 取 DEEPSEEK_API_KEY
 * 都带 60 秒缓存：她一口气问三遍也不会把接口打爆。
 * 任何一边失败都只返回 null，不影响主流程。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './store.mjs'

const CACHE_MS = 60_000
const cache = { at: 0, value: null }

/** 从环境变量或 dsh.env 里取某个 key */
function envOrFile(name) {
  const direct = process.env[name]
  if (direct) return String(direct).trim()
  try {
    const raw = readFileSync(join(dshHome(), 'dsh.env'), 'utf8')
    const line = raw.split('\n').find((l) => l.trim().startsWith(name + '='))
    if (!line) return ''
    return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  } catch {
    return ''
  }
}

async function fetchJson(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: null, error: (e && e.message) || String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** workbuddy 账号池积分 */
export async function workbuddyCredits() {
  const port = String(process.env.DSH_WEB_PORT || 3080)
  const bases = [
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]
  const headers = {
    Host: `127.0.0.1:${port}`,
    Origin: `http://127.0.0.1:${port}`,
    Accept: 'application/json',
  }
  for (const base of bases) {
    const r = await fetchJson(base + '/plugins/dsh-connect-workbuddy/account-credits', { headers, timeoutMs: 6000 })
    const list = (r.body && Array.isArray(r.body.accounts)) ? r.body.accounts : null
    if (list) {
      const accounts = list.map((a) => ({
        name: String(a.accountName || a.id || ''),
        credits: Math.round((Number(a.credits) || 0) * 100) / 100,
        selected: a.selected === true,
      }))
      const total = Math.round(accounts.reduce((sum, a) => sum + a.credits, 0) * 100) / 100
      return { accounts, total }
    }
  }
  return null
}

/** DeepSeek 官方余额（人民币） */
export async function deepseekBalance() {
  const key = envOrFile('DEEPSEEK_API_KEY')
  if (!key) return { ok: false, error: '没有 DEEPSEEK_API_KEY' }
  const r = await fetchJson('https://api.deepseek.com/user/balance', {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    timeoutMs: 8000,
  })
  const b = r.body || {}
  const infos = Array.isArray(b.balance_infos) ? b.balance_infos : []
  if (!infos.length) return { ok: false, error: (r.error || ('HTTP ' + r.status)) }
  return {
    ok: true,
    available: b.is_available === true,
    items: infos.map((i) => ({
      currency: String(i.currency || 'CNY'),
      total: Number(i.total_balance) || 0,
      granted: Number(i.granted_balance) || 0,
      toppedUp: Number(i.topped_up_balance) || 0,
    })),
  }
}

/** 两边一起查（带缓存） */
export async function quotaSnapshot({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value
  const [wb, ds] = await Promise.all([
    workbuddyCredits().catch(() => null),
    deepseekBalance().catch(() => null),
  ])
  const value = { at: now, workbuddy: wb, deepseek: ds }
  // 两边全失败就别缓存，下次还能再试
  if (wb || (ds && ds.ok)) { cache.at = now; cache.value = value }
  return value
}

/** 给人看的一句话（也直接喂给她当事实） */
export function quotaLine(q) {
  if (!q) return ''
  const parts = []
  if (q.workbuddy && q.workbuddy.accounts.length) {
    const detail = q.workbuddy.accounts.map((a) => a.name + ' ' + a.credits).join('、')
    parts.push('workbuddy 积分合计 ' + q.workbuddy.total + '（' + detail + '）')
  }
  if (q.deepseek && q.deepseek.ok) {
    const ds = q.deepseek.items.map((i) => i.currency + ' ' + i.total.toFixed(2)).join('、')
    parts.push('DeepSeek 官方余额 ' + ds)
  }
  return parts.join('；')
}
