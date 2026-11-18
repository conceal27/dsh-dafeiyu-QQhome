/**
 * lib/breeze-voices.mjs — BreezeBlue 账号里到底有哪些音色
 * ============================================================================
 * 以前 options.breeze 是写死的两条（机灵版/迷糊版），面板里就只能选两个；
 * 其实账号里有一堆（含自己克隆的）。这里直接问 /v1/voices，缓存 6 小时。
 * 另外顺手读 /v1/balance（余额），面板上能看见还剩多少字。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateHome } from './store.mjs'
import { BREEZE_VOICES } from './tts.mjs'

const BASE = 'https://api.breezeblue.ai'
const TTL_MS = 6 * 60 * 60 * 1000

function cachePath() {
  return join(stateHome(), 'breeze-voices.json')
}

function readCache() {
  try {
    const d = JSON.parse(readFileSync(cachePath(), 'utf8'))
    if (!d || !Array.isArray(d.voices)) return null
    return d
  } catch {
    return null
  }
}

/** 同步读缓存（拿不到就退回写死的那两条） */
export function cachedBreezeVoices() {
  const c = readCache()
  return c && c.voices.length ? c.voices : BREEZE_VOICES.map((v) => ({ ...v, fav: false, origin: '' }))
}

export function isBreezeVoiceId(id) {
  const s = String(id || '')
  if (!s) return false
  if (cachedBreezeVoices().some((v) => v.id === s)) return true
  return /^voc_[a-z0-9]{6,}$/i.test(s)
}

async function getJson(url, apiKey, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 拉账号的音色列表（分页最多 3 页），失败时返回缓存/内置 */
export async function listBreezeVoices({ apiKey = '', force = false } = {}) {
  const c = readCache()
  if (!force && c && Date.now() - Number(c.fetchedAt || 0) < TTL_MS && c.voices.length) {
    return { ok: true, cached: true, voices: c.voices, balance: c.balance }
  }
  if (!apiKey) return { ok: false, error: '没有 apiKey', voices: cachedBreezeVoices(), balance: c ? c.balance : null }

  const all = []
  let token = ''
  for (let page = 0; page < 3; page++) {
    const q = token ? '?next_page_token=' + encodeURIComponent(token) : ''
    const r = await getJson(BASE + '/v1/voices' + q, apiKey)
    if (!r.ok) {
      const fallback = cachedBreezeVoices()
      return { ok: false, error: r.error || ('HTTP ' + r.status), voices: fallback, balance: c ? c.balance : null }
    }
    const list = Array.isArray(r.data && r.data.voices) ? r.data.voices : []
    for (const v of list) {
      const id = String(v.voice_id || '')
      if (!id) continue
      const name = String(v.name || id)
      all.push({
        id,
        name,
        origin: String(v.origin || ''),
        fav: !!v.is_favorited,
        preview: String(v.preview_url || ''),
      })
    }
    token = String((r.data && (r.data.next_page_token || r.data.nextPageToken)) || '')
    if (!token || !list.length) break
  }

  // 排序：收藏的 > 名字里带「大肥鱼」的 > 自己克隆的 > 其余（按名字）
  all.sort((a, b) => {
    const score = (v) =>
      (v.fav ? 8 : 0) + (/大肥鱼/.test(v.name) ? 4 : 0) + (v.origin === 'cloned' ? 2 : 0)
    const d = score(b) - score(a)
    if (d) return d
    return a.name.localeCompare(b.name, 'zh')
  })

  // 去重（同一个 id 只留一条）
  const seen = new Set()
  const voices = all.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))

  const bal = await getJson(BASE + '/v1/balance', apiKey, 10000)
  const balance = bal.ok
    ? {
        credits: Number(bal.data.balance) || 0,
        pending: !!bal.data.settlement_pending,
        scale: Number(bal.data.scale) || 1000,
        at: Date.now(),
      }
    : (c ? c.balance : null)

  try {
    writeFileSync(
      cachePath(),
      JSON.stringify({ fetchedAt: Date.now(), voices, balance }, null, 2) + '\n',
      'utf8',
    )
  } catch {}
  return { ok: true, cached: false, voices, balance }
}

/** 只在缓存过期时顺手刷一下（给启动/定时用，不阻塞） */
export async function refreshBreezeVoicesIfStale(apiKey) {
  const c = readCache()
  if (c && Date.now() - Number(c.fetchedAt || 0) < TTL_MS) return
  await listBreezeVoices({ apiKey })
}
