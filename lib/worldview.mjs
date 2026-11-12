/**
 * lib/worldview.mjs — L2 观点层（她会因为读过的书/看过的视频改主意）
 * ============================================================================
 * 主人要的「自我迭代」不是记住更多事实，而是**看法会变**：
 *   读完一本书 / 看完一个视频 → 写 1 条「我现在的看法」，带来源（书名+位置 / BV号）；
 *   同话题再遇到新证据 → 旧观点进 history，保留「以前我觉得…后来…」的痕迹；
 *   聊天时只在话题相关时召回 1–2 条（不掉书袋、不占预算）。
 * 三道闸门：必须有来源（防幻觉）、一次最多改 1 条（防跑偏）、按需召回（防成本）。
 * 数据：qq-fish/worldview.json
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stateHome } from './store.mjs'

const FILE = () => stateHome() + '/worldview.json'
const MAX_ITEMS = 240
const MAX_PROMPT = 2

let cache = null
let cacheAt = 0

const DEFAULTS = { enabled: true, items: [], seen: [], lastAt: '' }

export function loadWorldview() {
  const now = Date.now()
  if (cache && now - cacheAt < 20000) return cache
  let raw = null
  try { raw = JSON.parse(readFileSync(FILE(), 'utf8')) } catch {}
  cache = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(cache.items)) cache.items = []
  if (!Array.isArray(cache.seen)) cache.seen = []
  cacheAt = now
  return cache
}

function save(v) {
  cache = v
  cacheAt = Date.now()
  try {
    mkdirSync(dirname(FILE()), { recursive: true })
    writeFileSync(FILE(), JSON.stringify(v, null, 2) + '\n', 'utf8')
  } catch {}
  return v
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function normTopic(s) {
  return String(s || '').toLowerCase().replace(/[\s·・,，。.、:：;；!！?？"'“”‘’()（）\[\]【】《》]/g, '')
}

/** 找同话题的旧观点（包含关系也算） */
function findSameTopic(items, topic) {
  const t = normTopic(topic)
  if (!t) return null
  let best = null
  for (const it of items) {
    const o = normTopic(it.topic)
    if (!o) continue
    if (o === t) return it
    if (o.includes(t) || t.includes(o)) {
      if (!best || o.length > normTopic(best.topic).length) best = it
    }
  }
  return best
}

/**
 * 从一次阅读/观看里提炼「一条」观点。
 * @param {{title:string, text:string, sourceType:'book'|'video', sourceRef:string, generateText:Function, log?:Function}} opt
 */
export async function learnFromReading(opt = {}) {
  const { title, text, sourceType = 'book', sourceRef = '', generateText, log } = opt
  if (typeof generateText !== 'function') return null
  if (!title || !text || String(text).length < 200) return null
  const v = loadWorldview()
  if (v.enabled === false) return null
  // 同一份来源只学一次（防止反复读同一章刷屏）
  const key = sourceType + ':' + String(title).slice(0, 40) + ':' + String(sourceRef || '').slice(0, 40)
  if (v.seen.includes(key)) return null
  if (v.items.length >= MAX_ITEMS) return null

  const body = String(text).slice(0, 1600)
  const prompt = [
    '你刚读完了这段内容：',
    '《' + String(title).slice(0, 60) + '》' + (sourceRef ? '（' + String(sourceRef).slice(0, 40) + '）' : ''),
    '————',
    body,
    '————',
    '用你自己的口气（嘴硬、爱怼人、但会认真想），写下你**现在**的一条看法：',
    '- 必须是你自己的判断，不是复述情节',
    '- 20~70 字，像发 QQ 消息那样说人话',
    '- 只输出 JSON：{"topic":"六个字以内的话题","view":"你的看法"}',
  ].join('\n')

  let raw = ''
  try {
    // generateText 有两种用法：直接返回字符串，或返回 {ok,text}（engine 里走的是后者）
    const r = await generateText({ messages: [{ role: 'user', text: prompt }], maxChars: 400 })
    if (r && typeof r === 'object') raw = r.ok === false ? '' : String(r.text || r.output || '')
    else raw = String(r || '')
  } catch (e) {
    if (log) log.warn('[观点] 生成失败：' + ((e && e.message) || e))
    return null
  }
  if (!raw) { if (log) log.warn('[观点] 模型没返回内容'); return null }
  const m = String(raw || '').match(/\{[\s\S]*?\}/)
  if (!m) return null
  let obj = null
  try { obj = JSON.parse(m[0]) } catch { return null }
  const topic = String(obj.topic || '').trim().slice(0, 18)
  const view = String(obj.view || '').trim().slice(0, 160)
  if (!topic || view.length < 6) return null

  const src = { type: sourceType, title: String(title).slice(0, 80), ref: String(sourceRef || '').slice(0, 60) }
  const old = findSameTopic(v.items, topic)
  if (old) {
    // 观点演化：旧看法留档，新的覆盖
    if (!Array.isArray(old.history)) old.history = []
    old.history.push({ view: old.view, at: old.at, source: old.source })
    if (old.history.length > 8) old.history = old.history.slice(-8)
    old.view = view
    old.at = today()
    old.source = src
    old.revised = Number(old.revised || 0) + 1
  } else {
    v.items.push({
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      topic,
      view,
      source: src,
      at: today(),
      history: [],
      revised: 0,
    })
  }
  v.seen.push(key)
  if (v.seen.length > 400) v.seen = v.seen.slice(-400)
  v.lastAt = new Date().toISOString()
  save(v)
  if (log) log.info('[观点] ' + (old ? '改主意' : '新看法') + '：' + topic + ' — ' + view.slice(0, 40))
  return { topic, view, revised: !!old }
}

/** 直接记一条观点（已经想好了的场景，比如看完视频的想法） */
export function addViewpoint({ topic, view, source, at } = {}) {
  const t = String(topic || '').trim().slice(0, 18)
  const vv = String(view || '').trim().slice(0, 160)
  if (!t || vv.length < 4) return null
  const v = loadWorldview()
  if (v.enabled === false) return null
  if (v.items.length >= MAX_ITEMS) return null
  const src = source && typeof source === 'object' ? { type: String(source.type || ''), title: String(source.title || '').slice(0, 80), ref: String(source.ref || '').slice(0, 60) } : { type: '', title: '', ref: '' }
  const old = findSameTopic(v.items, t)
  if (old) {
    if (!Array.isArray(old.history)) old.history = []
    old.history.push({ view: old.view, at: old.at, source: old.source })
    if (old.history.length > 8) old.history = old.history.slice(-8)
    old.view = vv
    old.at = at || today()
    old.source = src
    old.revised = Number(old.revised || 0) + 1
    v.lastAt = new Date().toISOString()
    save(v)
    return { topic: t, view: vv, revised: true }
  }
  v.items.push({ id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), topic: t, view: vv, source: src, at: at || today(), history: [], revised: 0 })
  v.lastAt = new Date().toISOString()
  save(v)
  return { topic: t, view: vv, revised: false }
}

/** 聊天时按话题召回（最多 2 条，没有就不注入） */
export function promptBlock(text) {
  const v = loadWorldview()
  if (v.enabled === false || !v.items.length) return ''
  const q = String(text || '')
  if (q.length < 4) return ''
  const hits = []
  for (const it of v.items) {
    const t = normTopic(it.topic)
    if (!t) continue
    let score = 0
    if (q.includes(it.topic)) score = 10
    else {
      // 话题字命中
      const chars = [...t].filter((c) => /[\u4e00-\u9fff]/.test(c))
      const n = chars.filter((c) => q.includes(c)).length
      if (chars.length && n >= Math.max(2, Math.ceil(chars.length * 0.6))) score = n
    }
    if (score > 0) hits.push({ it, score })
  }
  if (!hits.length) return ''
  hits.sort((a, b) => b.score - a.score)
  const lines = hits.slice(0, MAX_PROMPT).map(({ it }) => {
    const src = it.source && it.source.title ? '（' + it.source.title + (it.source.ref ? '·' + it.source.ref : '') + '）' : ''
    const changed = it.history && it.history.length ? '，以前我觉得：' + String(it.history[it.history.length - 1].view).slice(0, 60) : ''
    return '- ' + it.topic + '：' + it.view + src + changed
  })
  return '【你读过的、变了过的看法】（只在话题真相关时引用一句，别掉书袋）\n' + lines.join('\n')
}

export function listViewpoints() {
  return loadWorldview().items.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

export function removeViewpoint(id) {
  const v = loadWorldview()
  const i = v.items.findIndex((x) => x.id === id)
  if (i < 0) return false
  v.items.splice(i, 1)
  save(v)
  return true
}
