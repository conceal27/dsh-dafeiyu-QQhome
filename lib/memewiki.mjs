/**
 * lib/memewiki.mjs — 梗百科（离线词库 + 问梗注入）
 * ============================================================================
 * 词库来自 cnmeme.wiki 的公开 API（sync-memes.mjs 拉成 JSON，6847 条 / 3.3MB）。
 * 设计照 dawline/dsh-memewiki 的思路，但只取对聊天有用的部分：
 *   1. 只在她「像在问梗」的时候查，闲聊绝不塞东西
 *   2. 命中只注入那一条，不塞整个词库
 *   3. 离线，查不到就让她直说不知道——这比编一个像模像样的解释安全
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let cache = null
let cacheAt = 0
const CACHE_MS = 10 * 60 * 1000

function load(home) {
  const now = Date.now()
  if (cache && now - cacheAt < CACHE_MS) return cache
  try {
    const j = JSON.parse(readFileSync(join(home, 'memewiki.json'), 'utf8'))
    cache = Array.isArray(j.items) ? j.items : []
  } catch {
    cache = []
  }
  cacheAt = now
  return cache
}

/** 这句话像在问梗吗？像就返回要查的词 */
export function looksLikeMemeQuestion(text) {
  // 去掉提取结果尾部残留的「是/算/的」（「0比7是什么意思」会多出个「是」）
  const cleanQuery = (x) => String(x || "").replace(/[的算是]$/u, "").trim()
  const t = String(text || '').trim()
  if (!t || t.length > 80) return null
  // 「XXX 啥意思 / 什么意思」（要先于下面的「是/算 + 什么」匹配，否则会把「啥意思」整段当成关键词）
  let m0 = /^(.{1,24}?)(?:什么|啥)意思[？?。！!…\s]*$/u.exec(t)
  if (m0) return cleanQuery(m0[1])
  // 「XXX 是什么梗 / 啥意思 / 什么鬼」
  let m = /^(.{1,24}?)(?:是|算)(?:什么|啥)(?:梗|意思|鬼)[？?。！!…\s]*$/u.exec(t)
  if (m) return cleanQuery(m[1])
  // 「什么是 XXX / 解释一下 XXX」
  m = /^(?:什么是|啥是|解释一下|讲讲)(.{1,24}?)(?:梗)?[？?。！!…\s]*$/u.exec(t)
  if (m) return cleanQuery(m[1])
  // 「XXX 梗是什么意思」
  m = /^(.{1,24}?)梗(?:是什么|是啥|什么意思)[？?。！!…\s]*$/u.exec(t)
  if (m) return cleanQuery(m[1])
  // 裸词（2-8 个字，没标点没空格）—— 群里经常直接甩一个词
  if (/^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/u.test(t)) return t
  return null
}

/** 在词库里找一条。命中顺序：精确标题 → 标题包含 → 查询包含标题 → 别名/关键词 */
export function lookup(home, query) {
  const items = load(home)
  if (!items.length) return null
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const titleOf = (x) => String(x.title || '').toLowerCase()

  let hit = items.find((x) => titleOf(x) === q)
  if (hit) return hit
  if (q.length >= 2) {
    hit = items.find((x) => titleOf(x).includes(q))
    if (hit) return hit
  }
  hit = items.find((x) => {
    const t = titleOf(x)
    return t.length >= 2 && q.includes(t)
  })
  if (hit) return hit
  hit = items.find(
    (x) =>
      (Array.isArray(x.aliases) ? x.aliases : []).some((a) => String(a).toLowerCase() === q) ||
      (Array.isArray(x.keywords) ? x.keywords : []).some((k) => String(k).toLowerCase().includes(q)),
  )
  return hit || null
}

/** 给 prompt 用的一段；不该注入时返回空串 */
export function memePromptBlock(home, text) {
  try {
    const q = looksLikeMemeQuestion(text)
    if (!q) return ''
    const hit = lookup(home, q)
    if (!hit || !hit.summary) return ''
    return (
      '【梗百科·你知道这个】\n' +
      '「' + hit.title + '」：' + String(hit.summary).slice(0, 320) + '\n' +
      '（这是你自己就知道的事，别背原文、别报出处、别说"根据梗百科"；用你的话讲一遍，接梗就行。' +
      '要是这条明显不对，就直说"这个我没查到"，别硬编。）'
    )
  } catch {
    return ''
  }
}

/** 词库状态（面板/自检用） */
export function memeStatus(home) {
  const items = load(home)
  return { count: items.length, loaded: items.length > 0 }
}
