/**
 * lib/qzone.mjs — QQ 空间：看 / 赞 / 评 / 发说说
 * ============================================================================
 * 走 NapCat 的扩展 API（不是 OneBot 标准）：
 *   get_qzone_feeds({ hostUin })  → 动态列表（含 tid / 内容 / 图 / 赞数 / 评论数）
 *   like_qzone({ tid })           → 点赞
 *   comment_qzone({ tid, content })→ 评论
 *   send_qzone_msg({ content })   → 发说说
 *
 * 注意：没有「评论列表」API，所以能发新评论、但不能回复某一条评论。
 * ============================================================================
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dshHome } from './store.mjs'
import { listStickers, stickerDir } from './stickers.mjs'

export const QZONE_ACTIONS = ['look', 'like', 'comment', 'post']

function cleanFeed(f) {
  if (!f) return null
  return {
    tid: String(f.tid || ''),
    uin: String(f.uin || ''),
    nickname: String(f.nickname || ''),
    at: Number(f.time) * 1000 || 0,
    text: String(f.content || '').replace(/\s+/g, ' ').slice(0, 300),
    images: Array.isArray(f.images) ? f.images.length : 0,
    likes: Number(f.like_count) || 0,
    comments: Number(f.comment_count) || 0,
  }
}

/** 看某人的空间动态（默认看自己） */
export async function fetchFeeds(bridge, hostUin = '', limit = 8) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  try {
    const { qzoneFeeds } = await import('./qzone-http.mjs')
    const r = await qzoneFeeds(bridge, { uin: hostUin || '', num: Math.max(1, Math.min(20, limit)) })
    if (!r.ok) return { ok: false, error: r.message || ('code ' + r.code) }
    return { ok: true, feeds: r.list.slice(0, limit) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

export async function likeFeed(bridge, tid, uin = '') {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  if (!tid) return { ok: false, error: '缺少动态 ID' }
  try {
    const { qzoneLike } = await import('./qzone-http.mjs')
    const r = await qzoneLike(bridge, { uin, tid: String(tid) })
    return r.ok ? { ok: true } : { ok: false, error: r.message || ('code ' + r.code) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

export async function commentFeed(bridge, tid, content, uin = '') {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  const text = String(content || '').trim()
  if (!tid) return { ok: false, error: '缺少动态 ID' }
  if (!text) return { ok: false, error: '评论内容为空' }
  try {
    const { qzoneComment } = await import('./qzone-http.mjs')
    const r = await qzoneComment(bridge, { uin, tid: String(tid), content: text.slice(0, 200) })
    return r.ok ? { ok: true, text } : { ok: false, error: r.message || ('code ' + r.code) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

/** 回复某条评论（楼中楼） */
export async function replyFeed(bridge, { uin, tid, commentTid, commentUin, content }) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  if (!tid) return { ok: false, error: '缺少动态 ID' }
  const text = String(content || '').trim()
  if (!text) return { ok: false, error: '回复内容为空' }
  try {
    const { qzoneReply } = await import('./qzone-http.mjs')
    const r = await qzoneReply(bridge, { uin, tid: String(tid), commentTid: String(commentTid || ''), commentUin: String(commentUin || ''), replyUin: String(commentUin || ''), content: text.slice(0, 200) })
    return r.ok ? { ok: true, text } : { ok: false, error: r.message || ('code ' + r.code) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

/** 删一条说说 */
export async function deleteFeed(bridge, tid) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  if (!tid) return { ok: false, error: '缺少动态 ID' }
  try {
    const { qzoneDelete } = await import('./qzone-http.mjs')
    const r = await qzoneDelete(bridge, { tid: String(tid) })
    return r.ok ? { ok: true } : { ok: false, error: r.message || ('code ' + r.code) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

// ============================================================ 配图
// NapCat 的 send_qzone_msg 支持 images: [file:// | http(s):// | base64://]，会自动上传到空间。
// 容器里看不到宿主路径，所以统一转 base64；太大先 ffmpeg 压到 720px 再转。
const QZONE_IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

function qzoneImageDir() {
  const dir = join(dshHome(), 'qq-fish', 'qzone', 'images')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

function toBase64Url(file) {
  try {
    let buf = readFileSync(file)
    if (buf.length > 1_200_000) {
      const out = join(qzoneImageDir(), '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.jpg')
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=720:-2', '-frames:v', '1', '-q:v', '4', out], { timeout: 30_000 })
        buf = readFileSync(out)
        try { unlinkSync(out) } catch {}
      } catch {}
    }
    if (buf.length > 4_000_000) return null
    return 'base64://' + buf.toString('base64')
  } catch {
    return null
  }
}

const MOOD_WORDS = [
  { mood: '开心', words: ['开心', '高兴', '好耶', '哈哈', '笑', '快乐', '喜欢'] },
  { mood: '无语', words: ['无语', '服了', '离谱', '算了', '麻了'] },
  { mood: '生气', words: ['气', '烦', '讨厌', '滚', '怒'] },
  { mood: '委屈', words: ['委屈', '难过', '想哭', '伤心', '失落'] },
  { mood: '撒娇', words: ['抱', '亲', '想你', '陪', '摸摸'] },
  { mood: '困累', words: ['困', '累', '睡', '熬夜', '摆烂'] },
  { mood: '得意', words: ['厉害', '牛', '赢', '棒', '聪明'] },
  { mood: '害羞', words: ['害羞', '脸红', '羞'] },
]

function moodOfText(text) {
  const s = String(text || '').toLowerCase()
  // 按「命中词数量」打分，数量相同看谁出现在更靠后的位置（结尾的情绪更真实）
  let best = '', bestScore = 0, bestPos = -1
  for (const m of MOOD_WORDS) {
    let score = 0
    let pos = -1
    for (const w of m.words) {
      let i = s.indexOf(w)
      while (i >= 0) {
        score += 1
        if (i > pos) pos = i
        i = s.indexOf(w, i + w.length)
      }
    }
    if (!score) continue
    if (score > bestScore || (score === bestScore && pos > bestPos)) {
      best = m.mood; bestScore = score; bestPos = pos
    }
  }
  return best
}

/**
 * 挑 1~2 张配图：优先用 ~/.dsh/qq-fish/qzone/images/ 里主人放的图，
 * 没有再按正文情绪从她的表情包库里挑（避免每次同一张：按日期+随机打散）。
 * 返回 base64:// 数组；没有可用图返回 []。
 */
let lastPicks = []
export function lastQzoneImageFiles() { return lastPicks.slice() }

export function pickQzoneImages(config, text, count = 1) {
  const n = Math.max(0, Math.min(3, Math.round(Number(count) || 0)))
  lastPicks = []
  if (!n) return []
  const out = []
  // 1) 主人专用配图目录
  try {
    const dir = qzoneImageDir()
    const files = readdirSync(dir)
      .filter((f) => !f.startsWith('.') && QZONE_IMG_EXT.has(extname(f).toLowerCase()))
      .map((f) => join(dir, f))
      .filter((f) => { try { return statSync(f).size > 1024 } catch { return false } })
    if (files.length) {
      const shuffled = files.slice().sort(() => Math.random() - 0.5)
      for (const f of shuffled) {
        const u = toBase64Url(f)
        if (u) { out.push(u); lastPicks.push('images/' + f.split('/').pop()) }
        if (out.length >= n) return out
      }
    }
  } catch {}
  // 2) 表情包库
  try {
    const all = listStickers().filter((s) => s && s.file)
    if (!all.length) return out
    const mood = moodOfText(text)
    let pool = mood ? all.filter((s) => String(s.mood || '') === mood) : []
    if (pool.length < 6) pool = all.slice()
    const shuffled = pool.slice().sort(() => Math.random() - 0.5)
    for (const st of shuffled) {
      const f = join(stickerDir(), String(st.file))
      if (!existsSync(f)) continue
      const u = toBase64Url(f)
      if (!u) continue
      out.push(u)
      lastPicks.push(String(st.file) + (st.desc ? ' · ' + String(st.desc).slice(0, 24) : ''))
      if (out.length >= n) break
    }
  } catch {}
  return out
}

export async function postQzone(bridge, content, opts = {}) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线' }
  const text = String(content || '').trim()
  if (!text) return { ok: false, error: '说说内容为空' }
  const images = Array.isArray(opts.images) ? opts.images.filter(Boolean).slice(0, 6) : []
  const payload = { content: text.slice(0, 500) }
  if (images.length) payload.images = images
  if (opts.ugcRight) payload.ugc_right = Number(opts.ugcRight)
  try {
    const r = await bridge.call('send_qzone_msg', payload)
    return { ok: true, text, images: images.length, tid: (r && (r.tid || (r.data && r.data.tid))) || '' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

/**
 * 给模型的「空间」提示：告诉她能看到什么、能做什么。
 * recentFeeds 是刚拉到的动态（可选），让她知道现在空间里有什么。
 */
let feedCache = { at: 0, feeds: [] }

export function cachedFeeds() {
  return Date.now() - feedCache.at < 600_000 ? feedCache.feeds : []
}

export async function refreshFeedCache(bridge, { maxAgeMs = 600_000, limit = 5 } = {}) {
  if (Date.now() - feedCache.at < maxAgeMs) return feedCache.feeds
  try {
    const { qzoneFeeds } = await import('./qzone-http.mjs')
    const r = await qzoneFeeds(bridge, { num: Math.max(1, Math.min(10, limit)) })
    if (r.ok && r.list.length) feedCache = { at: Date.now(), feeds: r.list.slice(0, limit) }
    return feedCache.feeds
  } catch {
    return feedCache.feeds
  }
}

// 【主人空间】主人最近发的说说也缓存一份，她才知道该给谁点赞/评论（uin/tid 形式）
let ownerFeedCache = { at: 0, uin: '', feeds: [] }

export function cachedOwnerFeeds(uin) {
  const u = String(uin || '')
  return u && ownerFeedCache.uin === u && Date.now() - ownerFeedCache.at < 600_000 ? ownerFeedCache.feeds : []
}

export async function refreshOwnerFeeds(bridge, uin, { maxAgeMs = 600_000, limit = 3 } = {}) {
  const u = String(uin || '').trim()
  if (!u) return []
  if (ownerFeedCache.uin === u && Date.now() - ownerFeedCache.at < maxAgeMs) return ownerFeedCache.feeds
  try {
    const { qzoneFeeds } = await import('./qzone-http.mjs')
    const r = await qzoneFeeds(bridge, { uin: u, num: Math.max(1, Math.min(5, limit)) })
    if (r.ok && r.list.length) ownerFeedCache = { at: Date.now(), uin: u, feeds: r.list.slice(0, limit) }
    return ownerFeedCache.uin === u ? ownerFeedCache.feeds : []
  } catch (e) {
    return cachedOwnerFeeds(u)
  }
}

// ============================================================ 空间评论
// 【2026-11-12】以前 qzonePromptBlock 只给「赞 X 评 N」的计数，评论内容从来没进过模型视野，
// 所以主人问「我空间里给你评论了啥」她只能瞎猜。qzone-http 的 qzoneFeeds/qzoneDetail
// 其实已经拿到 commentlist（tid 是小整数 "1"/"2"，还有 uin/content/createTime2），
// 这里补三件事：① 缓存 ② 拼成人能读的提示词块 ③ 给 [qzone:comments] 指令用。
let commentCache = { at: 0, ownerUin: '', items: [] }

export function cachedComments() {
  return Date.now() - commentCache.at < 600_000 ? commentCache.items : []
}

/**
 * 评论时间。优先用 qzone-http 清洗后的 atText（"11-12 00:56"），
 * 其次从原始字段推：createTime2 是 "2026-11-12 00:56:20"，create_time 是秒级时间戳，
 * at 是毫秒时间戳。（旧代码只读 createTime="00:56" → NaN → 时间全丢，所以这里三种都兜。）
 */
function commentTimeOf(c) {
  const m = c || {}
  const fmt = (ms) => {
    const d = new Date(ms)
    if (!Number.isFinite(d.getTime())) return ''
    const p2 = (x) => String(x).padStart(2, '0')
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  const t2 = String(m.createTime2 || '')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t2)) return t2.slice(5, 16) // MM-DD HH:mm
  const atMs = Number(m.at)
  if (Number.isFinite(atMs) && atMs > 1e12) return fmt(atMs)
  const sec = Number(m.create_time || m.at)
  if (Number.isFinite(sec) && sec > 1e9) return fmt(sec * 1000)
  return ''
}

/** [em]e328062[/em] 这类 QQ 表情代码别往提示词里塞 */
function cleanCommentName(name, uin, ownerUin) {
  const u = String(uin || '').replace(/\D/g, '')
  if (ownerUin && u === String(ownerUin).replace(/\D/g, '')) return '主人'
  // 真实数据里 name 常是 "[em]e328062[/em]" 这种 QQ 表情代码——不能原样塞进提示词
  const n = String(name || '').replace(/\[em\][^\[]*\[\/em\]/gi, '').replace(/\[[^\]]*\]/g, '').trim()
  if (!n) return u ? '（QQ ' + u + '）' : '某人'
  return n.slice(0, 12)
}

/**
 * 把【自己最近说说 + 各自评论】拉下来。返回
 * { ok, feeds, items:[{tid, feedTid, feedText, uin, name, text, commentTid, atText, isOwner}], ownerUin }
 */
export function mapFeedComments(feeds, { ownerUin = '', commentLimit = 8 } = {}) {
  const owner = String(ownerUin || '').replace(/\D/g, '')
  const items = []
  for (const f of (Array.isArray(feeds) ? feeds : [])) {
    const cs = Array.isArray(f && f.comments) ? f.comments : []
    for (const c of cs) {
      const uin = String(c.uin || '').replace(/\D/g, '')
      items.push({
        tid: String(f.tid || ''),
        feedText: String(f.text || '').replace(/\s+/g, ' ').slice(0, 40),
        feedAt: Number(f.at) || 0,
        uin,
        name: cleanCommentName(c.name, uin, owner),
        text: String(c.text || '').replace(/\s+/g, ' ').slice(0, 40),
        commentTid: String(c.tid || ''),
        atText: String(c.atText || '') || commentTimeOf(c),
        isOwner: !!(owner && uin === owner),
      })
    }
  }
  // 主人留的排前面（主人问「我评论了啥」时最常要的就是这个），其余按说说时间新→旧
  items.sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || (b.feedAt - a.feedAt))
  return items.slice(0, Math.max(1, Math.min(20, commentLimit)))
}

export async function fetchOwnComments(bridge, { limit = 5, commentLimit = 8, ownerUin = '' } = {}) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, error: 'QQ 桥不在线', items: [], feeds: 0 }
  try {
    const { qzoneFeeds } = await import('./qzone-http.mjs')
    const r = await qzoneFeeds(bridge, { num: Math.max(1, Math.min(10, limit)) })
    if (!r.ok) return { ok: false, error: r.message || ('code ' + r.code), items: [], feeds: 0 }
    const out = mapFeedComments(r.list || [], { ownerUin, commentLimit })
    commentCache = { at: Date.now(), ownerUin: String(ownerUin || ''), items: out }
    return { ok: true, feeds: (r.list || []).length, total: out.length, items: out, ownerUin: String(r.self || '').replace(/\D/g, '') }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160), items: [], feeds: 0 }
  }
}

/** 缓存刷新：主人私聊时每 10 分钟最多拉一次，失败就沿用旧的 */
export async function refreshCommentCache(bridge, { ownerUin = '', maxAgeMs = 600_000, limit = 5 } = {}) {
  if (Date.now() - commentCache.at < maxAgeMs && commentCache.items.length) return commentCache.items
  const r = await fetchOwnComments(bridge, { limit, ownerUin })
  return r.ok ? r.items : commentCache.items
}

/**
 * 拼成给模型看的「别人最近给你留的评论」。
 * 每条只给 essentials：谁、哪条说说、评论内容、评论ID、时间——最长 8 条、每条 40 字内。
 */
export function formatCommentsBlock(items, opts = {}) {
  const list = Array.isArray(items) ? items.slice(0, 8) : []
  if (!list.length) return ''
  const ownerUin = String(opts.ownerUin || '')
  // header=false 时只出条目——[qzone:comments] 那条路径外面已经有一层【刚查到的空间评论】了，
  // 两层标题叠在一起会显得像两份数据。
  const lines = opts.header === false ? [] : ['【别人最近给你的说说留的评论】（真实数据，回答时直接引用，别编）']
  for (const c of list) {
    const who = c.isOwner || (ownerUin && String(c.uin) === String(ownerUin).replace(/\D/g, '')) ? '主人' : (c.name || c.uin || '某人')
    // 回复时要写 uin/tid（自己的说说 tid 不用带 uin）
    const ref = String(c.tid || '')
    const parts = [`· ${who}`]
    if (c.atText) parts.push(c.atText)
    parts.push('在「' + String(c.feedText || '（无文字）').slice(0, 24) + '」下说：「' + String(c.text || '').slice(0, 40) + '」')
    parts.push('评论ID=' + String(c.commentTid || '') + '（回复用 [qzone:reply:' + ref + ':' + String(c.commentTid || '') + ':你想说的话]）')
    lines.push(parts.join('｜'))
  }
  lines.push('· 主人问「我给你评论了啥」就照上面这几条说，别猜。要回复某一条，就用对应那行的 [qzone:reply:...] 写法。')
  return lines.join('\n')
}

export function qzonePromptBlock(recentFeeds = [], opts = {}) {
  const lines = [
    '【QQ 空间】你能发说说、看动态、点赞、评论、回复评论、删自己的说说。',
    '· [qzone:post:想发的内容] 发一条自己的说说（真的会发出去，好友都能看见，想清楚再发）',
    '· [qzone:look] 看一眼自己空间最近的动态（会拿到每条的 tid）',
    '· [qzone:like:tid] 给某条说说点赞；[qzone:comment:tid:内容] 在下面评论',
    '· [qzone:reply:tid:评论ID:内容] 回复别人给你的评论（tid/评论ID 直接用下面「别人给你的说说留的评论」里给好的那两个数）',
    '· [qzone:comments] 真的去翻一遍你最近 5 条说说下面别人留的评论（拿不准有没有人评论、或被问「我给你评论了啥」时用它）',
    '· 对方不是你自己的说说时，tid 写成 uin/tid（如 10001/abc123，uin 用上面给你的那个）',
    '· [qzone:delete:tid] 删掉自己的一条说说（想清楚，删了就没了）',
    '· 配图你自己不用管：发的时候会按这条说说的情绪自动配一张图。',
    '· 不要天天发，真有话说、或者刚好想留下点什么的时候才发。',
    '· 重要：主人明确让你去点赞/评论/回复某条说说时，你必须真的写出对应标记（例：[qzone:like:10001/abc123]），先把标记写在回复里再说话；只嘴上答应相当于没做。',
  ]
  const list = recentFeeds && recentFeeds.length ? recentFeeds : cachedFeeds()
  if (list && list.length) {
    const rows = list.slice(0, 5).map((f) => `  · tid=${f.tid}｜${f.text.slice(0, 60)}｜赞 ${f.likes} 评 ${f.comments}`)
    lines.push('· 她自己空间里最近的说说（tid 可以直接拿去做 like/comment/delete）：')
    lines.push(...rows)
  }
  const ownerUin = String(opts.ownerUin || '')
  const ownerFeeds = ownerUin
    ? (opts.ownerFeeds && opts.ownerFeeds.length ? opts.ownerFeeds : cachedOwnerFeeds(ownerUin))
    : []
  if (ownerFeeds && ownerFeeds.length) {
    lines.push('· 主人空间里最近的说说（主人说「给我最新那条点赞/评论」就是第一条；tid 要写成 ' + ownerUin + '/tid）：')
    lines.push(...ownerFeeds.slice(0, 3).map((f) => {
      const t = String(f.text || '').replace(/\s+/g, ' ').slice(0, 50)
      return `  · ${ownerUin}/${f.tid}｜${t}｜赞 ${f.likes} 评 ${f.comments}`
    }))
  }
  // 【别人给你的说说留的评论】以前这里只有「赞 X 评 N」的计数，评论内容从来没进过上下文，
  // 主人问「我空间里给你评论了啥」她就答不上来。现在直接把真实评论逐条摆出来。
  const commentItems = Array.isArray(opts.comments) && opts.comments.length
    ? opts.comments
    : cachedComments()
  const cmBlock = formatCommentsBlock(commentItems, { ownerUin })
  if (cmBlock) lines.push('', cmBlock)
  return lines.join('\n')
}

/** 解析回复里的 [qzone:...] 指令，返回 { text, jobs } */
export function extractQzoneDirectives(reply) {
  let text = String(reply || '')
  const jobs = []
  const re = /\[{1,2}\s*qzone\s*[:：]\s*([^\]\n]{1,200})\]{1,2}/gi
  let m
  while ((m = re.exec(text))) {
    const body = String(m[1] || '').trim()
    const parts = body.split(/[:：]/)
    const action = String(parts[0] || '').toLowerCase()
    const ref = (v) => {
      const raw = String(v || '').trim()
      const m2 = /^(\d{5,12})[/／](.+)$/.exec(raw)
      return m2 ? { uin: m2[1], tid: m2[2].trim() } : { uin: '', tid: raw }
    }
    if (action === 'look') jobs.push({ action: 'look' })
    else if (action === 'comments' || action === 'comment-list' || action === 'readcomments') jobs.push({ action: 'comments' })
    else if (action === 'like' && parts[1]) jobs.push({ action: 'like', ...ref(parts[1]) })
    else if (action === 'comment' && parts[1]) jobs.push({ action: 'comment', ...ref(parts[1]), content: parts.slice(2).join(':').trim() })
    else if (action === 'reply' && parts[1]) {
      const r2 = ref(parts[1])
      const cid = parts[2] ? parts[2].trim() : ''
      jobs.push({ action: 'reply', ...r2, commentTid: cid, content: parts.slice(3).join(':').trim() })
    }
    else if (action === 'delete' && parts[1]) jobs.push({ action: 'delete', ...ref(parts[1]) })
    else if (action === 'post' && parts.length > 1) jobs.push({ action: 'post', content: body.slice(body.indexOf(':') + 1).trim() })
    text = text.replace(m[0], '')
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), jobs }
}
