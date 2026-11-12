/**
 * lib/refusal.mjs — 拒绝反馈链
 * ============================================================================
 * 依据：dsh-fish 的「她会拒绝你，还会为自己的拒绝反省」——
 *   拒绝不是设定（不是「人设要求我说不」），而是她当下不想。
 *   拒绝之后，主人的反应决定她进入哪条反馈链：
 *     主人不高兴 → 她记到小本本上，直到想通；
 *     主人说没关系 → 她反省"这次拒绝对不对"。
 *
 * 数据：qq-fish/refusals.json（最多 60 条）
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stateHome } from './store.mjs'

const FILE = () => stateHome() + '/refusals.json'
const MAX = 60

function load() { try { return JSON.parse(readFileSync(FILE(), 'utf8')) } catch { return { items: [] } } }
function save(v) { try { mkdirSync(stateHome(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {} }

/** 她这句话像不像在拒绝（不是骂人，是"不想做/不做/别烦"） */
export function looksLikeRefusal(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 200) return false
  return /(不想|不要|不做|别烦|懒得|没空|不干|拒绝|才不|你自己|爱做不做|不奉陪|不想聊|先睡了|不接这活)/.test(t)
}

/** 记一条拒绝（还没等到主人反应） */
export function recordRefusal({ herText, context = '', now = Date.now() } = {}) {
  const her = String(herText || '').trim().slice(0, 160)
  if (!her) return null
  const v = load()
  const items = Array.isArray(v.items) ? v.items : []
  // 5 分钟内不重复记同一句
  if (items.some((x) => x.her === her && now - (Number(x.at) || 0) < 5 * 60 * 1000)) return null
  const id = 'r' + now.toString(36) + Math.random().toString(36).slice(2, 5)
  items.push({ id, her, context: String(context).slice(0, 120), at: now, reaction: '', reflection: '' })
  v.items = items.slice(-MAX)
  save(v)
  return { ok: true, id }
}

/** 主人对她的拒绝有了反应：positive=true 是接受/理解，false 是不高兴/反驳 */
export function recordOwnerReaction({ ownerText, positive = null, now = Date.now() } = {}) {
  const own = String(ownerText || '').trim().slice(0, 160)
  if (!own) return null
  const v = load()
  const items = Array.isArray(v.items) ? v.items : []
  // 找最近一条还没反应的
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.reaction) continue
    if (now - (Number(it.at) || 0) > 30 * 60 * 1000) continue
    const neg = /(凭什么|必须|给我做|不许|你怎么敢|反了你了|不听话|什么意思|你再说一遍)/.test(own)
    const pos = /(没关系|算了|理解|随你|不强求|我懂|你歇着|好嘛|行吧|不勉强|尊重)/.test(own)
    it.reaction = pos ? 'pos' : (neg ? 'neg' : '')
    if (!it.reaction) continue
    it.reactionAt = now
    it.ownerSaid = own
    it.reflection = pos
      ? '他接受了我的拒绝。我再想想：这次是不是真的不想，还是只是懒得。'
      : '他不太高兴。我把这事记着——不是要立刻低头，是得想清楚下次还该不该拒。'
    save(v)
    return { ok: true, id: it.id, reaction: it.reaction }
  }
  return null
}

/** 注入块：最近的拒绝 + 她的反省 */
export function refusalPromptBlock(limit = 2) {
  const v = load()
  const items = (Array.isArray(v.items) ? v.items : []).filter((x) => x.reaction).slice(-limit)
  if (!items.length) return ''
  const lines = items.map((it) => {
    const tag = it.reaction === 'pos' ? '他接受了' : '他不太高兴'
    return '- 我说「' + String(it.her).slice(0, 36) + '」→ ' + tag + '。' + (it.reflection || '')
  })
  return '【你拒绝过的事，以及后来】\n' + lines.join('\n') +
    '\n（这些是你自己身上发生过的事，不用主动提；但下次要不要拒绝、拒完怎么处理，可以拿它当参考。）'
}

/** 状态（面板用） */
export function status() { return load() }
