/**
 * lib/self-distill.mjs — 自我蒸馏（学过程 / 学方法）
 * ============================================================================
 * 依据：主人 2026-11-08 推的《一条视频讲透"蒸馏"》——
 *   蒸馏的价值不在「答案」，在「推理过程、工具调用、真实任务、人的纠错」。
 *   普通人能用的落地是：把与 AI 合作时的修改、取舍、反馈，沉淀成下次可复用的方法。
 *
 * 对她：她现在只会「记事实」（读了什么、被纠正了什么），不会「提炼方法」。
 *   这里补两层：
 *     1. 学过程：她做过的事（主动说话/查天气/改日程/写日记/B站发言）→ 记"当时怎么想的"
 *     2. 学方法：同类事件反复出现 → 提炼成一条可复用规则
 *
 * 成本：默认零 token（纯规则聚类）；只有 enableLlm 时才调一次轻模型总结。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stateHome } from './store.mjs'

const FILE = () => stateHome() + '/distilled.json'
const MAX_METHODS = 60

function load() {
  try { return JSON.parse(readFileSync(FILE(), 'utf8')) } catch { return { methods: [], lastRunDate: '' } }
}
function save(v) {
  try { mkdirSync(stateHome(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
}
function todayKey(now) {
  const d = new Date(now); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}
function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

/**
 * 从她自己的日志里提炼"方法"（零 token）。
 * 规则：同一类事件出现 >= 次数阈值 → 生成一条方法。
 */
export function distill({ now = Date.now(), config = {}, minCount = 3 } = {}) {
  const home = stateHome()
  const v = load()
  const day = todayKey(now)
  if (v.lastRunDate === day) return { ok: true, skipped: 'today', added: 0 }

  const added = []
  const signals = []

  // 1) 主动消息的"理由"（organic/purpose 的 notes）
  try {
    const sched = readJson(home + '/scheduler.json', {})
    const org = readJson(home + '/organic.json', {})
    if (Number(org.lastReleaseAt) > 0) signals.push({ kind: 'proactive', at: Number(org.lastReleaseAt) })
  } catch {}

  // 2) 纠错记录 → 同类纠正 >= minCount 次，提炼成"别再做"
  try {
    const corr = readJson(home + '/corrections.json', { items: [] })
    const items = Array.isArray(corr.items) ? corr.items : []
    const groups = new Map()
    for (const it of items) {
      // 用纠正语里的关键词做聚类（简单分词：取 2-4 字中文片段）
      const words = String(it.owner || '').match(/[\u4e00-\u9fa5]{2,4}/g) || []
      for (const w of words.slice(0, 3)) {
        if (!groups.has(w)) groups.set(w, [])
        groups.get(w).push(it)
      }
    }
    for (const [w, list] of groups) {
      if (list.length >= minCount) {
        added.push({
          kind: 'avoid',
          text: '关于「' + w + '」这件事，被纠正过 ' + list.length + ' 次：' + list.slice(0, 2).map((x) => String(x.owner).slice(0, 24)).join(' / '),
          at: now,
        })
        break // 一天最多提炼一条 avoid
      }
    }
  } catch {}

  // 3) 浏览/读书 → "我最近在意什么"（话题频次）
  try {
    const bl = readJson(home + '/browse-log.json', { items: [] })
    const items = Array.isArray(bl.items) ? bl.items : []
    const recent = items.filter((x) => now - (Number(x.at) || 0) < 7 * 86400 * 1000)
    if (recent.length >= 2) {
      added.push({ kind: 'interest', text: '最近自己搜过：' + recent.slice(-3).map((x) => String(x.query || '').slice(0, 16)).join('、'), at: now })
    }
  } catch {}

  // 4) 日记 → 情绪/生活主题（只取最后一条的标签，不调模型）
  try {
    const di = readJson(home + '/diary.json', { entries: [] })
    const entries = Array.isArray(di.entries) ? di.entries : []
    const today = entries.filter((e) => todayKey(Number(e.createdAt) || 0) === day)
    if (today.length) {
      const txt = String(today[today.length - 1].text || '').slice(0, 200)
      const mood = /(烦|累|困|难受|委屈|开心|高兴|软|暖)/.test(txt) ? txt.match(/(烦|累|困|难受|委屈|开心|高兴|软|暖)/g).slice(0, 2).join('') : ''
      if (mood) added.push({ kind: 'mood', text: '这两天心里是「' + mood + '」的状态', at: now })
    }
  } catch {}

  // 合并
  v.methods = Array.isArray(v.methods) ? v.methods : []
  for (const m of added) {
    if (!v.methods.some((x) => x.text === m.text)) v.methods.push(m)
  }
  if (v.methods.length > MAX_METHODS) v.methods = v.methods.slice(-MAX_METHODS)
  v.lastRunDate = day
  save(v)
  return { ok: true, added: added.length, methods: v.methods.length }
}

/** 注入块：她"学到的方法"（只取最近 5 条） */
export function distillPromptBlock(limit = 3) {
  const v = load()
  const list = (Array.isArray(v.methods) ? v.methods : []).slice(-limit)
  if (!list.length) return ''
  return '【你自己总结出来的】\n' + list.map((m) => '- ' + String(m.text).slice(0, 80)).join('\n') + '\n（这些是你自己从日子里攒出来的经验，不是设定；聊到相关的时候可以自然带出来。）'
}

/** 状态（面板用） */
export function status() {
  const v = load()
  return { methods: Array.isArray(v.methods) ? v.methods : [], lastRunDate: v.lastRunDate || '' }
}
