/**
 * lib/poke.mjs — 戳一戳（归属：xingzhu）
 * ============================================================================
 * NapCat / OneBot 11 的戳一戳是「通知事件」而不是消息：
 *   { post_type:'notice', notice_type:'notify', sub_type:'poke',
 *     user_id:<戳的人>, target_id:<被戳的人>, group_id?:<群号> }
 * 发送戳一戳是 action：group_poke { group_id?, user_id }。
 *
 * 本文件只做解析和兜底台词，不碰网络；engine 负责冷却、生成、回戳。
 * ============================================================================
 */

/** 从事件里认「这到底是不是一条戳一戳」；不是就返回 null */
export function parsePokeEvent(event) {
  if (!event || event.post_type !== 'notice') return null
  const noticeType = String(event.notice_type || '').toLowerCase()
  const subType = String(event.sub_type || '').toLowerCase()
  // 标准写法是 notify + sub_type=poke；也兼容某些实现的 friend_poke / group_poke
  const isPoke =
    subType === 'poke' ||
    noticeType === 'poke' ||
    noticeType === 'friend_poke' ||
    noticeType === 'group_poke'
  if (!isPoke) return null
  const userId = String(event.user_id || '')
  if (!userId) return null
  const groupId = String(event.group_id || '')
  const channel = groupId ? 'group' : 'private'
  return {
    channel,
    groupId,
    uin: groupId || userId,
    userId,
    targetId: String(event.target_id || event.target || userId),
    selfId: String(event.self_id || ''),
  }
}

/** 模型不可用时的兜底：至少是她的口气，不是死板的「你戳我干嘛」 */
const FALLBACK = [
  '戳什么戳，手贱啊杂鱼。',
  '呜…别戳了，再戳把你手指头咬掉。',
  '（尾巴一抽）谁准你戳的。',
  '就这？戳一下就想让我理你。',
  '…好啦好啦，我在。',
  '戳坏了要赔的，笨蛋。',
]

/** 挑一句兜底的，尽量避开她最近说过的话 */
export function pokeFallbackLine(recent = []) {
  const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const used = (Array.isArray(recent) ? recent : []).map((x) => norm(x && typeof x === 'object' ? x.text : x)).filter(Boolean)
  const pool = FALLBACK.filter((line) => {
    const n = norm(line)
    return !used.some((u) => u.includes(n.slice(0, 5)) || n.includes(u.slice(0, 5)))
  })
  const list = pool.length ? pool : FALLBACK
  return list[Math.floor(Math.random() * list.length)]
}
