/**
 * lib/sc/promise.mjs — 承诺机制（归属：xingzhu）
 * ============================================================================
 * 她说过「等下给你讲」「明天告诉你」「我记住了」这类话，要真的记住并兑现。
 * 没有这个机制，AI 的承诺就是随口一说，说完全忘——这是最伤人的地方。
 *
 * 规则：
 *   · 只要她说了带「会/要/等/明天/下次」且有明确对象的承诺，就登记；
 *   · 承诺会出现在她的提示词里，提醒她「你答应过这个」；
 *   · 到期没兑现 → 提示词里加重语气，让她自己解释；
 *   · 兑现后标记完成，留在列表里当「我做到了」的证据。
 *
 * 存储：$DSH_HOME/qq-fish/promises.json
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

export const PROMISE_VERSION = 1

export function promisesPath(stateHome) {
  return path.join(stateHome, 'promises.json')
}

export function createEmptyPromises() {
  return { version: PROMISE_VERSION, items: [] }
}

export function loadPromises(diskPath) {
  try {
    if (!fs.existsSync(diskPath)) return createEmptyPromises()
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    return {
      version: PROMISE_VERSION,
      items: Array.isArray(raw && raw.items) ? raw.items : [],
    }
  } catch {
    return createEmptyPromises()
  }
}

export function savePromises(diskPath, data) {
  try {
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const tmp = diskPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, diskPath)
  } catch {}
}

/**
 * 登记一条承诺。
 * @param {object} data
 * @param {object} p { text, dueAt?, source?, conversation? }
 */
export function addPromise(data, p) {
  const now = Date.now()
  const text = String((p && p.text) || '').trim().slice(0, 300)
  if (!text) return data
  // 去重：同样的文本还没完成就不重复加
  if ((data.items || []).some((it) => it.text === text && it.status === 'pending')) return data
  const item = {
    id: 'p-' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    text,
    dueAt: Number(p && p.dueAt) || 0,
    status: 'pending',
    source: String((p && p.source) || 'chat'),
    conversation: String((p && p.conversation) || ''),
    createdAt: now,
    doneAt: 0,
    remindedAt: 0,
  }
  const next = { ...data, items: [...(data.items || []), item] }
  // 只留最近 300 条
  next.items = next.items.slice(-300)
  return next
}

export function pendingPromises(data) {
  return (data.items || []).filter((it) => it.status === 'pending')
}

export function duePromises(data, now = Date.now()) {
  return pendingPromises(data).filter((it) => it.dueAt && it.dueAt <= now)
}

export function markPromiseDone(data, id) {
  const next = { ...data, items: (data.items || []).map((it) => (it.id === id ? { ...it, status: 'done', doneAt: Date.now() } : it)) }
  return next
}

export function markPromiseMissed(data, id) {
  const next = { ...data, items: (data.items || []).map((it) => (it.id === id ? { ...it, status: 'missed' } : it)) }
  return next
}

/**
 * 从她的回复里判断是否兑现了某条承诺（纯规则）：承诺文本里的关键词命中 2 个以上
 * 就算兑现，避免「她又讲了一遍这件事」还被当成没做。不花 token。
 */
export function settlePromisesByReply(data, replyText) {
  const text = String(replyText || '')
  if (!text) return { data, done: 0 }
  let done = 0
  const items = (data.items || []).map((it) => {
    if (!it || it.status !== 'pending' || !it.text) return it
    const keys = String(it.text)
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
    if (keys.length < 3) return it
    const hit = keys.filter((k) => text.includes(k)).length
    // 收紧：命中至少 3 个关键词，且回复里要有「完成」的意味，才认为真兑现
    const doneWord = /(了|完成|搞定|做到|看完|吃了|喝了|吃完了|喝完了|弄好|弄完|去过|给了)/
    const futureWord = /(明天|下次|回头|待会|晚点|改天|还没|忘了|稍后)/
    if (hit >= 3 && doneWord.test(text) && !futureWord.test(text)) {
      done += 1
      return { ...it, status: 'done', doneAt: Date.now(), doneBy: 'reply' }
    }
    return it
  })
  return { data: { ...data, items }, done }
}

/**
 * 自动结算：过期 7 天还没兑现的承诺，标成 missed（她没做到，认了），
 * 不再一直挂在提示词里催。纯规则，不花 token。
 */
export function autoSettlePromises(data, now = Date.now(), overdueDays = 3) {
  let changed = 0
  const items = (data.items || []).map((it) => {
    if (!it || it.status !== 'pending') return it
    const due = Number(it.dueAt) || 0
    if (!due) return it
    if ((now - due) / 86400000 >= Math.max(1, Number(overdueDays) || 3)) {
      changed += 1
      return { ...it, status: 'missed', missedAt: now, missReason: '过期未兑现（自动结算）' }
    }
    return it
  })
  return { data: { ...data, items }, changed }
}

export function removePromise(data, id) {
  return { ...data, items: (data.items || []).filter((it) => it.id !== id) }
}

function fmtDue(dueAt) {
  if (!dueAt) return '没有明确期限'
  const d = new Date(dueAt)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 注入提示词：还没兑现的承诺 */
export function renderPromisePrompt(data, now = Date.now(), limit = 6) {
  const pending = pendingPromises(data)
  if (!pending.length) return ''
  const overdue = pending.filter((it) => it.dueAt && it.dueAt <= now)
  const later = pending.filter((it) => !it.dueAt || it.dueAt > now)
  const lines = ['【你答应过但还没兑现的事】']
  for (const it of overdue.slice(0, limit)) {
    lines.push('· ⏰ ' + it.text + '（约好的时间 ' + fmtDue(it.dueAt) + ' 已经过了，你还欠着）')
  }
  for (const it of later.slice(0, limit)) {
    lines.push('· ' + it.text + '（' + fmtDue(it.dueAt) + '）')
  }
  lines.push('这些是你自己说的，别忘了。合适的时候主动兑现，或者解释一下为什么没做到——别装作没说过。')
  return lines.join('\n')
}

/**
 * 从她的一句话里判断是不是在许承诺（纯规则，不花 token）。
 * 只在「有承诺词 + 承诺对象」时才认为成立，避免把「我会生气」这种也记下来。
 */
const PROMISE_PATTERNS = [
  { re: /(?:^|[，。！？、；：\s])(明天|下次|等会|待会|回头|晚点|稍后)[^。！？\n]{0,30}(告诉你|给你|说|讲|发|帮你|弄|做|安排)/, due: 'soon' },
  { re: /我(会|要|一定|保证)[^。！？\n]{0,20}(记住|帮你|给你|告诉|弄|做|安排|查|看)/, due: 'none' },
  { re: /答应你[^。！？\n]{0,30}/, due: 'none' },
  { re: /我记(住了|下了)[^。！？\n]{0,30}/, due: 'none' },
]

export function detectPromise(text) {
  const s = String(text || '').trim()
  if (!s || s.length > 300) return null
  // 疑问句不算承诺
  if (/[？?]\s*$/.test(s)) return null
  for (const p of PROMISE_PATTERNS) {
    const m = s.match(p.re)
    if (!m) continue
    let dueAt = 0
    if (p.due === 'soon') {
      const now = Date.now()
      const isTomorrow = /明天/.test(s)
      const isNextTime = /下次/.test(s)
      dueAt = isTomorrow ? now + 24 * 3600_000 : isNextTime ? now + 48 * 3600_000 : now + 2 * 3600_000
    }
    return { text: s.slice(0, 200), dueAt, matched: m[0] }
  }
  return null
}

/** 给面板用 */
export function promiseSnapshot(data, now = Date.now()) {
  const items = (data.items || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return {
    pending: items.filter((it) => it.status === 'pending').length,
    done: items.filter((it) => it.status === 'done').length,
    missed: items.filter((it) => it.status === 'missed').length,
    overdue: items.filter((it) => it.status === 'pending' && it.dueAt && it.dueAt <= now).length,
    items: items.slice(0, 60),
  }
}
