/**
 * lib/reply-guard.mjs — 回复的三道保险（归属：xingzhu）
 * ============================================================================
 * 只做纯字符串/纯数据计算，不碰 IO、不发网络请求，方便离线测试。
 *
 *   1. 认人：从最近聊天里整理出「名字 → QQ 号」的花名册；
 *   2. @ 人：识别「对方让你 @ 谁」，并把模型写的 @名字 / [at:名字] 换成真的 [at:QQ号]；
 *      对方明确要求 @ 而回复里没有 @ 时，由 engine 补在最前面；
 *   3. 别重复：拿这一次的回复和她最近说过的话比相似度，太像就让 engine 重写一次。
 * ============================================================================
 */

/** 去掉空白/标点/符号，只留有效字符（比较用） */
export function normText(text) {
  return String(text || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

function bigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  if (!set.size && s.length) set.add(s)
  return set
}

/** 中文 2-gram Jaccard 相似度（0~1） */
export function similarity(a, b) {
  const x = normText(a)
  const y = normText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const A = bigrams(x)
  const B = bigrams(y)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const union = A.size + B.size - inter
  return union > 0 ? inter / union : 0
}

/**
 * 在「她最近说过的话」里找重复。
 * @param {string} text 这次生成的回复
 * @param {Array<{text?:string}|string>} previous 最近说过的话
 * @param {object} options { threshold }
 * @returns {{text:string, score:number}|null}
 */
export function findRepeat(text, previous, options = {}) {
  const threshold = Number(options.threshold) || 0.52
  const t = normText(text)
  if (t.length < 6) return null
  const prevList = (Array.isArray(previous) ? previous : []).slice(0, 8)
  let best = null
  for (const prev of prevList) {
    const raw = prev && typeof prev === 'object' ? prev.text : prev
    const p = normText(raw)
    if (!p || p.length < 6) continue
    const score = similarity(t, p)
    if (score >= threshold) {
      if (!best || score > best.score) best = { text: String(raw), score }
      continue
    }
    // 换个说法还是同一个意思：开头一样 + 半句重合
    if (t.slice(0, 8) === p.slice(0, 8) && score >= 0.3) {
      if (!best || score > best.score) best = { text: String(raw), score }
    }
  }
  // 同一件事被揪着不放：最近 4 条里有 2 条都和这次高度相关
  if (!best) {
    let hits = 0
    let sample = ''
    for (const prev of prevList.slice(0, 4)) {
      const raw = prev && typeof prev === 'object' ? prev.text : prev
      if (similarity(t, raw) >= 0.42) {
        hits += 1
        if (!sample) sample = String(raw)
      }
    }
    if (hits >= 2) return { text: sample, score: 0.42 }
  }
  return best
}

/** 名字 → QQ 花名册：从最近聊天（和她引用到的人）里整理，靠后的更新 */
export function rosterFromHistory(history, extra = []) {
  const map = new Map()
  const add = (name, qq) => {
    const id = String(qq || '').replace(/\D/g, '')
    if (!/^\d{5,12}$/.test(id)) return
    const label = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24) || id
    map.set(label + '\u0000' + id, { name: label, qq: id })
  }
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || m.role === 'assistant') continue
    if (!m.senderId) continue
    add(m.who, m.senderId)
  }
  for (const e of Array.isArray(extra) ? extra : []) {
    if (!e) continue
    add(e.name, e.qq)
  }
  const list = [...map.values()]
  // 只留最近出现的 24 个，避免提示词膨胀
  return list.slice(-24)
}

const ASK_AT = /(艾特|圈一下|圈我|叫一下|叫上|喊一下|喊上|提醒一下|提醒他|提醒她)/

function escapeReg(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 对方是不是明确让我们 @ 某人？
 * 两种信号：① 出现「艾特/圈/叫一下…」这类动词 + 花名册里的名字；② 直接写「@名字」。
 * 注意排除自己（@她那条消息本身会带 @她的QQ号，那不是「让她@人」）。
 * @returns {Array<{name:string, qq:string}>}
 */
export function detectAtRequest(text, roster, selfId = '') {
  const raw = String(text || '')
  if (!raw) return []
  const self = String(selfId || '')
  const list = (Array.isArray(roster) ? roster : []).filter((r) => r && r.qq && String(r.qq) !== self)
  const asked = ASK_AT.test(raw)
  const out = []
  const push = (name, qq) => {
    const id = String(qq || '')
    if (!id || id === self) return
    if (out.some((x) => x.qq === id)) return
    out.push({ name: String(name || ''), qq: id })
  }
  for (const r of list) {
    const name = String(r.name || '')
    if (name.length < 2) continue
    if (raw.includes('@' + name) || raw.includes('＠' + name)) push(name, r.qq)
  }
  if (asked) {
    for (const r of list) {
      const name = String(r.name || '')
      if (name.length < 2) continue
      if (raw.includes(name)) push(name, r.qq)
    }
    if (/(全体成员|全体|所有人|全员)/.test(raw)) push('全体', 'all')
  }
  return out.slice(0, 4)
}

/**
 * 把模型写的 @ 记号规范成 [at:QQ号]：
 *   · [at:名字] / [at:名字（123）] → [at:123]
 *   · @名字（花名册里的人）→ [at:123]
 *   · 认不出的 [at:xxx] 直接删掉，绝不让占位符漏进 QQ
 * 已经是数字的 [at:123] 原样保留。
 */
export function fixAtTokens(text, roster) {
  const list = Array.isArray(roster) ? roster : []
  const resolve = (rawRef) => {
    const raw = String(rawRef || '').trim()
    if (/^\d{5,12}$/.test(raw)) return raw
    if (/^(all|全体|全体成员|所有人)$/i.test(raw)) return 'all'
    const name = raw.replace(/[（(][^）)]*[）)]/g, '').trim()
    const num = raw.match(/[（(](\d{5,12})[）)]/)
    if (num) return num[1]
    if (!name) return ''
    const exact = list.find((r) => String(r.name || '') === name)
    if (exact) return String(exact.qq)
    const fuzzy = list.find((r) => {
      const n = String(r.name || '')
      return n.length >= 2 && (n.includes(name) || name.includes(n))
    })
    return fuzzy ? String(fuzzy.qq) : ''
  }
  let out = String(text || '')
  out = out.replace(/\[at:\s*([^\]]{1,30})\]/g, (whole, ref) => {
    const qq = resolve(ref)
    return qq ? `[at:${qq}]` : ''
  })
  // @名字 → [at:QQ]（只认花名册，避免把普通文字里的 @ 也改了）
  for (const r of list) {
    const name = String(r.name || '')
    if (name.length < 2) continue
    const re = new RegExp('[@＠]\\s*' + escapeReg(name) + '(?!\\d)', 'g')
    out = out.replace(re, `[at:${r.qq}]`)
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 统计一条回复里有哪些 @（给日志用） */
export function atTargetsIn(text) {
  const out = []
  const re = /\[at:(\d{5,12}|all)\]/g
  let m
  while ((m = re.exec(String(text || '')))) out.push(m[1])
  return out
}
