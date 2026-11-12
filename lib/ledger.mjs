/**
 * lib/ledger.mjs — 记忆账本 + 每日健康一行
 * ============================================================================
 * 账本的作用：证明「没丢过记忆」。
 *   - 每条记忆存一个 sha256 指纹（第一次写入时）
 *   - 之后只补新的 id，老记录绝不覆盖
 *   - verify 时逐条比对：库里还在吗？哈希还对吗？
 *
 * 健康一行：每天生成一条，方便一眼看出记忆系统是否正常。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = (t) => createHash('sha256').update(String(t || ''), 'utf8').digest('hex')

function ledgerPath(home) { return join(home, 'memory-ledger.json') }
function healthPath(home) { return join(home, 'health.log') }

function loadLedger(home) {
  try { return JSON.parse(readFileSync(ledgerPath(home), 'utf8')) } catch { return { version: 1, entries: {}, updatedAt: 0 } }
}

function saveLedger(home, led) {
  led.updatedAt = Date.now()
  try { writeFileSync(ledgerPath(home), JSON.stringify(led, null, 2) + '\n', 'utf8') } catch {}
}

/** 把新记忆补进账本（老记录不动） */
export function ledgerSync(home, memories = []) {
  const led = loadLedger(home)
  let added = 0
  for (const m of memories) {
    if (!m || !m.id) continue
    const id = String(m.id)
    if (led.entries[id]) continue
    const text = String(m.text || m.content || '')
    led.entries[id] = { sha256: sha(text), len: text.length, at: Date.now() }
    added++
  }
  if (added) saveLedger(home, led)
  return { ok: true, added, total: Object.keys(led.entries).length }
}

/** 校验：库里的记忆是否都还在、哈希是否一致 */
export function ledgerVerify(home, memories = []) {
  const led = loadLedger(home)
  const alive = new Map()
  for (const m of memories) {
    if (m && m.id) alive.set(String(m.id), String(m.text || m.content || ''))
  }
  const missing = []
  const tampered = []
  for (const [id, rec] of Object.entries(led.entries || {})) {
    if (!alive.has(id)) { missing.push(id); continue }
    if (sha(alive.get(id)) !== rec.sha256) tampered.push(id)
  }
  const ok = missing.length === 0 && tampered.length === 0
  return {
    ok,
    total: Object.keys(led.entries || {}).length,
    alive: alive.size,
    missing: missing.slice(0, 20),
    tampered: tampered.slice(0, 20),
  }
}

/** 每日健康一行（同一天只写一次） */
export function healthLine(home, info = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const file = healthPath(home)
  let last = ''
  try { last = readFileSync(file, 'utf8').trim().split('\n').pop() || '' } catch {}
  if (last.startsWith(today)) return { ok: true, skipped: true, line: last }

  const parts = [
    today,
    'mem=' + (info.memCount ?? '?'),
    'vitals=' + (info.vitalsOk ? 'ok' : 'no'),
    'organic=' + (info.tension ?? '?'),
    'mood=' + (info.mood || '?'),
  ]
  const line = parts.join(' ')
  try { appendFileSync(file, line + '\n', 'utf8') } catch {}
  return { ok: true, line }
}

/** 面板用：账本 + 健康摘要 */
export function ledgerSnapshot(home, memories = []) {
  const led = loadLedger(home)
  const v = ledgerVerify(home, memories)
  let health = []
  try { health = readFileSync(healthPath(home), 'utf8').trim().split('\n').slice(-7) } catch {}
  return {
    ledger: { total: Object.keys(led.entries || {}).length, updatedAt: led.updatedAt },
    verify: v,
    health,
  }
}
