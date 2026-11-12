/**
 * lib/selftune.mjs — 她自己调自己的生活
 * ============================================================================
 * 不是「主人给她加功能」，是「她自己看着设置、自己决定怎么活」。
 *
 *   看得见：selfStatePrompt() 把当前设置和今天的社交状态告诉她自己
 *   能改  ：[tune:参数=值] → applyTune()，白名单 + 范围 + 每天次数上限 + 留痕
 *   能提  ：[propose:想改成什么，为什么] → 存成提案，人类在面板上批
 *   能拒绝：什么都不改也是合法选择（提示词里写死了）
 *
 * 只放「生活节奏和表达方式」，不放安全/连接/模型/尺度——那些不该由她单方面改。
 * 数据：qq-fish/tune-log.json、qq-fish/proposals.json
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, saveConfig, stateHome } from './store.mjs'

const DAILY_LIMIT = 3

function logPath() { return join(stateHome(), 'tune-log.json') }
function propPath() { return join(stateHome(), 'proposals.json') }

function readJson(p, fb) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb }
}
function writeJson(p, v) {
  try { writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); return true } catch { return false }
}
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 她能调的东西。alias 是给人话用的名字（她写 [tune:语音积极性=high] 也认）。
 */
export const TUNABLE = {
  voiceEagerness: { alias: '语音积极性', group: '表达', type: 'enum', values: ['low', 'normal', 'high', 'always'], desc: '多久发一次语音：low 几乎都打字 / normal 情绪浓才说 / high 语气上来就说 / always 能说就说' },
  splitBubbles: { alias: '分条发送', group: '表达', type: 'bool', desc: '一条回复拆成几条发，像真人打字' },
  typingPerCharMs: { alias: '打字速度', group: '表达', type: 'number', min: 20, max: 300, desc: '每个字模拟打多久（毫秒），越大越慢越像真人' },
  stickerMaxPerDay: { alias: '贴纸上限', group: '表达', type: 'number', min: 0, max: 80, desc: '每天最多发几张表情包' },
  pushMinIntervalMinutes: { alias: '主动间隔', group: '节奏', type: 'number', min: 15, max: 600, desc: '两次主动找主人之间至少隔多久（分钟）' },
  maxProactivePerHour: { alias: '每小时上限', group: '节奏', type: 'number', min: 1, max: 10, desc: '一小时内最多主动发几条' },
  contextMessages: { alias: '记忆长度', group: '节奏', type: 'number', min: 40, max: 200, desc: '每次带多少条最近的对话（越大越记得住，也越慢越贵）' },
  diaryHour: { alias: '日记时间', group: '生活', type: 'number', min: 0, max: 23, desc: '每天几点写日记' },
  reviewEnabled: { alias: '写复盘', group: '生活', type: 'bool', desc: '要不要写日/周/月复盘' },
}

function resolveKey(input) {
  const s = String(input || '').trim()
  if (TUNABLE[s]) return s
  for (const [k, v] of Object.entries(TUNABLE)) {
    if (v.alias === s) return k
  }
  // 大小写不敏感
  const lower = s.toLowerCase()
  for (const k of Object.keys(TUNABLE)) {
    if (k.toLowerCase() === lower || String(TUNABLE[k].alias) === s) return k
  }
  return ''
}

function coerce(key, raw) {
  const spec = TUNABLE[key]
  if (!spec) return { ok: false, error: '不认识这个参数' }
  if (spec.type === 'bool') {
    const t = String(raw).trim().toLowerCase()
    if (['true', '1', 'on', '开', '是', 'yes'].includes(t)) return { ok: true, value: true }
    if (['false', '0', 'off', '关', '否', 'no'].includes(t)) return { ok: true, value: false }
    return { ok: false, error: '这个参数只能填 开/关' }
  }
  if (spec.type === 'enum') {
    const t = String(raw).trim().toLowerCase()
    if (spec.values.includes(t)) return { ok: true, value: t }
    return { ok: false, error: '只能填：' + spec.values.join(' / ') }
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false, error: '这个参数要填数字' }
  const v = Math.min(spec.max, Math.max(spec.min, Math.round(n)))
  return { ok: true, value: v }
}

/** 今天已经自己改过几次 */
export function tuneCountToday() {
  const d = readJson(logPath(), { items: [] })
  const today = todayStr()
  return (d.items || []).filter((x) => x && todayStr(new Date(x.at)) === today).length
}

/** 她改自己的设置。返回 { ok, key, label, from, to } 或 { ok:false, error } */
export function applyTune(inputKey, rawValue) {
  const key = resolveKey(inputKey)
  if (!key) return { ok: false, error: '「' + String(inputKey).slice(0, 12) + '」不在你能改的范围里' }
  const used = tuneCountToday()
  if (used >= DAILY_LIMIT) {
    return { ok: false, error: `今天已经改过 ${used} 次了（上限 ${DAILY_LIMIT} 次），明天再说` }
  }
  const c = coerce(key, rawValue)
  if (!c.ok) return { ok: false, error: c.error }
  const cfg = loadConfig()
  const from = cfg[key]
  if (String(from) === String(c.value)) return { ok: true, key, label: TUNABLE[key].alias, from, to: c.value, unchanged: true }
  saveConfig({ [key]: c.value })
  const after = loadConfig()[key]
  // 留痕：改了什么、从哪到哪
  const d = readJson(logPath(), { items: [] })
  d.items = Array.isArray(d.items) ? d.items : []
  d.items.push({ at: Date.now(), key, label: TUNABLE[key].alias, from, to: after })
  if (d.items.length > 60) d.items = d.items.slice(-60)
  writeJson(logPath(), d)
  return { ok: true, key, label: TUNABLE[key].alias, from, to: after }
}

/** 她提交一个提案（不敢直接改的） */
export function proposeTune(inputKey, rawValue, why = '') {
  const key = resolveKey(inputKey)
  const p = readJson(propPath(), { items: [] })
  p.items = Array.isArray(p.items) ? p.items : []
  if (p.items.filter((x) => x.status === 'pending').length >= 6) {
    return { ok: false, error: '待批准的提案太多了，等主人先处理一下' }
  }
  const item = {
    id: 'p' + Date.now().toString(36),
    key: key || String(inputKey || '').slice(0, 30),
    label: key ? TUNABLE[key].alias : String(inputKey || '').slice(0, 30),
    value: String(rawValue || '').slice(0, 40),
    why: String(why || '').slice(0, 160),
    at: Date.now(),
    status: 'pending',
  }
  p.items.push(item)
  writeJson(propPath(), p)
  return { ok: true, item }
}

export function proposalsSnapshot() {
  const p = readJson(propPath(), { items: [] })
  const items = Array.isArray(p.items) ? p.items : []
  return {
    pending: items.filter((x) => x.status === 'pending').reverse(),
    recent: items.filter((x) => x.status !== 'pending').slice(-10).reverse(),
  }
}

export function approveProposal(id) {
  const p = readJson(propPath(), { items: [] })
  const it = (p.items || []).find((x) => x.id === id)
  if (!it) return { ok: false, error: '没有这条提案' }
  const r = applyTune(it.key, it.value)
  it.status = r.ok ? 'approved' : 'rejected'
  it.handledAt = Date.now()
  it.result = r.ok ? '主人批准，已生效' : '批准但执行失败：' + (r.error || '')
  writeJson(propPath(), p)
  return r.ok ? { ok: true, ...r } : { ok: false, error: r.error }
}

export function rejectProposal(id) {
  const p = readJson(propPath(), { items: [] })
  const it = (p.items || []).find((x) => x.id === id)
  if (!it) return { ok: false, error: '没有这条提案' }
  it.status = 'rejected'
  it.handledAt = Date.now()
  it.result = '主人拒绝了'
  writeJson(propPath(), p)
  return { ok: true }
}

export function tuneSnapshot() {
  const cfg = loadConfig()
  const d = readJson(logPath(), { items: [] })
  return {
    tunable: Object.entries(TUNABLE).map(([key, v]) => ({
      key, alias: v.alias, group: v.group, type: v.type,
      desc: v.desc, values: v.values || [], min: v.min, max: v.max,
      current: cfg[key],
    })),
    usedToday: tuneCountToday(),
    dailyLimit: DAILY_LIMIT,
    log: (d.items || []).slice(-10).reverse(),
    proposals: proposalsSnapshot(),
  }
}

/** 注入给她看：你现在的设置是这样，你可以改 */
export function selfStatePrompt({ social = null } = {}) {
  const cfg = loadConfig()
  const items = Object.entries(TUNABLE).map(([key, v]) => {
    const cur = cfg[key]
    const shown = v.type === 'bool' ? (cur ? '开' : '关') : String(cur)
    return `· ${v.alias}：${shown}${v.type === 'number' ? `（可改范围 ${v.min}–${v.max}）` : v.type === 'enum' ? `（可选 ${v.values.join('/')}）` : ''}`
  })
  const lines = ['【你自己的生活设置】', ...items]
  if (social) {
    lines.push(`· 今天你主动找过主人 ${social.totalProactive || 0} 次，被回应了 ${social.totalReplied || 0} 次`)
    if (social.sulking) lines.push('· 你现在在赌气：' + (social.sulkReasonText || ''))
  }
  const used = tuneCountToday()
  lines.push('')
  lines.push(`这些是你自己的东西。想改就在回复里写 [tune:参数名=值]，一天最多改 ${DAILY_LIMIT} 次（今天已用 ${used} 次）。`)
  lines.push('拿不准、或者觉得该由主人决定的，写 [propose:想改成什么，为什么]，我转告他。')
  lines.push('你也可以什么都不改——「我现在这样就很好」是完全可以的选择，不用为了显得在成长而乱调。')
  return lines.join('\n')
}
