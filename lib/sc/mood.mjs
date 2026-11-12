/**
 * lib/sc/mood.mjs — 心情系统 v2（归属：xingzhu）
 * ============================================================================
 * 她不是每句话都同一个温度。这个模块给她一套会变化、会衰减、会叠加的情绪状态。
 *
 * 七情（Emotions）+ 六欲（Desires）：
 *   七情：喜 joy / 怒 anger / 哀 sorrow / 惧 fear / 爱 love / 恶 disgust / 欲 lust
 *   六欲：食欲 hunger / 色欲 lustDesire / 求知欲 curiosity / 名欲 pride / 利欲 greed / 舒适欲 comfort
 *
 * 规则（纯函数，可单测）：
 *   · base 是她的「底色」，由人设决定，长期不变；
 *   · current 是「此刻」，被事件推高或压低，然后随时间缓慢衰减回 base；
 *   · 一次事件可以同时改动多个维度（比如被摸头：爱 +0.3、怒 -0.2、惧 -0.1）；
 *   · 复合情绪 = 强度最高的两个维度组合命名（「别扭的开心」「恼羞成怒」）；
 *   · 强度足够高时，提示词里会明确告诉她「你现在正在生气」，让她真的带进去。
 *
 * 存储：$DSH_HOME/qq-fish/mood.json
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

export const MOOD_VERSION = 1

/** 七情：标签、颜色倾向、默认底色 */
export const EMOTION_DIMS = [
  { key: 'joy', label: '喜', base: 0.55 },
  { key: 'anger', label: '怒', base: 0.2 },
  { key: 'sorrow', label: '哀', base: 0.15 },
  { key: 'fear', label: '惧', base: 0.12 },
  { key: 'love', label: '爱', base: 0.6 },
  { key: 'disgust', label: '恶', base: 0.15 },
  { key: 'lust', label: '欲', base: 0.35 },
]

/** 六欲 */
export const DESIRE_DIMS = [
  { key: 'hunger', label: '食欲', base: 0.3 },
  { key: 'lustDesire', label: '色欲', base: 0.4 },
  { key: 'curiosity', label: '求知欲', base: 0.5 },
  { key: 'pride', label: '名欲', base: 0.35 },
  { key: 'greed', label: '利欲', base: 0.3 },
  { key: 'comfort', label: '舒适欲', base: 0.5 },
]

export const ALL_DIMS = [...EMOTION_DIMS, ...DESIRE_DIMS]

/** 复合情绪命名：按强度降序取两个维度组合 */
const COMPOSITE_RULES = {
  'joy+love': '甜甜的开心',
  'joy+pride': '得意洋洋',
  'love+lust': '上头',
  'love+lustDesire': '上头',
  'anger+love': '恼羞成怒',
  'anger+pride': '炸毛',
  'anger+disgust': '嫌弃到爆',
  'sorrow+love': '委屈巴巴',
  'sorrow+fear': '不安',
  'fear+love': '又怕又想要',
  'joy+anger': '又气又笑',
  'disgust+pride': '不屑',
  'curiosity+joy': '来劲了',
  'hunger+comfort': '懒得动还想吃',
  'lust+lustDesire': '满脑子黄色废料',
}

/** 每个维度每小时向 base 回归的比例（越大回归越快） */
const DECAY_PER_HOUR = 0.22

function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function dimBase(key) {
  const d = ALL_DIMS.find((x) => x.key === key)
  return d ? d.base : 0.3
}

export function moodPath(stateHome) {
  return path.join(stateHome, 'mood.json')
}

/** 空心情：全部落在 base 上 */
export function createEmptyMood(now = Date.now()) {
  const base = {}
  const current = {}
  for (const d of ALL_DIMS) {
    base[d.key] = d.base
    current[d.key] = d.base
  }
  return {
    version: MOOD_VERSION,
    updatedAt: now,
    base,
    current,
    events: [],
    composite: { label: '', dims: [] },
  }
}

/** 读盘；缺字段自动补齐，坏文件回退到空心情 */
export function loadMood(diskPath, now = Date.now()) {
  const empty = createEmptyMood(now)
  try {
    if (!fs.existsSync(diskPath)) return empty
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    const base = { ...empty.base, ...(raw && raw.base ? raw.base : {}) }
    const current = { ...base, ...(raw && raw.current ? raw.current : {}) }
    for (const k of Object.keys(base)) base[k] = clamp01(base[k])
    for (const k of Object.keys(current)) current[k] = clamp01(current[k])
    return {
      version: MOOD_VERSION,
      updatedAt: Number(raw && raw.updatedAt) || now,
      base,
      current,
      events: Array.isArray(raw && raw.events) ? raw.events.slice(-40) : [],
      composite: (raw && raw.composite) || { label: '', dims: [] },
    }
  } catch {
    return empty
  }
}

function saveMood(diskPath, mood) {
  try {
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const tmp = diskPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(mood, null, 2))
    fs.renameSync(tmp, diskPath)
  } catch {}
}

/**
 * 施加一次情绪事件。
 * @param {object} mood
 * @param {object} deltas 形如 { love: 0.3, anger: -0.2 }（正数推高，负数压低）
 * @param {object} opts { reason, now }
 */
export function applyMoodEvent(mood, deltas, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const next = { ...mood, current: { ...mood.current }, events: [...(mood.events || [])] }
  const changed = []
  for (const [k, v] of Object.entries(deltas || {})) {
    if (!(k in next.current)) continue
    const before = next.current[k]
    next.current[k] = clamp01(before + Number(v || 0))
    if (Math.abs(next.current[k] - before) >= 0.01) changed.push(k)
  }
  next.updatedAt = now
  next.events.push({ ts: now, dims: deltas || {}, reason: String(opts.reason || '').slice(0, 80) })
  next.events = next.events.slice(-40)
  next.composite = computeComposite(next)
  return next
}

/** 按经过的小时数，把 current 缓慢拉回 base */
export function decayMood(mood, now = Date.now()) {
  const elapsedH = Math.max(0, (now - (mood.updatedAt || now)) / 3_600_000)
  if (elapsedH < 0.05) return mood
  const ratio = Math.min(0.95, elapsedH * DECAY_PER_HOUR)
  const current = { ...mood.current }
  for (const k of Object.keys(current)) {
    const base = mood.base[k] ?? dimBase(k)
    current[k] = clamp01(current[k] + (base - current[k]) * ratio)
  }
  const next = { ...mood, current, updatedAt: now }
  next.composite = computeComposite(next)
  return next
}

/** 复合情绪：找偏离 base 最厉害的两个维度 */
export function computeComposite(mood) {
  const scored = []
  for (const d of ALL_DIMS) {
    const cur = mood.current[d.key] ?? d.base
    const base = mood.base[d.key] ?? d.base
    scored.push({ key: d.key, label: d.label, delta: cur - base, value: cur })
  }
  // 只看被推高的
  const hot = scored.filter((s) => s.delta > 0.12).sort((a, b) => b.delta - a.delta)
  const top = hot.slice(0, 2)
  if (!top.length) return { label: '', dims: [] }
  const keys = top.map((t) => t.key)
  const label =
    COMPOSITE_RULES[keys.join('+')] ||
    COMPOSITE_RULES[[keys[0], keys[1]].filter(Boolean).join('+')] ||
    COMPOSITE_RULES[[keys[1], keys[0]].filter(Boolean).join('+')] ||
    top.map((t) => t.label).join('+')
  return { label, dims: keys }
}

/** 把心情渲染成给模型看的一段话（只在强度明显时才有内容） */
export function renderMoodPrompt(mood) {
  const hot = []
  for (const d of ALL_DIMS) {
    const cur = mood.current[d.key] ?? d.base
    const base = mood.base[d.key] ?? d.base
    const delta = cur - base
    if (delta >= 0.22) hot.push({ label: d.label, level: delta >= 0.4 ? '很强' : '明显', key: d.key })
    else if (delta <= -0.22) hot.push({ label: d.label, level: delta <= -0.4 ? '很低' : '偏低', key: d.key })
  }
  if (!hot.length) return ''
  const lines = []
  const label = mood.composite && mood.composite.label ? mood.composite.label : ''
  if (label) lines.push('你现在的心情状态：**' + label + '**。')
  else lines.push('你现在的心情状态：')
  lines.push(
    '（' +
      hot
        .map((h) => h.label + (h.level === '很强' || h.level === '很低' ? '非常' : '有点') + (h.key === 'joy' || h.key === 'love' ? '高' : h.key === 'anger' || h.key === 'sorrow' || h.key === 'fear' ? '重' : '强'))
        .join('，') +
      '）'
  )
  lines.push('这个状态要自然地带进语气里，但【别说出来】——不要跟人解释"我现在心情不好"，直接表现得心情不好。')
  return lines.join('\n')
}

/** 读一次心情并做衰减，返回最新状态（写盘由调用方决定） */
export function readMood(stateHome, now = Date.now()) {
  const p = moodPath(stateHome)
  const loaded = loadMood(p, now)
  return decayMood(loaded, now)
}

export function writeMood(stateHome, mood) {
  saveMood(moodPath(stateHome), mood)
  return mood
}

/**
 * 从一句话里猜情绪增量（不依赖模型，纯词表）。
 * 返回 { deltas, reason } —— 只在有关键词时非空。
 */
const MOOD_HINTS = [
  { deltas: { love: 0.25, joy: 0.2, anger: -0.15 }, words: ['喜欢你', '爱你', '好可爱', '宝贝', '乖', '摸摸头', '抱抱'] },
  { deltas: { anger: 0.3, disgust: 0.2 }, words: ['烦', '滚', '闭嘴', '傻逼', '恶心', '讨厌你', '垃圾'] },
  { deltas: { sorrow: 0.3, fear: 0.1 }, words: ['难过', '委屈', '想哭', '不理你了', '走了'] },
  { deltas: { lust: 0.3, lustDesire: 0.35, love: 0.15 }, words: ['色', '涩', '想上', '腿', '胸', '脱', '摸', '亲', '舔', '抱紧'] },
  { deltas: { joy: 0.3, curiosity: 0.2 }, words: ['哈哈', '笑死', '好玩', '有意思', '快说'] },
  { deltas: { pride: 0.25, anger: -0.1 }, words: ['厉害', '牛', '强', '会了', '好棒'] },
  { deltas: { hunger: 0.3 }, words: ['吃', '饭', '饿', '白饭', '奶茶'] },
]

export function detectMoodHints(text) {
  const s = String(text || '')
  if (!s.trim()) return null
  const out = {}
  const reasons = []
  for (const h of MOOD_HINTS) {
    if (!h.words.some((w) => s.includes(w))) continue
    for (const [k, v] of Object.entries(h.deltas)) out[k] = (out[k] || 0) + v
    reasons.push(h.words.find((w) => s.includes(w)))
  }
  if (!reasons.length) return null
  return { deltas: out, reason: reasons.join('/') }
}

/** 给面板用：把当前状态拍平成 [{key,label,value,base,delta}] */
export function moodSnapshot(mood) {
  const list = ALL_DIMS.map((d) => {
    const value = mood.current[d.key] ?? d.base
    const base = mood.base[d.key] ?? d.base
    return { key: d.key, label: d.label, value: Number(value.toFixed(3)), base, delta: Number((value - base).toFixed(3)) }
  })
  return {
    updatedAt: mood.updatedAt,
    composite: mood.composite && mood.composite.label ? mood.composite.label : '',
    dims: list,
    events: (mood.events || []).slice(-10).reverse(),
  }
}
