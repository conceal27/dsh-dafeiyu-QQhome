/**
 * lib/bili/client.mjs — 真·B站客户端（归属：xingzhu）
 * ============================================================================
 * 让她像真人一样用 B站：刷首页推荐、看视频（读字幕）、看评论、翻历史、点赞、收藏。
 * 不做：投币、发弹幕、发评论。
 *
 * 关键技术点（都已实测通过）：
 *   · wbi 签名：nav 拿 img_key/sub_key → MIXIN_KEY_ENC_TAB 重排 → w_rid = md5(query + mixinKey)
 *   · 412 风控：需要完整的浏览器指纹（UA / Origin / Referer / sec-fetch 系列 / sec-ch-ua）+ 登录 cookie
 *   · 字幕：view 拿 cid → player/wbi/v2 拿 subtitle_url → 下载 JSON（纯文本，模型能读）
 *
 * 存储：无（凭据复用 bili/credentials.json，wbi key 进程内缓存 10 分钟）
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

const WBI_TTL_MS = 10 * 60 * 1000

export function biliPaths(home = os.homedir()) {
  const biliDir = path.join(home, '.dsh', 'qq-fish', 'bili')
  return { config: path.join(home, '.dsh', 'qq-fish', 'bili.config.json'), credentials: path.join(biliDir, 'credentials.json') }
}

function readJson(file, fallback = {}) {
  try {
    let t = fs.readFileSync(file, 'utf8')
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    return JSON.parse(t)
  } catch {
    return fallback
  }
}

/** 读凭据 + 组装浏览器指纹 headers */
export function loadAuth(home = os.homedir()) {
  const p = biliPaths(home)
  const cfg = readJson(p.config, {})
  const cred = readJson(p.credentials, {})
  // 【她的号优先】dedeuserid 是登录 cookie 所属账号；只有它缺失时才回退 bili.config 的 self（旧数据可能是主人的号）
  const dede = String(cred.dedeuserid || '').trim()
  const mid = String(dede || (cfg.self && cfg.self.mid) || '').trim()
  const parts = []
  const COOKIE_NAMES = { sessdata: 'SESSDATA', bili_jct: 'bili_jct', buvid3: 'buvid3', buvid4: 'buvid4', dedeuserid: 'DedeUserID' }
  for (const [k, name] of Object.entries(COOKIE_NAMES)) {
    const v = cred[k] || cred[k.toUpperCase()] || cred[name]
    if (v) parts.push(name + '=' + v)
  }
  const cookie = parts.join('; ')
  return {
    mid,
    uname: String((cfg.self && String(mid) === String(cfg.self.mid) ? cfg.self.name : '') || ''),
    cred,
    csrf: String(cred.bili_jct || ''),
    cookie,
    loggedIn: Boolean(cred.sessdata && cred.bili_jct),
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      ...(cookie ? { cookie } : {}),
    },
  }
}

// ── wbi 签名 ────────────────────────────────────────────────────────────────
let wbiCache = { imgKey: '', subKey: '', at: 0 }

function mixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

async function rawGet(url, headers, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    const txt = await res.text()
    try {
      return JSON.parse(txt)
    } catch {
      return { code: -999, message: '非 JSON 响应', raw: txt.slice(0, 200) }
    }
  } catch (e) {
    return { code: -998, message: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 拿/刷新 wbi key */
export async function ensureWbi(auth) {
  const now = Date.now()
  if (wbiCache.imgKey && wbiCache.subKey && now - wbiCache.at < WBI_TTL_MS) return wbiCache
  const nav = await rawGet('https://api.bilibili.com/x/web-interface/nav', auth.headers)
  const wbi = nav && nav.data && nav.data.wbi_img
  if (!wbi || !wbi.img_url || !wbi.sub_url) return null
  wbiCache = {
    imgKey: wbi.img_url.split('/').pop().split('.')[0],
    subKey: wbi.sub_url.split('/').pop().split('.')[0],
    at: now,
  }
  return wbiCache
}

function signQuery(params, imgKey, subKey) {
  const mk = mixinKey(imgKey + subKey)
  const wts = Math.round(Date.now() / 1000)
  const p = { ...params, wts }
  const q = Object.keys(p)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, '')))
    .join('&')
  return q + '&w_rid=' + crypto.createHash('md5').update(q + mk).digest('hex')
}

/** 带 wbi 签名的 GET */
export async function signedGet(endpoint, params, auth) {
  const keys = await ensureWbi(auth)
  if (!keys) return { code: -997, message: '拿不到 wbi key' }
  const q = signQuery(params || {}, keys.imgKey, keys.subKey)
  return rawGet(endpoint + '?' + q, auth.headers)
}

/** 带 csrf 的 POST（表单编码） */
export async function signedPost(endpoint, params, auth) {
  if (!auth.csrf) return { code: -996, message: '缺少 bili_jct，无法做写操作' }
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) body.set(k, String(v))
  body.set('csrf', auth.csrf)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    })
    const txt = await res.text()
    try {
      return JSON.parse(txt)
    } catch {
      return { code: -999, message: '非 JSON', raw: txt.slice(0, 200) }
    }
  } catch (e) {
    return { code: -998, message: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

// ── 业务接口 ────────────────────────────────────────────────────────────────

/** 登录状态 */
export async function getNav(auth) {
  const j = await rawGet('https://api.bilibili.com/x/web-interface/nav', auth.headers)
  const d = (j && j.data) || {}
  return { ok: j.code === 0, isLogin: !!d.isLogin, uname: d.uname || '', mid: d.mid || 0, level: d.level }
}

/** 首页推荐流（个性化，需要登录） */
export async function getRecommend(auth, count = 12) {
  const j = await signedGet(
    'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
    { fresh_type: 3, ps: Math.max(1, Math.min(30, count)), fresh_idx: 1, fresh_idx_1h: 1 },
    auth
  )
  const items = (j && j.data && (j.data.item || [])) || []
  return items
    .filter((v) => v && v.bvid)
    .map((v) => ({
      bvid: v.bvid,
      title: String(v.title || '').slice(0, 120),
      up: String((v.owner && v.owner.name) || ''),
      tname: String(v.tname || ''),
      duration: Number(v.duration) || 0,
      play: Number(v.stat && v.stat.view) || 0,
      desc: String(v.desc || '').slice(0, 300),
      reason: String(v.rcmd_reason && v.rcmd_reason.content || ''),
      pic: String(v.pic || (v.owner && v.owner.face) || ''),
    }))
}

/** 视频详情（含 cid） */
export async function getVideoInfo(auth, bvid) {
  const j = await rawGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), auth.headers)
  if (j.code !== 0 || !j.data) return null
  const d = j.data
  return {
    bvid,
    aid: d.aid,
    cid: d.cid,
    title: String(d.title || '').slice(0, 120),
    up: String((d.owner && d.owner.name) || ''),
    desc: String(d.desc || '').slice(0, 800),
    duration: Number(d.duration) || 0,
    tname: String(d.tname || ''),
    view: Number(d.stat && d.stat.view) || 0,
    like: Number(d.stat && d.stat.like) || 0,
    pages: (d.pages || []).length,
  }
}

/**
 * 取字幕（纯文本，模型可读）。
 * @returns {Promise<{ok:boolean, lang:string, text:string, lines:number, error?:string}>}
 */
export async function getSubtitle(auth, bvid, cid) {
  try {
    const pl = await signedGet('https://api.bilibili.com/x/player/wbi/v2', { bvid, cid }, auth)
    if (!pl || pl.code !== 0 || !pl.data) return { ok: false, lang: '', text: '', lines: 0, error: '播放信息拿不到 code=' + (pl && pl.code) }
    const subs = (pl.data.subtitle && pl.data.subtitle.subtitles) || []
    if (!subs.length) return { ok: false, lang: '', text: '', lines: 0, error: '这个视频没有字幕' }
    // 优先人工中文字幕，其次 AI 字幕
    const pick = subs.find((s) => s.lan === 'zh-CN' || s.lan === 'zh') || subs.find((s) => String(s.lan).startsWith('ai-zh')) || subs[0]
    let url = String(pick.subtitle_url || '')
    if (!url) return { ok: false, lang: '', text: '', lines: 0, error: '字幕地址为空' }
    if (url.startsWith('//')) url = 'https:' + url
    const body = await rawGet(url, { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, 20000)
    const list = (body && body.body) || []
    if (!list.length) return { ok: false, lang: '', text: '', lines: 0, error: '字幕内容为空' }
    const text = list.map((x) => String(x.content || '').trim()).filter(Boolean).join(' ')
    return { ok: true, lang: String(pick.lan || ''), text, lines: list.length }
  } catch (e) {
    return { ok: false, lang: '', text: '', lines: 0, error: String((e && e.message) || e) }
  }
}

/** 热门评论 */
/** 查她某条评论下的回复（root=rpid） */
export async function getCommentReplies(auth, aid, rpid, limit = 5) {
  const j = await rawGet(
    'https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + encodeURIComponent(aid) + '&root=' + encodeURIComponent(rpid) + '&ps=' + Math.max(1, Math.min(20, limit)),
    auth.headers
  )
  const replies = (j && j.data && j.data.replies) || []
  return replies.slice(0, limit).map((r) => ({
    user: String((r.member && r.member.uname) || ''),
    text: String((r.content && r.content.message) || '').slice(0, 200),
    like: Number(r.like) || 0,
  }))
}

export async function getComments(auth, aid, limit = 5) {
  const j = await rawGet(
    'https://api.bilibili.com/x/v2/reply?type=1&oid=' + encodeURIComponent(aid) + '&sort=2&ps=' + Math.max(1, Math.min(20, limit)),
    auth.headers
  )
  const replies = (j && j.data && j.data.replies) || []
  return replies.slice(0, limit).map((r) => ({
    user: String((r.member && r.member.uname) || ''),
    text: String((r.content && r.content.message) || '').slice(0, 300),
    like: Number(r.like) || 0,
  }))
}

/** 观看历史 */
export async function getHistory(auth, count = 10) {
  const j = await signedGet(
    'https://api.bilibili.com/x/web-interface/history/cursor',
    { max: 0, view_at: 0, business: '', ps: Math.max(1, Math.min(30, count)) },
    auth
  )
  const list = (j && j.data && j.data.list) || []
  return list.slice(0, count).map((h) => ({
    title: String(h.title || '').slice(0, 100),
    bvid: String((h.history && h.history.bvid) || h.bvid || ''),
    up: String((h.owner && h.owner.name) || ''),
    viewedAt: Number(h.view_at) || 0,
  }))
}

/** 点赞（做了就留下痕迹，慎用） */
export async function likeVideo(auth, aid, like = true) {
  const j = await signedPost('https://api.bilibili.com/x/web-interface/archive/like', { aid, like: like ? 1 : 2 }, auth)
  return { ok: j.code === 0, code: j.code, message: String(j.message || '') }
}

/**
 * 上报观看记录：让这个视频出现在账号的「历史记录」里。
 * progress 是看到第几秒（B 站用它算进度条）。
 */
export async function reportHistory(auth, { aid, cid, progress = 0 } = {}) {
  if (!auth || !auth.csrf) return { ok: false, error: '缺少 bili_jct' }
  if (!aid || !cid) return { ok: false, error: '缺少 aid/cid' }
  try {
    const j = await signedPost('https://api.bilibili.com/x/v2/history/report', {
      aid: Number(aid),
      cid: Number(cid),
      progress: Math.max(0, Math.round(Number(progress) || 0)),
      platform: 'web',
      csrf: auth.csrf,
    }, auth)
    return { ok: j && j.code === 0, code: j && j.code, message: String((j && j.message) || '') }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 找到（或创建）她的专属收藏夹。所有收藏都进这里，不污染其他收藏夹。
 */
export async function ensureFishFolder(auth) {
  if (!auth || !auth.mid) return { ok: false, error: 'B 站没登录' }
  let folders = []
  try {
    const list = await rawGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + auth.mid, auth.headers)
    folders = (list && list.data && list.data.list) || []
  } catch (e) {
    return { ok: false, error: '读收藏夹列表失败：' + ((e && e.message) || e) }
  }
  // 用她自己的默认收藏夹（标题叫「默认收藏夹」；没有就取第一个），不再新建
  const def = folders.find((x) => String(x.title || '').trim() === '默认收藏夹') || folders[0]
  if (def) return { ok: true, fid: Number(def.id), created: false, title: String(def.title || '') }
  return { ok: false, error: '她的账号里没有可用收藏夹' }
}

/** 收藏（优先塞进她自己的收藏夹） */
export async function favoriteVideo(auth, aid, fidOverride) {
  let fid = Number(fidOverride) || 0
  if (!fid) {
    try {
      const folder = await ensureFishFolder(auth)
      if (folder.ok) fid = folder.fid
    } catch {}
  }
  if (!fid) {
    const list = await rawGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + auth.mid, auth.headers)
    const folders = (list && list.data && list.data.list) || []
    fid = folders.length ? folders[0].id : 0
  }
  if (!fid) return { ok: false, code: -995, message: '没有可用的收藏夹' }
  const j = await signedPost('https://api.bilibili.com/x/v3/fav/resource/deal', { rid: aid, type: 2, add_media_ids: fid, del_media_ids: '' }, auth)
  return { ok: j.code === 0, code: j.code, message: String(j.message || ''), fid }
}

/**
 * 一次完整的「刷一会儿」：拿推荐 → 挑几个 → 读字幕和热评。
 * 返回的每个条目都带着「她实际读到的文本」，日报可以据此写真感想。
 */
export async function browse(auth, opts = {}) {
  const count = Math.max(1, Math.min(10, Number(opts.count) || 5))
  const wantSubtitle = opts.withSubtitle !== false
  const maxChars = Math.max(200, Math.min(4000, Number(opts.maxSubtitleChars) || 1200))

  const feed = await getRecommend(auth, count * 2)
  const out = []
  for (const v of feed) {
    if (out.length >= count) break
    const info = await getVideoInfo(auth, v.bvid)
    if (!info) continue
    let subtitle = ''
    let subLines = 0
    if (wantSubtitle) {
      const sub = await getSubtitle(auth, info.bvid, info.cid)
      if (sub.ok) {
        subtitle = sub.text.slice(0, maxChars)
        subLines = sub.lines
      } else if (typeof opts.onWarn === 'function') {
        opts.onWarn(info.title + ' → 字幕失败：' + sub.error)
      }
    }
    const comments = await getComments(auth, info.aid, 3)
    out.push({ ...v, ...info, subtitle, subLines, comments })
    // 轻微延迟，别把 B站 打太急
    await new Promise((r) => setTimeout(r, 300))
  }
  return out
}
