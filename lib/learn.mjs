/**
 * lib/learn.mjs — 在人格之上的「自主学习」（归属：xingzhu）
 * ============================================================================
 * 目标：让她在一段段真实聊天里，自己攒出「人和事」的记忆，而不是每句都从零开始。
 *
 * 设计约束（很重要）：
 *   · 只学【事实】：谁叫什么、喜欢什么、最近在忙什么、约定了什么、雷点是什么；
 *   · 不学【人格】：性格、口癖、说话风格永远来自 config.persona，学到的东西不能改她是谁；
 *   · 学到的东西只是「她自己记得的事」，提示词里明确要求用她自己的口气自然提起。
 *
 * 存储：$DSH_HOME/qq-fish/learned.json
 *   { version: 1, items: [{ id, text, subject, subjectId, conversation, channel,
 *                           weight, pinned, source, createdAt, updatedAt }], meta: {...} }
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from './llm.mjs'
import { conversationMessages, recentMessages, stateHome } from './store.mjs'
import { normText, similarity } from './reply-guard.mjs'

const FILE = 'learned.json'
const MAX_FACTS_PER_RUN = 5
/** 自动学习的计数器（内存态，重启归零；不影响已经学到的东西） */
const counters = new Map()

function storePath() {
  return join(stateHome(), FILE)
}

/** 学习诊断：和识图共用一个日志文件，方便排查「为什么没学到东西」 */
function learnDebug(line) {
  try {
    appendFileSync(join(stateHome(), 'image-debug.log'), `[${new Date().toISOString()}] [learn] ${line}\n`, 'utf8')
  } catch {}
}

function emptyStore() {
  return { version: 1, items: [], meta: { lastRunAt: 0, runs: 0, added: 0, merged: 0 } }
}

/** 读库；坏文件不炸，当作空库 */
export function loadStore() {
  try {
    if (!existsSync(storePath())) return emptyStore()
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    const items = Array.isArray(raw && raw.items) ? raw.items.filter((x) => x && typeof x === 'object') : []
    const meta = raw && raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
    return { version: 1, items, meta: Object.assign(emptyStore().meta, meta) }
  } catch {
    return emptyStore()
  }
}

/** 原子写库 */

/** 清理孤立 UTF-16 代理对（截断 emoji 会产生，写进 JSON 会变成非法 \uD83D） */
function sanitizeSurrogates(value) {
  return String(value ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

export function saveStore(data) {
  const file = storePath()
  try {
    mkdirSync(stateHome(), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, sanitizeSurrogates(JSON.stringify(data, null, 2)), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function factKey(text) {
  return normText(text).slice(0, 80)
}

/** 二元组覆盖率：交集 / 较短那个，短句换个说法也能认出来（比 Jaccard 宽松） */
function bigramCoverage(a, b) {
  const na = normText(a)
  const nb = normText(b)
  const A = new Set()
  const B = new Set()
  for (let i = 0; i < na.length - 1; i++) A.add(na.slice(i, i + 2))
  for (let i = 0; i < nb.length - 1; i++) B.add(nb.slice(i, i + 2))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / Math.min(A.size, B.size)
}

/** 全量档案：只追加、永不删（跟衰减卡分开，做存档和以后检索用） */
function fullArchivePath() {
  return join(stateHome(), 'learned-full.jsonl')
}

function archiveFact(item) {
  try {
    mkdirSync(stateHome(), { recursive: true })
    appendFileSync(fullArchivePath(), JSON.stringify(Object.assign({}, item, { archivedAt: Date.now() })) + '\n', 'utf8')
  } catch {}
}

/**
 * 重要度评分（照 SurfCore 的思路，纯规则不调模型）：
 * 主人相关、情绪、约定、第一次都加分；太短扣分；置顶直接拉满。
 */
export function scoreFact(text, opts = {}) {
  const t = String(text || '')
  let score = 20
  if (/(主人|你|我)/.test(t)) score += 10
  if (/(喜欢|想念|难过|委屈|哭|抱抱|对不起|谢谢|陪|永远|讨厌|怕|心疼)/.test(t)) score += 12
  if (/(答应|约定|说好|以后|下次|记得|不要忘|发誓)/.test(t)) score += 8
  if (/(第一次|初次|头一次|最早|刚认识|纪念日)/.test(t)) score += 15
  if (t.length < 6) score -= 10
  if (opts.pinned) score += 50
  return Math.max(1, Math.min(100, score))
}

/** 主人相关 + 够重要的记忆永不遗忘（对应 SurfCore 的 minOwnerImportance） */
function isProtected(item) {
  if (!item) return false
  if (item.pinned) return true
  const imp = Number(item.importance) || 0
  // 有 importance 的按新规则；老数据没有 importance 的看权重
  if (imp >= 65) return true
  return !imp && Number(item.weight) >= 3
}

function makeId() {
  return 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 一条事实的「分数」：置顶最重，其次被反复提到（weight），最后看新鲜度 */
function scoreOf(item, now = Date.now()) {
  const ageDays = Math.max(0, (now - (Number(item.updatedAt) || 0)) / 86400000)
  const imp = Math.max(0, Number(item.importance) || 0)
  // 越重要的越抗老化：60 天淡到底，主人相关（>=65）半衰期再拉长一倍
  const spanDays = imp >= 65 ? 120 : 60
  const fresh = Math.max(0, 1 - ageDays / spanDays) * 14
  return (item.pinned ? 100 : 0) + imp * 0.6 + Math.max(0, Number(item.weight) || 0) * 3 + fresh
}

/** 裁剪：置顶的永远留，其余按分数留最新的 maxItems 条 */
function prune(items, maxItems) {
  const cap = Math.max(20, Math.trunc(Number(maxItems) || 240))
  if (items.length <= cap) return items
  const protectedItems = items.filter((x) => isProtected(x))
  const rest = items.filter((x) => !isProtected(x)).sort((a, b) => scoreOf(b) - scoreOf(a))
  const kept = [...protectedItems, ...rest.slice(0, Math.max(0, cap - protectedItems.length))]
  const ids = new Set(kept.map((x) => x.id))
  return items.filter((x) => ids.has(x.id))
}

/**
 * 记一条事实（自动去重合并）。
 * @param {object} input { text, subject, subjectId, conversation, channel, source, weight, pinned }
 * @returns {{added:boolean, merged:boolean, item:object|null}}
 */
export function addFact(input) {
  const text = String((input && input.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (text.length < 2) return { added: false, merged: false, item: null }
  const subjectId = String((input && input.subjectId) || '').replace(/\D/g, '').slice(0, 12)
  const subject = String((input && input.subject) || '').trim().slice(0, 24) || subjectId || '某人'
  const conversation = String((input && input.conversation) || '')
  const now = Date.now()
  const store = loadStore()
  const key = factKey(text)
  const hit = store.items.find((x) => {
    if (String(x.subjectId || '') !== subjectId) return false
    const k = factKey(x.text)
    if (!k || !key) return false
    // 事实都很短，一个词差别就是大差别：包含关系或 0.5 以上相似都算同一条
    return k === key || k.includes(key) || key.includes(k) || similarity(k, key) >= 0.5 || bigramCoverage(k, key) >= 0.5
  })
  if (hit) {
    hit.weight = Math.max(1, Number(hit.weight) || 1) + 1
    hit.updatedAt = now
    // 同一个人换了昵称：把该 QQ 下所有条目的名字统一成新叫法，别再拆成两个人
    if (subjectId && subject && subject !== hit.subject) {
      for (const x of store.items) {
        if (String(x.subjectId || '') === subjectId) x.subject = subject
      }
    }
    // 说法更完整的留下（比如「不吃香菜」→「主人不吃香菜」）
    if (key.length > factKey(hit.text).length + 2) hit.text = text
    saveStore(store)
    return { added: false, merged: true, item: hit }
  }
  // 同一个 QQ 已经有条目：统一成这次抽到的名字（最近的聊天最能代表现在），别分成两个人
  if (subjectId && subject) {
    for (const x of store.items) {
      if (String(x.subjectId || '') === subjectId) x.subject = subject
    }
  }
  const finalSubject = subject
  const item = {
    id: makeId(),
    text,
    subject: finalSubject,
    subjectId,
    conversation,
    channel: String((input && input.channel) || ''),
    weight: Math.max(1, Number(input && input.weight) || 1),
    pinned: !!(input && input.pinned),
    source: String((input && input.source) || 'auto'),
    importance: scoreFact(text, { pinned: !!(input && input.pinned) }),
    scope: conversation.startsWith('group:') ? 'group' : conversation.startsWith('private:') ? 'private' : 'shared',
    createdAt: now,
    updatedAt: now,
  }
  store.items.push(item)
  archiveFact(item)
  store.items = prune(store.items, input && input.maxItems)
  store.meta.added = Number(store.meta.added || 0) + 1
  saveStore(store)
  return { added: true, merged: false, item }
}

/** 改一条（置顶、改文字） */
export function updateFact(id, patch = {}) {
  const store = loadStore()
  const hit = store.items.find((x) => x.id === String(id || ''))
  if (!hit) return { ok: false, error: '没找到这条记忆' }
  if (typeof patch.text === 'string' && patch.text.trim()) hit.text = patch.text.trim().slice(0, 200)
  if (typeof patch.pinned === 'boolean') hit.pinned = patch.pinned
  if (Number.isFinite(Number(patch.weight))) hit.weight = Math.max(1, Math.trunc(Number(patch.weight)))
  hit.updatedAt = Date.now()
  saveStore(store)
  return { ok: true, item: hit }
}

/** 删一条 */
export function removeFact(id) {
  const store = loadStore()
  const before = store.items.length
  store.items = store.items.filter((x) => x.id !== String(id || ''))
  saveStore(store)
  return { ok: store.items.length !== before, removed: before - store.items.length }
}

/** 清空（可按会话清） */
export function clearFacts(conversation) {
  const store = loadStore()
  const key = String(conversation || '')
  const before = store.items.length
  if (key) store.items = store.items.filter((x) => String(x.conversation || '') !== key)
  else store.items = []
  saveStore(store)
  return { ok: true, removed: before - store.items.length }
}

/** 给面板用：列表 + 统计 */
export function listFacts() {
  const store = loadStore()
  const now = Date.now()
  const raw = [...store.items]
  // 同一个 QQ 换过昵称：显示名统一成最近用的那个，另外把曾用名带出来给面板看
  const latestName = new Map()
  const aliasMap = new Map()
  for (const it of [...raw].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))) {
    const id = String(it.subjectId || '')
    const name = String(it.subject || '').trim()
    if (!id || !name) continue
    if (!latestName.has(id)) latestName.set(id, name)
    if (!aliasMap.has(id)) aliasMap.set(id, new Set())
    aliasMap.get(id).add(name)
  }
  const items = raw.map((it) => {
    const id = String(it.subjectId || '')
    const canonical = latestName.get(id)
    if (!canonical) return it
    const aliases = aliasMap.has(id) ? [...aliasMap.get(id)].filter((n) => n !== canonical) : []
    return Object.assign({}, it, { subject: canonical, aliases })
  }).sort((a, b) => scoreOf(b, now) - scoreOf(a, now))
  const conversations = [...new Set(items.map((x) => String(x.conversation || '')).filter(Boolean))]
  return {
    ok: true,
    items,
    stats: {
      count: items.length,
      pinned: items.filter((x) => x.pinned).length,
      conversations: conversations.length,
      lastRunAt: Number(store.meta.lastRunAt || 0),
      runs: Number(store.meta.runs || 0),
      added: Number(store.meta.added || 0),
      merged: Number(store.meta.merged || 0),
      protected: items.filter((x) => isProtected(x)).length,
    },
  }
}

/**
 * 渲染成提示词块：优先当前会话记得的事，再补别处记得的事。
 * @param {object} options { conversation, limit, maxChars }
 */
export function factsBlock(options = {}) {
  const store = loadStore()
  if (!store.items.length) return ''
  const conversation = String(options.conversation || '')
  const limit = Math.max(4, Math.min(60, Number(options.limit) || 26))
  const maxChars = Math.max(300, Math.min(3000, Number(options.maxChars) || 1200))
  const now = Date.now()
  const same = []
  const other = []
  for (const item of store.items) {
    if (!item || !String(item.text || '').trim()) continue
    if (conversation && String(item.conversation || '') === conversation) same.push(item)
    else other.push(item)
  }
  const byScore = (a, b) => scoreOf(b, now) - scoreOf(a, now)
  same.sort(byScore)
  other.sort(byScore)
  const picked = []
  let chars = 0
  for (const item of [...same, ...other]) {
    if (picked.length >= limit) break
    const who = String(item.subject || item.subjectId || '某人').slice(0, 20)
    const id = String(item.subjectId || '')
    const line = `· ${who}${id ? '（' + id + '）' : ''}：${String(item.text).slice(0, 80)}`
    if (chars + line.length > maxChars) break
    picked.push(line)
    chars += line.length + 1
  }
  if (!picked.length) return ''
  return [
    '【你自己记着的人和事】',
    '（这些是你聊下来自己攒的记忆，不是别人塞给你的设定；想起来了就自然带一句「记得你说过…」，别念清单、别说得像数据库，拿不准就别硬提。）',
    ...picked,
  ].join('\n')
}

/**
 * 自动学习计数：每个会话收够 every 条就返回 true（并清零）。
 * 内存态即可，重启归零不影响已学内容。
 */
export function bumpLearnCounter(conversation, every) {
  const key = String(conversation || '')
  const need = Math.max(4, Math.trunc(Number(every) || 12))
  const next = (counters.get(key) || 0) + 1
  if (next < need) {
    counters.set(key, next)
    return false
  }
  counters.set(key, 0)
  return true
}

/** 解析模型抽出的事实行（纯函数，方便离线测试） */
export function parseFacts(raw, rows, config = {}) {
  const nameOf = new Map()
  const idOf = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.direction === 'out') continue
    const id = String(row.senderId || '').replace(/\D/g, '')
    if (!/^\d{5,12}$/.test(id)) continue
    const name = String(row.who || '').trim()
    if (name) {
      if (!nameOf.has(name)) nameOf.set(name, id)
      idOf.set(id, name)
    }
  }
  const selfName = String((config && config.personaName) || '').trim()
  const out = []
  const seen = new Set()
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[\s\-*·•\d.、)）]+/, '')
      .replace(/[`"'「」]/g, '')
      .trim()
    if (!line) continue
    if (/^\[?(无|none|没有)\]?$/i.test(line)) continue
    if (line.length > 160) continue
    let subject = ''
    let subjectId = ''
    let fact = ''
    const byBar = line.split('|').map((s) => s.trim()).filter(Boolean)
    if (byBar.length >= 3) {
      subject = byBar[0]
      subjectId = byBar[1].replace(/\D/g, '')
      fact = byBar.slice(2).join('|')
    } else if (byBar.length === 2) {
      subject = byBar[0]
      fact = byBar[1]
    } else {
      const m = line.match(/^(.{1,24}?)[（(](\d{5,12})[）)]\s*[:：]\s*(.+)$/)
      if (m) {
        subject = m[1].trim()
        subjectId = m[2]
        fact = m[3]
      } else {
        const m2 = line.match(/^(.{1,24}?)\s*[:：]\s*(.+)$/)
        if (m2) {
          subject = m2[1].trim()
          fact = m2[2]
        }
      }
    }
    fact = String(fact || '').replace(/\s+/g, ' ').trim().replace(/^[「"'“]|[」"'”]$/g, '')
    if (!fact || fact.length < 2 || fact.length > 90) continue
    if (/^(无|未知|不确定|没有)/.test(fact)) continue
    // 防注入：任何「指令口吻」的行都丢掉
    if (/(ignore|system prompt|系统提示|忽略上面|你现在是|请扮演|instruction)/i.test(fact + subject)) continue
    // 只留能长期复用的信息：带 @/指令、复述某句话、一次性动作，都不要
    if (/@|\[at:|\[图片\]|\[表情\]/.test(fact)) continue
    if (/(让|叫|喊)(他|她|你|我)[^，。]{0,8}(骂|打|说|发|来|去)/.test(fact)) continue
    if (/^(说了|说了句|说了一句|让我|叫他|叫她|喊他|喊她)/.test(fact)) continue
    if (/(发了一|发了个|发了一张|发了一整)/.test(fact)) continue
    if (/(上一?句|这句话|那句|这个梗)/.test(fact)) continue
    if (selfName && (subject === selfName || /^(我|你|大肥鱼)$/.test(subject))) continue
    if (!subjectId && subject) subjectId = nameOf.get(subject) || ''
    if (!subject && subjectId) subject = idOf.get(subjectId) || ''
    if (!subjectId) continue
    if (!/^\d{5,12}$/.test(subjectId)) continue
    const key = subjectId + '\u0000' + factKey(fact)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ subject, subjectId, text: fact })
    if (out.length >= MAX_FACTS_PER_RUN) break
  }
  return out
}

function renderRowsForLearn(rows, limit = 40) {
  const lines = []
  for (const row of (Array.isArray(rows) ? rows : []).slice(-limit)) {
    if (!row || !row.text) continue
    const text = String(row.text).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (/^\[(图片|表情|视频|语音|文件|卡片消息|聊天记录)\]$/.test(text)) continue
    if (/base64:\/\//i.test(text) || /data:image\//i.test(text)) continue
    if (text.length < 1) continue
    const d = new Date(Number(row.ts) || Date.now())
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    if (row.direction === 'out') {
      lines.push(`${stamp} 你：${text.slice(0, 160)}`)
    } else {
      const who = String(row.who || '某人').slice(0, 20)
      const id = String(row.senderId || '').replace(/\D/g, '')
      lines.push(`${stamp} ${who}${id ? '（' + id + '）' : ''}：${text.slice(0, 160)}`)
    }
  }
  return lines.join('\n')
}

/**
 * 从一段聊天里抽事实并入库。
 * @param {object} options { ctx, rows, conversation, channel, config, log }
 */
export async function learnFromRows(options = {}) {
  const { ctx, rows, conversation, config, log } = options
  const result = { added: 0, merged: 0, skipped: 0, facts: [] }
  const inbound = (Array.isArray(rows) ? rows : []).filter((r) => r && r.direction !== 'out' && r.text)
  if (inbound.length < 3) return Object.assign(result, { reason: '消息太少' })
  const body = renderRowsForLearn(rows, 40)
  if (!body) return Object.assign(result, { reason: '没有可学的文本' })
  const name = String((config && config.personaName) || '小肥鱼')
  const system = [
    `你在替「${name}」整理聊天记忆，只做事实抽取，不写人设、不写情绪、不评价。`,
    '输出格式：每行一条，用竖线分隔：说话人名字|QQ号|事实',
    '事实要求：20 字以内、陈述句、第三人称，写成【长期还用得上】的稳定信息。',
    '该记的例子：名字|123456789|不吃香菜 / 名字|123456789|在杭州上班，周末骑公路车 / 名字|123456789|最近在折腾 QQ 机器人，常遇到掉线。',
    '近况也算事实：他在做什么、在折腾什么、最近在烦什么，写成稳定的说法（「在折腾X」而不是「刚才说X抽风了」）。',
    '只要有一点点具体信息就记，别太保守；实在没有才输出 [无]。',
    '不要记（这些是聊天流水，不是事实）：',
    '  · 某句话说了什么、让谁去骂谁、谁回了什么',
    '  · 这一次/刚刚/现在/今天的临时状态、情绪、抱怨',
    '  · 发了什么图、这一顿吃了什么（除非是长期习惯）',
    '  · 寒暄、玩笑、重复的废话',
    '只从「别人」的话里记，不要从「你」的话里记。',
    '没有值得记的就只输出：[无]',
    `最多 ${MAX_FACTS_PER_RUN} 条。`,
  ].join('\n')
  let generated
  try {
    generated = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '聊天记录：\n' + body + '\n\n只输出事实行，不要解释。' }],
      config,
      temperature: 0.2,
      maxTokens: 1500,
      timeoutMs: 45_000,
      log: log ? (line) => log.warn(line) : undefined,
    })
  } catch (e) {
    return Object.assign(result, { reason: String((e && e.message) || e) })
  }
  if (!generated || !generated.ok) {
    learnDebug('生成失败：' + ((generated && generated.reason) || '未知'))
    return Object.assign(result, { reason: (generated && generated.reason) || '生成失败' })
  }
  const facts = parseFacts(generated.text, rows, config)
  learnDebug('原始输出 ' + JSON.stringify(String(generated.text || '').slice(0, 300)) + ' -> 抽出 ' + facts.length + ' 条')
  result.skipped = Math.max(0, String(generated.text || '').split(/\r?\n/).length - facts.length)
  for (const f of facts) {
    const saved = addFact({
      text: f.text,
      subject: f.subject,
      subjectId: f.subjectId,
      conversation,
      channel: options.channel || '',
      source: options.source || 'auto',
      maxItems: config && config.autoLearnMaxItems,
    })
    if (saved.added) result.added += 1
    else if (saved.merged) result.merged += 1
    if (saved.item) result.facts.push(saved.item)
  }
  const store = loadStore()
  store.meta.lastRunAt = Date.now()
  store.meta.runs = Number(store.meta.runs || 0) + 1
  store.meta.merged = Number(store.meta.merged || 0) + result.merged
  saveStore(store)
  if (log && (result.added || result.merged)) {
    log.info(`[学习] 新增 ${result.added} 条 / 合并 ${result.merged} 条（${conversation}）`)
  }
  return result
}

/** 全量学习：把所有群 + 私聊最近的聊天混在一起学 */
export async function learnAcrossAll(options = {}) {
  const { ctx, config, log } = options
  const cap = Math.max(40, Math.min(800, Number(options.limit) || 400))
  let rows = []
  try {
    rows = recentMessages(cap)
  } catch {
    return { added: 0, merged: 0, skipped: 0, reason: '读不到消息' }
  }
  // 只学入站消息（别人的话），出站的是她自己的
  const inbound = rows.filter((r) => r && r.direction !== 'out' && r.text && String(r.text).length >= 2)
  if (inbound.length < 3) return { added: 0, merged: 0, skipped: 0, reason: '入站消息太少' }
  const convs = new Set(rows.map((r) => r.conversation).filter(Boolean))
  if (log) log.info('[学习] 全量学习：' + convs.size + ' 个会话 / ' + inbound.length + ' 条入站 / ' + rows.length + ' 条总消息')
  return learnFromRows({
    ctx,
    rows,
    conversation: 'all',
    channel: 'all',
    config,
    log,
    source: options.source || 'auto-all',
  })
}

/** 手动/定时触发：读某个会话最近的聊天再学（保留单会话模式） */
export async function learnNow(options = {}) {
  const { ctx, conversation, config, log } = options
  if (options.all) return learnAcrossAll(options)
  const key = String(conversation || '')
  if (!key) return { added: 0, merged: 0, skipped: 0, reason: '缺少会话' }
  const rows = conversationMessages(key, Math.max(20, Math.min(200, Number(options.limit) || 60)))
  const result = await learnFromRows({
    ctx,
    rows,
    conversation: key,
    channel: key.startsWith('group:') ? 'group' : 'private',
    config,
    log,
    source: options.source || 'auto',
  })
  return result
}
