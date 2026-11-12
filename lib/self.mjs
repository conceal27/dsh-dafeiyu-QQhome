/**
 * lib/self.mjs — 自我层（只读阶段）
 * ============================================================================
 * 文档的原则：先只读、先不注入、先看几天。
 *
 * 这里定义三样东西：
 *   claims   她相信的事（带证据）
 *   projects 她想做的事（带失败条件）
 *   commitments 答应过的事
 *
 * 以及「晚间三行」：每天一句话记下"我今天……"
 *
 * 重要：本模块的输出**不注入提示词**（P0/P1 阶段）。
 *       只有面板能看。等你自己判断"像不像她"之后，再考虑注入。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

function file(home) { return join(home, 'self.json') }
function linesFile(home) { return join(home, 'self-lines.jsonl') }

function load(home) {
  try { return JSON.parse(readFileSync(file(home), 'utf8')) } catch {
    return { version: 1, claims: [], projects: [], commitments: [], updatedAt: 0 }
  }
}
function save(home, v) {
  v.updatedAt = Date.now()
  try { writeFileSync(file(home), JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
}

/** 加一条 claim（她相信的事，必须带证据） */
export function addClaim(home, text, evidence = '') {
  const v = load(home)
  if (!String(text || '').trim()) return { ok: false, error: 'empty' }
  v.claims.push({ id: 'c' + Date.now(), text: String(text).slice(0, 200), evidence: String(evidence).slice(0, 200), at: Date.now() })
  if (v.claims.length > 50) v.claims = v.claims.slice(-50)
  save(home, v)
  return { ok: true, total: v.claims.length }
}

/** 加一条 project（她想做的事，带失败条件） */
export function addProject(home, title, failIf = '') {
  const v = load(home)
  if (!String(title || '').trim()) return { ok: false, error: 'empty' }
  v.projects.push({ id: 'p' + Date.now(), title: String(title).slice(0, 100), failIf: String(failIf).slice(0, 100), status: 'open', at: Date.now() })
  if (v.projects.length > 20) v.projects = v.projects.slice(-20)
  save(home, v)
  return { ok: true, total: v.projects.length }
}

/** 晚间三行（每天最多一条） */
export function addLine(home, text) {
  const today = new Date().toISOString().slice(0, 10)
  let done = false
  try {
    const rows = readFileSync(linesFile(home), 'utf8').trim().split('\n').filter(Boolean)
    done = rows.some((l) => { try { return JSON.parse(l).date === today } catch { return false } })
  } catch {}
  if (done) return { ok: false, skipped: true }
  const line = { date: today, text: String(text || '').slice(0, 200), at: Date.now() }
  try { appendFileSync(linesFile(home), JSON.stringify(line) + '\n', 'utf8') } catch {}
  return { ok: true, line }
}

/** 面板快照 */
export function selfSnapshot(home) {
  const v = load(home)
  let lines = []
  try {
    lines = readFileSync(linesFile(home), 'utf8').trim().split('\n').filter(Boolean).slice(-7)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {}
  return {
    claims: v.claims.slice(-8),
    projects: v.projects.slice(-5),
    commitments: v.commitments.slice(-5),
    lines,
    updatedAt: v.updatedAt,
  }
}
