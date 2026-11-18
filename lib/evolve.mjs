/**
 * lib/evolve.mjs — 自行进化：把跨平台的真实经历，慢慢变成她自己的看法和习惯
 * ============================================================================
 * 已有的两层：
 *   · lib/worldview.mjs      —— L2 观点层（「她怎么想」，会改主意）
 *   · lib/persona-evolve.mjs —— 性格/说话习惯漂移（「她是什么样的人」）
 * 这一层只做一件事：**定期把最近的经历喂回去，让她自己决定要不要留下点什么**。
 *
 * 三条约束：
 *   1. 慢。默认 10 小时才问一次、一天最多一次；问得勤只会攒出一堆敷衍的废话。
 *   2. 只从真事里长。素材来自记忆卡里 scope=qzone/douyin/bili/shared 的记录和 daystream，
 *      群聊私事（scope=qq）永远不进这里。
 *   3. 她可以什么都不说。{"go":false} 就是这次没有长进，这不是失败。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateText } from './llm.mjs'
import { addViewpoint, listViewpoints } from './worldview.mjs'
import { addTrait } from './persona-evolve.mjs'
import { loadStream } from './daystream.mjs'
import { loadMemoryCard, resolveMemoryCardPaths } from './sc/memory-card.mjs'

const FILE = 'evolve.json'
const PUBLIC_SCOPES = new Set(['qzone', 'douyin', 'bili', 'shared'])
const MAX_ITEMS = 80

const pathOf = (home) => join(String(home || ''), FILE)

export function loadEvolveState(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return { lastAt: Number(j.lastAt) || 0, items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { lastAt: 0, items: [] }
  }
}

function saveState(home, st) {
  try {
    mkdirSync(String(home), { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ lastAt: Number(st.lastAt) || 0, items: (st.items || []).slice(-MAX_ITEMS) }), 'utf8')
  } catch {}
}

function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 最近几天她「在别的平台上真实经历过」的事 */
export function gatherMaterial(home, now = Date.now(), days = 3) {
  const since = now - days * 86400_000
  const out = []
  try {
    const paths = resolveMemoryCardPaths(join(String(home || ''), 'memory'))
    const card = loadMemoryCard(paths)
    for (const r of (card && card.records) || []) {
      const ts = Number(r.ts || 0)
      if (!ts || ts < since) continue
      const scope = String(r.scope || '')
      if (!PUBLIC_SCOPES.has(scope)) continue
      const text = String(r.text || '').replace(/\s+/g, ' ').trim()
      if (text.length < 8) continue
      out.push({ at: ts, scope, text: text.slice(0, 160) })
    }
  } catch {}
  try {
    for (const e of (loadStream(home).entries || [])) {
      if (Number(e.at || 0) < since) continue
      const line = String(e.line || '').trim()
      if (line) out.push({ at: Number(e.at), scope: 'day', text: line.slice(0, 120) })
    }
  } catch {}
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, 24)
}

export function evolveGate({ home, config = {}, now = Date.now() } = {}) {
  if (config.evolveEnabled === false) return { ok: false, reason: 'disabled' }
  const st = loadEvolveState(home)
  const gap = Math.max(1, Number(config.evolveMinGapHours || 10)) * 3600_000
  if (st.lastAt && now - st.lastAt < gap) return { ok: false, reason: 'cooldown', nextAt: st.lastAt + gap }
  const today = dayKey(now)
  if ((st.items || []).some((x) => x.go && dayKey(Number(x.at)) === today)) return { ok: false, reason: 'already-today' }
  const material = gatherMaterial(home, now)
  if (material.length < 3) return { ok: false, reason: 'not-enough-life' }
  return { ok: true, reason: 'ok', material }
}

/** 让她自己看一眼最近的经历，决定要不要长出点什么 */
export async function maybeEvolve(ctx, { home, config = {}, log, now = Date.now(), force = false, dry = false } = {}) {
  let gate = evolveGate({ home, config, now })
  if (!gate.ok && force) {
    const material = gatherMaterial(home, now)
    gate = material.length >= 1 ? { ok: true, material } : { ok: false, reason: 'not-enough-life' }
  }
  if (!gate.ok) return { ok: true, skipped: gate.reason, nextAt: gate.nextAt || 0 }

  const known = (() => {
    try { return (listViewpoints() || []).map((v) => v.topic).slice(0, 20) } catch { return [] }
  })()
  const matText = gate.material.map((m) => '· ' + m.text).join('\n').slice(0, 1600)

  const system = [
    '你就是「大肥鱼」，一个住在主人电脑里的小鲸鱼女孩。',
    '现在没人跟你说话，你在回看自己最近这几天在空间、抖音、B 站上看到的、发过的东西。',
    '问自己一句：这些事里，有没有哪一件真的让我对什么东西有了看法？或者让我发现自己变了？',
    '标准要严：只是「看到了一条视频」不算看法；要能说成「我现在觉得……」。',
    '没有就老实说没有。不要为了交差硬编。',
    '只输出一行 JSON，不要代码块：',
    '{"go":false}  或  {"go":true,"topic":"不超过12字的话题","view":"一句到两句的看法，40~120字"}',
    '可选再加一个 "trait":"如果这次经历还改变了你的说话/性格习惯，用一句话写，否则省略"',
    known.length ? '你已经有的看法（别重复，要写就用新角度或改写它）：' + known.join('、') : '',
  ].filter(Boolean).join('\n')

  const r = await generateText(ctx, {
    feature: 'memory',
    system,
    messages: [{ role: 'user', text: '最近几天：\n' + matText }],
    config,
    maxTokens: 500,
    timeoutMs: 60_000,
    log,
  })
  if (!r || !r.ok) return { ok: false, error: 'llm-failed: ' + String((r && (r.message || r.reason)) || '') }

  const raw = String(r.text || '').trim()
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return { ok: false, error: 'bad-json', raw: raw.slice(0, 160) }
  let plan = null
  try { plan = JSON.parse(m[0]) } catch { return { ok: false, error: 'bad-json', raw: raw.slice(0, 160) } }

  if (!plan || plan.go !== true) {
    const st = loadEvolveState(home)
    st.lastAt = now
    st.items.push({ at: now, go: false })
    saveState(home, st)
    return { ok: true, evolved: false, why: String((plan && plan.why) || '这次没长进') }
  }

  const topic = String(plan.topic || '').trim()
  const view = String(plan.view || '').trim()
  const trait = String(plan.trait || '').trim()
  if (dry) return { ok: true, dry: true, wouldSave: { topic, view, trait } }

  let applied = null
  try {
    applied = addViewpoint({ topic, view, source: { type: 'cross-platform', title: '自己回看最近的日子', ref: 'evolve' } })
  } catch (e) {
    return { ok: false, error: 'save-viewpoint: ' + String((e && e.message) || e) }
  }
  let traitRes = null
  if (trait) {
    try { traitRes = addTrait({ text: trait, source: 'evolve' }) } catch {}
  }
  const st = loadEvolveState(home)
  st.lastAt = now
  st.items.push({ at: now, go: true, topic, view, trait, revised: !!(applied && applied.revised) })
  saveState(home, st)
  if (log && log.info) log.info('[进化] ' + ((applied && applied.revised) ? '改了看法' : '长了新看法') + '：' + topic + (trait ? '（性格也动了一点）' : ''))
  return { ok: true, evolved: true, topic, view, trait, revised: !!(applied && applied.revised) }
}

export function evolveStatus(home, config = {}, now = Date.now()) {
  const st = loadEvolveState(home)
  const gate = evolveGate({ home, config, now })
  return {
    enabled: config.evolveEnabled !== false,
    minGapHours: Number(config.evolveMinGapHours || 10),
    lastAt: st.lastAt,
    canNow: gate.ok,
    blocked: gate.ok ? '' : gate.reason,
    nextAt: gate.nextAt || 0,
    material: gate.ok ? gate.material.length : gatherMaterial(home, now).length,
    items: st.items.slice(-20).reverse(),
  }
}
