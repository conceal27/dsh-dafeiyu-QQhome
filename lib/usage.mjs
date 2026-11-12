/**
 * lib/usage.mjs — token 消费统计（归属：xingzhu）
 * ============================================================================
 * 数据落在 `$DSH_HOME/qq-fish/usage.json`：
 *   { lifetime:{input,output,calls}, days:{ "YYYY-MM-DD":{input,output,calls} }, recent:[...] }
 * 只记数字，不记聊天内容；面板展示今日/累计/调用次数。
 * ============================================================================
 */
import { pathOf, readJson, todayKey, writeJsonAtomic } from './store.mjs'

const MAX_DAYS = 120
const MAX_RECENT = 50

function load() {
  const data = readJson(pathOf('usage.json'), null)
  if (!data || typeof data !== 'object') {
    return { lifetime: { input: 0, output: 0, calls: 0 }, days: {}, recent: [] }
  }
  if (!data.lifetime) data.lifetime = { input: 0, output: 0, calls: 0 }
  if (!data.days || typeof data.days !== 'object') data.days = {}
  if (!Array.isArray(data.recent)) data.recent = []
  return data
}

/** 记一次调用（usage 可以来自 normalizeUsage；没拿到 usage 也记 calls） */
export function recordUsage(usage, meta) {
  const data = load()
  const today = todayKey()
  const day = data.days[today] || { input: 0, output: 0, calls: 0 }
  const add = (obj, input, output, calls) => {
    obj.input = (obj.input || 0) + input
    obj.output = (obj.output || 0) + output
    obj.calls = (obj.calls || 0) + calls
  }
  const input = usage ? usage.input || 0 : 0
  const output = usage ? usage.output || 0 : 0
  add(day, input, output, 1)
  add(data.lifetime, input, output, 1)
  data.days[today] = day
  data.recent.unshift({
    at: Date.now(),
    input,
    output,
    kind: (meta && meta.kind) || 'reply',
    provider: (meta && meta.provider) || '',
    model: (meta && meta.model) || '',
  })
  data.recent = data.recent.slice(0, MAX_RECENT)
  const keys = Object.keys(data.days).sort()
  if (keys.length > MAX_DAYS) {
    for (const key of keys.slice(0, keys.length - MAX_DAYS)) delete data.days[key]
  }
  writeJsonAtomic(pathOf('usage.json'), data)
  return data
}

/** 面板用摘要 */
export function usageSummary() {
  const data = load()
  const today = data.days[todayKey()] || { input: 0, output: 0, calls: 0 }
  const days = Object.keys(data.days)
    .sort()
    .slice(-14)
    .map((key) => ({ date: key, ...data.days[key] }))
  return {
    today: { input: today.input || 0, output: today.output || 0, calls: today.calls || 0 },
    lifetime: {
      input: data.lifetime.input || 0,
      output: data.lifetime.output || 0,
      calls: data.lifetime.calls || 0,
    },
    days,
    recent: data.recent.slice(0, 12),
  }
}
