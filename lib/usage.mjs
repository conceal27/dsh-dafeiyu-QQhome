/**
 * lib/usage.mjs — token 消费统计 + 花费估算（归属：xingzhu）
 * ============================================================================
 * 数据落在 `$DSH_HOME/qq-fish/usage.json`：
 *   {
 *     lifetime: { input, output, calls, cost },
 *     days: { "YYYY-MM-DD": { input, output, calls, cost,
 *                             features: { reply:{input,output,calls,cost}, ... },
 *                             models:   { "provider/model":{...} } } },
 *     recent: [ { at, input, output, cost, kind, feature, provider, model, estimated } ]
 *   }
 * 只记数字，不记聊天内容。
 *
 * 花费（cost，单位：元）按 config.modelPrices（元 / 百万 token）现算，
 * 因此改单价会重新解释历史 token —— 存的是 token，不是钱。
 * ============================================================================
 */
import { loadConfig, pathOf, readJson, todayKey, writeJsonAtomic } from './store.mjs'

const MAX_DAYS = 120
const MAX_RECENT = 60

/** 可以单独指定模型的「功能」。key 与各模块调用 generateText 时传的 feature 对齐 */
export const FEATURES = [
  { key: 'reply', label: '聊天回复' },
  { key: 'proactive', label: '主动搭话' },
  { key: 'schedule', label: '日程/计划' },
  { key: 'diary', label: '日记/周记' },
  { key: 'learn', label: '学习/读书' },
  { key: 'memory', label: '记忆整理' },
  { key: 'persona', label: '人设演化' },
  { key: 'mood', label: '内心/心情' },
  { key: 'intent', label: '意图判断' },
  { key: 'sign', label: '自动签到' },
  { key: 'qzone', label: 'QQ空间' },
  { key: 'bili', label: 'B站' },
  { key: 'image', label: '生图提示词' },
  { key: 'worldview', label: '观点' },
  { key: 'panel', label: '面板调试' },
  { key: 'other', label: '其它' },
]

const FEATURE_LABEL = Object.fromEntries(FEATURES.map((f) => [f.key, f.label]))
const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key))

export function featureLabel(key) {
  return FEATURE_LABEL[key] || FEATURE_LABEL.other
}

/** 未知 feature 统一落到 other，避免脏 key 把统计表撑爆 */
export function normFeature(value) {
  const key = String(value || '').trim().toLowerCase()
  return FEATURE_KEYS.has(key) ? key : 'other'
}

/**
 * 粗略估 token（只在 provider 不返回 usage 时兜底）：
 * 中日韩字符按 1 字 1 token，其余按 4 字符 1 token。
 */
export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length
  return Math.max(1, Math.round(cjk + (s.length - cjk) / 4))
}

/** 单价（元 / 百万 token）：先精确匹配 provider/model，再退化到只按 model 匹配 */
export function priceOf(config, provider, model) {
  const table = (config && config.modelPrices) || {}
  const candidates = []
  if (provider && model) candidates.push(provider + '/' + model)
  if (model) candidates.push(model)
  for (const key of candidates) {
    const p = table[key]
    if (!p || typeof p !== 'object') continue
    const input = Number(p.input)
    const output = Number(p.output)
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue
    return { input: Number.isFinite(input) && input > 0 ? input : 0, output: Number.isFinite(output) && output > 0 ? output : 0 }
  }
  return null
}

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6

export function costOf(tokens, price) {
  if (!price || !tokens) return 0
  return round6((Number(tokens.input || 0) / 1e6) * price.input + (Number(tokens.output || 0) / 1e6) * price.output)
}

function emptyBucket() {
  return { input: 0, output: 0, calls: 0, cost: 0 }
}

function normalizeBucket(raw) {
  const b = emptyBucket()
  if (!raw || typeof raw !== 'object') return b
  b.input = Number(raw.input) || 0
  b.output = Number(raw.output) || 0
  b.calls = Number(raw.calls) || 0
  b.cost = Number(raw.cost) || 0
  if (raw.features && typeof raw.features === 'object') b.features = raw.features
  if (raw.models && typeof raw.models === 'object') b.models = raw.models
  return b
}

function load() {
  const data = readJson(pathOf('usage.json'), null)
  if (!data || typeof data !== 'object') {
    return { lifetime: emptyBucket(), days: {}, recent: [] }
  }
  data.lifetime = normalizeBucket(data.lifetime)
  if (!data.days || typeof data.days !== 'object') data.days = {}
  if (!Array.isArray(data.recent)) data.recent = []
  return data
}

function bump(bucket, input, output, cost, calls) {
  bucket.input = (bucket.input || 0) + input
  bucket.output = (bucket.output || 0) + output
  bucket.calls = (bucket.calls || 0) + calls
  bucket.cost = round6((bucket.cost || 0) + cost)
}

function bumpSub(container, key, input, output, cost, calls) {
  if (!key) return
  if (!container[key] || typeof container[key] !== 'object') container[key] = emptyBucket()
  bump(container[key], input, output, cost, calls)
}

/**
 * 记一次调用。
 * @param {object|null} usage normalizeUsage() 的结果；null 时用 promptChars/outputChars 估算
 * @param {object} meta { feature, kind, provider, model, promptChars, outputChars, calls, estimated }
 */
export function recordUsage(usage, meta) {
  const data = load()
  const today = todayKey()
  const day = normalizeBucket(data.days[today] || emptyBucket())

  const info = meta && typeof meta === 'object' ? meta : {}
  const feature = normFeature(info.feature || info.kind)
  const provider = String(info.provider || '').slice(0, 120)
  const model = String(info.model || '').slice(0, 120)
  const calls = Math.max(1, Math.trunc(Number(info.calls) || 1))

  let input = usage ? Number(usage.input) || 0 : 0
  let output = usage ? Number(usage.output) || 0 : 0
  let estimated = info.estimated === true
  if (!usage && (info.promptChars || info.outputChars)) {
    input = estimateTokens('x'.repeat(Math.max(0, Number(info.promptChars) || 0)))
    output = estimateTokens('x'.repeat(Math.max(0, Number(info.outputChars) || 0)))
    estimated = true
  }

  let price = null
  try {
    price = priceOf(loadConfig(), provider, model)
  } catch {
    price = null
  }
  const cost = costOf({ input, output }, price)

  // 总量
  bump(day, input, output, cost, calls)
  bump(data.lifetime, input, output, cost, calls)

  // 按功能
  if (!day.features || typeof day.features !== 'object') day.features = {}
  bumpSub(day.features, feature, input, output, cost, calls)

  // 按模型
  if (!day.models || typeof day.models !== 'object') day.models = {}
  bumpSub(day.models, (provider && model ? provider + '/' + model : model || provider || 'unknown'), input, output, cost, calls)

  data.days[today] = day
  data.recent.unshift({
    at: Date.now(),
    input,
    output,
    cost,
    kind: String(info.kind || feature).slice(0, 40),
    feature,
    provider,
    model,
    estimated,
  })
  data.recent = data.recent.slice(0, MAX_RECENT)

  const keys = Object.keys(data.days).sort()
  if (keys.length > MAX_DAYS) {
    for (const key of keys.slice(0, keys.length - MAX_DAYS)) delete data.days[key]
  }
  writeJsonAtomic(pathOf('usage.json'), data)
  return data
}

/**
 * 面板用摘要。
 * @param {number} days 统计窗口（默认 14 天，最大 90）
 */
export function usageSummary(days = 14) {
  const data = load()
  const span = Math.min(90, Math.max(1, Math.trunc(Number(days) || 14)))
  const today = normalizeBucket(data.days[todayKey()] || emptyBucket())
  const keys = Object.keys(data.days).sort().slice(-span)

  const window = emptyBucket()
  const featureAgg = {}
  const modelAgg = {}
  const dayList = []
  for (const key of keys) {
    const day = normalizeBucket(data.days[key] || emptyBucket())
    bump(window, day.input, day.output, day.cost, day.calls)
    for (const [k, v] of Object.entries(day.features || {})) {
      if (!v || typeof v !== 'object') continue
      bumpSub(featureAgg, k, Number(v.input) || 0, Number(v.output) || 0, Number(v.cost) || 0, Number(v.calls) || 0)
    }
    for (const [k, v] of Object.entries(day.models || {})) {
      if (!v || typeof v !== 'object') continue
      bumpSub(modelAgg, k, Number(v.input) || 0, Number(v.output) || 0, Number(v.cost) || 0, Number(v.calls) || 0)
    }
    dayList.push({ date: key, input: day.input, output: day.output, calls: day.calls, cost: day.cost })
  }

  const byFeature = Object.entries(featureAgg)
    .map(([key, v]) => ({ key, label: featureLabel(key), input: v.input, output: v.output, calls: v.calls, cost: v.cost }))
    .sort((a, b) => b.input + b.output - (a.input + a.output))
  const byModel = Object.entries(modelAgg)
    .map(([key, v]) => ({ key, input: v.input, output: v.output, calls: v.calls, cost: v.cost }))
    .sort((a, b) => b.input + b.output - (a.input + a.output))

  let prices = {}
  try {
    prices = loadConfig().modelPrices || {}
  } catch {}

  return {
    today,
    lifetime: data.lifetime,
    window: { span, ...window },
    days: dayList,
    byFeature,
    byModel,
    prices,
    features: FEATURES,
    recent: data.recent.slice(0, 20),
  }
}
