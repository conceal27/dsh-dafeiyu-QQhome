/**
 * lib/reading.mjs — 她自己读书（每天挑一本，读一段，写看法）
 * ============================================================================
 * 为什么要有：L2 观点层只有"被喂"的时候才会动，那样不叫自我迭代。
 * 这里让她像刷 B 站一样，自己去书架挑一本没读过的公版书，读一段，写一条看法。
 * 读完的记录（书名/字数/观点）写 qq-fish/reading-log.json，不演。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { stateHome } from './store.mjs'
import { readEpubUrl, searchGutenberg, ensureZhCatalog } from './books.mjs'
import { learnFromReading } from './worldview.mjs'
import { addMemory } from './memory-decay.mjs'
import { generateText } from './llm.mjs'

const LOG = () => stateHome() + '/reading-log.json'
const MAX_ITEMS = 200

/** 优先读的中文经典（书源里有的） */
const PREFER = ['紅樓夢', '西遊記', '三國', '水滸', '論語', '詩經', '道德經', '莊子', '史記', '聊齋', '儒林外史', '楚辭', '唐詩', '宋詞']

export function loadReadingLog() {
  try {
    const j = JSON.parse(readFileSync(LOG(), 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [], lastAt: Number(j.lastAt || 0) }
  } catch {
    return { items: [], lastAt: 0 }
  }
}

function saveReadingLog(v) {
  if (v.items.length > MAX_ITEMS) v.items = v.items.slice(-MAX_ITEMS)
  try { writeFileSync(LOG(), JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
  return v
}

/** 挑一本没读过的（优先经典，其次任意中文公版） */
async function pickBook() {
  const log = loadReadingLog()
  const read = new Set(log.items.map((x) => x.title))
  let books = []
  try { books = await ensureZhCatalog() } catch {}
  if (!books.length) {
    // 兜底：现搜一本
    const hit = await searchGutenberg('紅樓夢').catch(() => [])
    books = hit
  }
  const withEpub = books.filter((b) => b && b.epub && b.title && !read.has(b.title))
  if (!withEpub.length) return null
  // 经典优先
  for (const key of PREFER) {
    const hit = withEpub.find((b) => String(b.title).includes(key))
    if (hit) return hit
  }
  return withEpub[Math.floor(Math.random() * withEpub.length)]
}

/**
 * 读一本、写一条看法。
 * @param {{ctx:any, config:any, log:any}} opt
 */
export async function readOne({ ctx, config, log } = {}) {
  const v = loadReadingLog()
  const book = await pickBook()
  if (!book) return { ok: false, error: '书架空了（中文公版书都读完了）' }
  const title = String(book.title).slice(0, 60)
  if (log) log.info('[读书] 挑了一本：' + title)
  // 【读多少由状态决定，不掷骰子】深夜/困倦少读，白天精神好多读
  let want = 5200
  try {
    const hr = new Date().getHours()
    want = (hr >= 23 || hr < 7) ? 2800 : (hr >= 9 && hr < 18 ? 6000 : 4200)
    const needs = JSON.parse(readFileSync(stateHome() + '/needs.json', 'utf8'))
    const tired = (needs.items || []).find((x) => x && x.key === 'tired')
    if (tired && Number(tired.level) >= 60) want = Math.min(want, 2200)
  } catch {}
  const rd = await readEpubUrl(book.epub, stateHome(), want).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  if (!rd || !rd.ok || !rd.text) {
    if (log) log.warn('[读书] 《' + title + '》读不了：' + ((rd && rd.error) || '空'))
    return { ok: false, error: '《' + title + '》读不了：' + ((rd && rd.error) || '空') }
  }
  const text = String(rd.text).slice(0, want)
  const chars = text.length
  if (chars < 400) return { ok: false, error: '《' + title + '》正文太短（' + chars + ' 字）' }

  // 生成一条看法（带来源）
  let view = null
  try {
    view = await learnFromReading({
      title,
      text,
      sourceType: 'book',
      sourceRef: '',
      generateText: (o) => generateText(ctx, { ...o, config, log: (l) => (log && log.warn ? log.warn(l) : undefined) }),
      log,
    })
  } catch (e) {
    if (log) log.warn('[读书] 观点生成失败：' + ((e && e.message) || e))
  }

  const item = {
    title,
    author: String(book.author || '').slice(0, 40),
    url: book.page || '',
    chars,
    at: Date.now(),
    topic: view ? view.topic : '',
    view: view ? view.view : '',
  }
  v.items.push(item)
  v.lastAt = Date.now()
  saveReadingLog(v)
  // 进长期记忆（她"读过"这件事）
  try {
    addMemory('读完《' + title + '》的一部分（' + chars + ' 字）' + (view ? '，新看法：' + String(view.view).slice(0, 80) : ''), { importance: 58, config })
  } catch {}
  if (log) log.info('[读书] 《' + title + '》读完 ' + chars + ' 字' + (view ? '，看法：' + String(view.view).slice(0, 40) : '（没生成看法）'))
  return { ok: true, item, view }
}
