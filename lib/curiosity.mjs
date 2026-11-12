/**
 * lib/curiosity.mjs — 好奇心：她会攒「没搞懂的东西」，然后自己找机会问
 * ============================================================================
 * 不是随机搭话。是真的有一个「我一直在想这个」的队列：
 *   - 模型在回复里写 [curious:某个词] → 直接记下来
 *   - 每日扫描最近对话，挑出反复出现、但她记忆里没有的词 → 记下来
 * 攒够了（>=2）才会问；问过就标记，不会反复唠叨。
 * 数据：qq-fish/curiosity.json
 * ============================================================================
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const FILE = join(stateHome(), 'curiosity.json')

const DEFAULTS = {
  enabled: true,
  items: [], // { id, word, why, source, createdAt, askedAt, asked }
  lastScanDate: '',
  askedTotal: 0,
}

let cache = null
let cacheAt = 0

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 这些词不算「没搞懂」：语气词、代词、常见虚词
const STOP = new Set([
  '哈哈哈', '什么', '怎么', '为什么', '这个', '那个', '我们', '你们', '他们',
  '可以', '不是', '就是', '真的', '没有', '知道', '觉得', '现在', '时候', '东西', '事情',
  '一下', '一点', '一直', '已经', '还是', '然后', '所以', '因为', '但是', '如果', '而且',
  '自己', '别人', '大家', '今天', '明天', '昨天', '早上', '晚上', '中午', '半夜',
  '大肥鱼', '肥鱼', '主人', '群主', '管理', '图片', '表情', '语音', '视频', '截图',
  '哈哈', '嘿嘿', '啊啊', '嗯嗯', '好好', '行吧', '好吧', '对啊', '是啊', '干嘛', '咋了',
])
// 明显不是「好奇对象」的词：媒体/操作/寒暄
const BAD_WORD = /(图片|表情|语音|视频|转发|截图|刚才|已经|一直|就是|不是|可以|我们|你们|他们|这个|那个|什么|怎么|为什么)/

export async function loadCuriosity() {
  const now = Date.now()
  if (cache && now - cacheAt < 30_000) return cache
  let raw = null
  try { raw = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
  cache = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(cache.items)) cache.items = []
  cacheAt = now
  return cache
}

async function save(c) {
  cache = c
  cacheAt = Date.now()
  try { await writeFile(FILE, JSON.stringify(c, null, 2) + '\n', 'utf8') } catch {}
  return c
}

/** 记一个她没搞懂的东西 */
export async function addCuriosity(word, { why = '', source = 'chat' } = {}) {
  const w = String(word || '').trim().slice(0, 20)
  if (!w || w.length < 2) return null
  const c = await loadCuriosity()
  if (c.items.some((it) => it.word === w && !it.asked)) return null // 已经在队列里
  const item = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word: w,
    why: String(why || '').slice(0, 120),
    source,
    createdAt: Date.now(),
    askedAt: 0,
    asked: false,
  }
  c.items.push(item)
  // 队列最多留 20 条，丢掉最早问过的
  if (c.items.length > 20) {
    const asked = c.items.filter((x) => x.asked).sort((a, b) => a.askedAt - b.askedAt)
    const drop = new Set(asked.slice(0, c.items.length - 20).map((x) => x.id))
    c.items = c.items.filter((x) => !drop.has(x.id))
  }
  await save(c)
  return item
}

/**
 * 规则版扫描（默认关闭）。
 * 试过用词频 + 人设词过滤，但中文没有分词会切出「杂鱼主」这种半截词，
 * 质量不够反而干扰。现在好奇心只从两个高质量来源来：
 *   1. 模型在回复里自己写 [curious:词]（她真的没搞懂）
 *   2. 面板里手动加
 * 保留这个函数是为了以后接分词/小模型时能开回来。
 */
export async function scanCuriosity({ messages = [], knownWords = new Set(), maxAdd = 3 } = {}) {
  const c = await loadCuriosity()
  if (c.enabled === false) return []
  // 规则扫描默认关闭：质量不够，见函数上方注释
  if (c.scanEnabled !== true) return []
  const today = todayStr()
  if (c.lastScanDate === today) return []
  const counts = new Map()
  for (const m of messages) {
    const t = String((m && m.text) || '')
    if (!t || t.length < 4) continue
    if (/^\[(图片|表情|语音|视频|转发)\]/.test(t)) continue
    // 提取 2-4 个连续汉字
    for (const seg of t.split(/[^\u4e00-\u9fa5]+/)) {
      if (seg.length < 2) continue
      for (let len = 2; len <= Math.min(4, seg.length); len++) {
        for (let i = 0; i + len <= seg.length; i++) {
          const w = seg.slice(i, i + len)
          if (STOP.has(w) || BAD_WORD.test(w)) continue
          counts.set(w, (counts.get(w) || 0) + 1)
        }
      }
    }
  }
  // 出现 >= 4 次、不在已知词里、也不是已记录的
  const known = new Set([...(knownWords || []), ...c.items.map((x) => x.word)])
  const sorted = [...counts.entries()]
    .filter(([w, n]) => n >= 4 && !known.has(w) && w.length >= 2)
    .sort((a, b) => b[1] - a[1])
  // 去掉互为子串的（「杂鱼」「鱼主」「杂鱼主」只留最长的那个）
  const picked = []
  for (const [w, n] of sorted) {
    if (picked.some((p) => p.includes(w) || w.includes(p))) continue
    picked.push([w, n])
    if (picked.length >= maxAdd) break
  }
  const fresh = picked

  const added = []
  for (const [w, n] of fresh) {
    const item = await addCuriosity(w, { why: `最近出现 ${n} 次`, source: 'scan' })
    if (item) added.push(item)
  }
  c.lastScanDate = today
  await save(c)
  return added
}

/** 当前「她一直在想」的那几条（未问过的），注入提示词用 */
export async function pendingCuriosity(limit = 3) {
  const c = await loadCuriosity()
  if (c.enabled === false) return []
  return c.items.filter((x) => !x.asked).slice(-limit)
}

/** 挑一条来问 */
export async function pickCuriosity() {
  const list = await pendingCuriosity(5)
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

export async function markAsked(id) {
  const c = await loadCuriosity()
  const it = c.items.find((x) => x.id === id)
  if (!it) return
  it.asked = true
  it.askedAt = Date.now()
  c.askedTotal = (Number(c.askedTotal) || 0) + 1
  await save(c)
}

/** 注入给模型的「你最近一直在琢磨这些」 */
export async function curiosityPromptBlock() {
  const list = await pendingCuriosity(3)
  if (!list.length) return ''
  const lines = list.map((x) => `- 「${x.word}」${x.why ? '（' + x.why + '）' : ''}`)
  return '【你最近一直在琢磨的事】\n' +
    lines.join('\n') +
    '\n这些是你没完全搞懂、心里一直惦记着的东西。合适的时候可以主动问一句——' +
    '但别像查词表那样一次问一串，一次最多问一个，而且要在话赶话的时候自然问出来；不合适的场合就继续憋着。'
}

/** 面板用 */
export async function curiositySnapshot() {
  const c = await loadCuriosity()
  return {
    enabled: c.enabled !== false,
    items: c.items.slice(-12).reverse(),
    pending: c.items.filter((x) => !x.asked).length,
    askedTotal: c.askedTotal || 0,
    lastScanDate: c.lastScanDate || '',
  }
}

export async function clearCuriosity(id) {
  const c = await loadCuriosity()
  c.items = id ? c.items.filter((x) => x.id !== id) : []
  await save(c)
  return curiositySnapshot()
}
