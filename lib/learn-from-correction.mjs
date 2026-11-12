/**
 * lib/learn-from-correction.mjs — 纠错蒸馏
 * ============================================================================
 * 来源：主人 2026-11-08 推的《一条视频讲透"蒸馏"》——蒸馏的价值不在答案，
 *       而在「推理过程 / 判断 / 人的纠错」。她最该学的就是"被纠正后不再犯"。
 *
 * 做什么：
 *   1. 检测主人是否在纠正她（"不对""不是这样""你搞错了""别这么说"…）
 *   2. 把「她上一句 + 主人的纠正」配对存下来（corrections.json）
 *   3. 提炼成一条可复用教训（零 token 规则版：只存原文对，不调模型）
 *   4. 下次同类场景把最近几条教训注入 system
 *
 * 为什么必须在这里学：她的 persona 是固定的，但"哪里说错了"只有真实对话里才有。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stateHome } from './store.mjs'

const FILE = () => stateHome() + '/corrections.json'
const MAX_ITEMS = 80

function load() {
  try { return JSON.parse(readFileSync(FILE(), 'utf8')) } catch { return { items: [] } }
}
function save(v) {
  try { mkdirSync(stateHome(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
}

/** 主人这句话像不像在纠正她 */
export function looksLikeCorrection(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 200) return false
  return /(不对|错了|不是这样|别这么|你搞错|谁让你|谁教你|不许|别说|别叫|你听错|不是这个意思|瞎说|胡说|乱讲|又来了|说过多少遍|怎么又)/.test(t)
}

/** 记一条纠正：她的原话 + 主人的纠正 + 时间 */
export function recordCorrection({ herText, ownerText, now = Date.now(), config = {} } = {}) {
  const her = String(herText || '').trim().slice(0, 200)
  const own = String(ownerText || '').trim().slice(0, 200)
  if (!her || !own) return null
  const v = load()
  // 去重：同样两句不重复记
  const key = her + '||' + own
  if ((v.items || []).some((it) => it.her === her && it.owner === own)) return null
  v.items = Array.isArray(v.items) ? v.items : []
  v.items.push({ her, owner: own, at: now })
  if (v.items.length > MAX_ITEMS) v.items = v.items.slice(-MAX_ITEMS)
  save(v)
  return { ok: true, count: v.items.length }
}

/** 注入块：最近 N 条教训（只取和当前上下文有共同词的） */
export function correctionPromptBlock(context = '', limit = 2) {
  const v = load()
  const items = Array.isArray(v.items) ? v.items : []
  if (!items.length) return ''
  const ctx = String(context || '')
  // 简单相关性：与原话有 2 字以上重叠优先，否则取最近的
  const scored = items.map((it) => {
    let score = 0
    for (const ch of new Set(String(it.her || ''))) if (ctx.includes(ch)) score++
    return { it, score }
  }).sort((a, b) => b.score - a.score || b.it.at - a.it.at)
  const pick = scored.slice(0, limit).map((x) => x.it)
  if (!pick.length) return ''
  return '【她以前被纠正过的地方（别再犯）】\n' + pick.map((it) =>
    '- 她说过「' + String(it.her).slice(0, 50) + '」，主人纠正：「' + String(it.owner).slice(0, 50) + '」'
  ).join('\n')
}
