/**
 * lib/qzone-http.mjs — QQ 空间 HTTP 通道（移植自 AstrBot astrbot_plugin_qzone）
 * ============================================================================
 * 为什么不走 NapCat 的 qzone 扩展接口：那里只开了「发说说 / 删说说」两个，
 * 看动态、点赞、评论、回复评论全都调不到。这里直接按旧插件的做法打空间 CGI：
 *
 *   1. 向 NapCat 要 cookie：get_cookies(domain="user.qzone.qq.com")
 *   2. 从 cookie 拆 uin / skey / p_skey
 *   3. g_tk = djb2(p_skey) & 0x7FFFFFFF
 *   4. 带 referer/origin/cookie 打 user.qzone.qq.com 的 cgi
 *
 * 登录失效判定：HTTP 401 或 code == -3000 → 重新取 cookie 重试一次。
 * ============================================================================
 */
import https from 'node:https'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const BASE_URL = 'https://user.qzone.qq.com'
const LIKE_BASE_URL = 'http://user.qzone.qq.com'
const H5_URL = 'https://h5.qzone.qq.com'

const URLS = {
  publish: BASE_URL + '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6',
  list: BASE_URL + '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6',
  detail: BASE_URL + '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6',
  dolike: BASE_URL + '/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app',
  comment: BASE_URL + '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds',
  replyH5: H5_URL + '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds',
  delete: H5_URL + '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6',
  upload: 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image',
  zoneList: BASE_URL + '/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more',
  visitor: H5_URL + '/proxy/domain/g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_more',
}

const CODE_LOGIN_EXPIRED = -3000
const TTL_MS = 600_000

let cache = { at: 0, ctx: null }

export function invalidateQzoneCtx() {
  cache = { at: 0, ctx: null }
}

function parseCookieString(str) {
  const out = {}
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function gtk2Of(pSkey) {
  let h = 5381
  for (let i = 0; i < pSkey.length; i += 1) h += (h << 5) + pSkey.charCodeAt(i)
  return String(h & 0x7fffffff)
}

/** 拿（并缓存 10 分钟）空间登录上下文 */
export async function qzoneCtx(bridge, { force = false } = {}) {
  const now = Date.now()
  if (!force && cache.ctx && now - cache.at < TTL_MS) return cache.ctx
  if (!bridge || typeof bridge.call !== 'function') throw new Error('QQ 桥不可用')
  let payload = null
  try {
    payload = await bridge.call('get_cookies', { domain: 'user.qzone.qq.com' })
  } catch (e) {
    throw new Error('取空间 cookie 失败：' + (e && e.message))
  }
  const raw = typeof payload === 'string' ? payload : String((payload && payload.cookies) || '')
  if (!raw.trim()) throw new Error('NapCat 没有返回空间 cookie（QQ 可能没登录）')
  const c = parseCookieString(raw)
  const uin = String(c.uin || c.p_uin || '').replace(/^o/i, '').replace(/\D/g, '')
  const skey = String(c.skey || '')
  const pSkey = String(c.p_skey || c.skey || '')
  if (!uin || !skey) throw new Error('空间 cookie 缺 uin/skey，可能未登录空间')
  const ctx = {
    uin,
    skey,
    pSkey,
    gtk: gtk2Of(pSkey),
    cookieHeader: `uin=o${uin}; skey=${skey}; p_skey=${pSkey}`,
  }
  cache = { at: now, ctx }
  return ctx
}

function pickData(raw) {
  if (!raw || typeof raw !== 'object') return {}
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) return raw.data
  return raw
}

function parsePayload(text) {
  const s = String(text || '').trim()
  if (!s) return null
  let jsonStr = s
  const m = s.match(/callback\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/i)
  if (m && m[1]) jsonStr = m[1]
  const a = jsonStr.indexOf('{')
  const b = jsonStr.lastIndexOf('}')
  if (a < 0 || b < a) return null
  jsonStr = jsonStr.slice(a, b + 1).replace(/\bundefined\b/g, 'null')
  try {
    return JSON.parse(jsonStr)
  } catch {
    return null
  }
}

function rawRequest(method, url, { params, form, headers = {}, ctx, timeoutMs = 20000 } = {}) {
  const u = new URL(url)
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  const lib = u.protocol === 'http:' ? http : https
  const body = form ? new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null)).toString() : null
  const h = {
    'User-Agent': UA,
    referer: `${BASE_URL}/${ctx ? ctx.uin : ''}`,
    origin: BASE_URL,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...headers,
  }
  if (ctx) h.cookie = ctx.cookieHeader
  if (body) {
    h['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    h['content-length'] = Buffer.byteLength(body)
  }
  return new Promise((resolve, reject) => {
    const req = lib.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('空间请求超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function call(bridge, method, url, opts, { retry = 1 } = {}) {
  let ctx = await qzoneCtx(bridge)
  const r = await rawRequest(method, url, { ...opts, ctx })
  const data = parsePayload(r.text)
  const code = Number((data && (data.code != null ? data.code : data.ret)) != null ? (data && (data.code != null ? data.code : data.ret)) : 0)
  const expired = r.status === 401 || code === CODE_LOGIN_EXPIRED || (data && data.data && Number(data.data.ret) === CODE_LOGIN_EXPIRED)
  if (expired && retry > 0) {
    invalidateQzoneCtx()
    return call(bridge, method, url, opts, { retry: retry - 1 })
  }
  return { ok: code === 0 && r.status < 400, code, status: r.status, message: (data && (data.message || data.msg)) || '', data, raw: data, text: String(r.text || '') }
}

/* ------------------------------------------------------------------ 发说说 */

async function uploadImage(ctx, buf, bridge) {
  const form = {
    filename: 'filename',
    uploadtype: '1',
    albumtype: '7',
    skey: ctx.skey,
    uin: ctx.uin,
    p_skey: ctx.pSkey,
    output_type: 'json',
    base64: '1',
    picfile: buf.toString('base64'),
  }
  const r = await rawRequest('POST', URLS.upload, {
    form,
    ctx,
    timeoutMs: 60000,
    headers: { referer: `${BASE_URL}/${ctx.uin}`, origin: BASE_URL },
  })
  const data = parsePayload(r.text)
  if (!data || Number(data.code) !== 0 || !data.data || !data.data.url) {
    throw new Error('上传图片失败：' + ((data && (data.message || data.msg)) || r.status))
  }
  const url = String(data.data.url)
  const picbo = url.includes('&bo=') ? url.split('&bo=')[1].split('&')[0] : ''
  const d = data.data
  const richval = `,${d.albumid},${d.lloc},${d.sloc},${d.type},${d.height},${d.width},${d.height},${d.width}`
  return { picbo, richval }
}

/** 发一条说说；images 为 Buffer[]（可选） */
export async function qzonePublish(bridge, { text, images = [], ugcRight = 1 }) {
  const ctx = await qzoneCtx(bridge)
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    who: '1',
    con: String(text || ''),
    feedversion: '1',
    ver: '1',
    ugc_right: String(ugcRight || 1),
    to_sign: '0',
    hostuin: ctx.uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${BASE_URL}/${ctx.uin}`,
  }
  if (images && images.length) {
    const pics = []
    const richs = []
    for (const buf of images.slice(0, 9)) {
      const one = await uploadImage(ctx, buf, bridge)
      pics.push(one.picbo)
      richs.push(one.richval)
    }
    form.pic_bo = pics.join(',')
    form.richtype = '1'
    form.richval = richs.join('\t')
  }
  const r = await call(bridge, 'POST', URLS.publish, { params: { g_tk: ctx.gtk, uin: ctx.uin }, form })
  const d = pickData(r.data)
  const tid = String(d.tid || d.feedid || (r.data && r.data.tid) || '')
  return { ok: r.ok, code: r.code, message: r.message, tid, data: r.data }
}

/* ------------------------------------------------------------------ 读动态 */

function pickImgList(raw) {
  const arr = Array.isArray(raw) ? raw : []
  return arr.map((it) => (typeof it === 'string' ? it : it && (it.url2 || it.url1 || it.url || it.pic_url || ''))).filter(Boolean)
}

function cleanFeed(f) {
  if (!f) return null
  return {
    tid: String(f.tid || f.feedid || ''),
    uin: String(f.uin || ''),
    name: String(f.nickname || f.name || f.uin || ''),
    at: Number(f.created_time || f.createTime || f.time || 0) * (String(f.created_time || '').length > 12 ? 1 : 1000),
    text: String(f.content || f.summary || '').replace(/\s+/g, ' ').slice(0, 500),
    images: pickImgList(f.pic),
    likes: (() => {
      const lk = f.like && typeof f.like === 'object' ? f.like : null
      return Number(f.like_count || f.likenum
        || (lk && (lk.num || lk.count || (Array.isArray(lk.list) ? lk.list.length : 0)))
        || 0)
    })(),
    likeList: (() => {
      const lk = f.like && typeof f.like === 'object' ? f.like : null
      const arr = lk && Array.isArray(lk.list) ? lk.list : []
      return arr.map((x) => ({ uin: String(x.uin || ''), name: String(x.name || x.nickname || '') }))
    })(),
    // 【2026-11-12】原来 at 取 c.createTime（"00:56" 这种字符串）→ NaN → 0，评论时间全丢。
    // 真实字段是 create_time（秒级时间戳）+ createTime2（"2026-11-12 00:56:20"），
    // atText 给提示词直接用（谁/什么时候/说了什么，时间不能少）。
    comments: Array.isArray(f.commentlist) ? f.commentlist.map((c) => {
      const sec = Number(c.create_time || c.createTime || c.time || 0)
      const atMs = Number.isFinite(sec) && sec > 1e9 ? sec * 1000 : 0
      const t2 = String(c.createTime2 || '')
      return {
        tid: String(c.tid || c.commentid || ''),
        uin: String(c.uin || ''),
        name: String(c.name || c.nickname || c.uin || ''),
        text: String(c.content || '').slice(0, 300),
        at: atMs,
        atText: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t2) ? t2.slice(5, 16) : '',
      }
    }) : [],
  }
}

/** 看某个 QQ 的说说列表（默认自己） */
export async function qzoneFeeds(bridge, { uin, pos = 0, num = 10 } = {}) {
  const ctx = await qzoneCtx(bridge)
  const target = String(uin || ctx.uin).replace(/\D/g, '') || ctx.uin
  const r = await call(bridge, 'GET', URLS.list, {
    params: {
      g_tk: ctx.gtk,
      uin: target,
      ftype: 0,
      sort: 0,
      pos,
      num,
      replynum: 100,
      callback: '_preloadCallback',
      code_version: 1,
      format: 'json',
      need_comment: 1,
      need_private_comment: 1,
      qzreferrer: `${BASE_URL}/${target}`,
    },
    headers: { referer: `${BASE_URL}/${target}` },
  })
  const d = pickData(r.data)
  const list = Array.isArray(d.msglist) ? d.msglist.map(cleanFeed).filter(Boolean) : []
  return { ok: r.ok, code: r.code, message: r.message, total: Number(d.total) || list.length, list, self: ctx.uin }
}

/** 好友动态流（feeds3_html_more，返回里 data.html 是 HTML，逐条抠 data-tid/data-uin） */
export async function qzoneZoneList(bridge, { page = 1, num = 12 } = {}) {
  const ctx = await qzoneCtx(bridge)
  const r = await call(bridge, 'GET', URLS.zoneList, {
    params: {
      g_tk: ctx.gtk,
      uin: ctx.uin,
      scope: 0,
      view: 1,
      filter: 'all',
      flag: 1,
      applist: 'all',
      pagenum: Math.max(1, page),
      ic2: 1,
      nongame: 1,
      format: 'json',
      qzreferrer: `${BASE_URL}/${ctx.uin}`,
    },
    headers: { referer: `${BASE_URL}/${ctx.uin}` },
  })
  const d = pickData(r.data)
  const html = String((d && d.html) || '')
  const out = []
  const re = /<li[^>]*class="[^"]*fitem[^"]*"[^>]*>/gi
  const tags = [...html.matchAll(re)]
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i][0]
    const body = html.slice(tags[i].index + tag.length, i + 1 < tags.length ? tags[i + 1].index : html.length)
    const tid = (/data-tid="([^"]+)"/.exec(tag) || [])[1] || ''
    const uin = (/data-uin="([^"]+)"/.exec(tag) || [])[1] || ''
    if (!tid || !uin) continue
    let txt = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, ' ')
      .trim()
    if (txt.length > 200) txt = txt.slice(0, 200)
    out.push({ tid, uin, name: '', text: txt, images: (body.match(/<img/gi) || []).length, at: 0, likes: 0, comments: 0 })
    if (out.length >= num) break
  }
  return { ok: r.ok, code: r.code, message: r.message, list: out, count: out.length, _rawLen: html.length, _keys: Object.keys(r.data && typeof r.data === 'object' ? r.data : {}), _head: String(r.text || '').slice(0, 1800) }
}

/** 看某条说说详情（含全部评论） */
export async function qzoneDetail(bridge, { uin, tid }) {
  const ctx = await qzoneCtx(bridge)
  const target = String(uin || ctx.uin).replace(/\D/g, '') || ctx.uin
  const r = await call(bridge, 'GET', URLS.detail, {
    params: {
      g_tk: ctx.gtk,
      uin: target,
      tid: String(tid),
      ftype: 0,
      sort: 0,
      pos: 0,
      num: 50,
      replynum: 100,
      callback: '_preloadCallback',
      code_version: 1,
      format: 'json',
      need_comment: 1,
    },
  })
  const d = pickData(r.data)
  const one = Array.isArray(d.msglist) ? d.msglist[0] : d
  const feed = cleanFeed(one)
  const raw = one ? Object.fromEntries(Object.entries(one).filter(([k]) => /like|comment|tid|uin/i.test(k))) : null
  return { ok: r.ok, code: r.code, message: r.message, feed, raw, self: ctx.uin }
}

/* ------------------------------------------------------------------ 互动 */

/** 点赞（unikey/curkey 必须用 http://，用 https 会假成功） */
export async function qzoneLike(bridge, { uin, tid }) {
  const ctx = await qzoneCtx(bridge)
  const target = String(uin || '').replace(/\D/g, '') || ctx.uin
  const key = `${LIKE_BASE_URL}/${target}/mood/${tid}`
  const r = await call(bridge, 'POST', URLS.dolike, {
    params: { g_tk: ctx.gtk },
    form: {
      qzreferrer: `${BASE_URL}/${ctx.uin}`,
      opuin: ctx.uin,
      unikey: key,
      curkey: key,
      appid: 311,
      from: 1,
      typeid: 0,
      abstime: Math.floor(Date.now() / 1000),
      fid: String(tid),
      active: 0,
      format: 'json',
      fupdate: 1,
    },
  })
  return { ok: r.ok, code: r.code, message: r.message, data: r.data }
}

/** 在说说下发一条评论 */
export async function qzoneComment(bridge, { uin, tid, content }) {
  const ctx = await qzoneCtx(bridge)
  const target = String(uin || '').replace(/\D/g, '') || ctx.uin
  const r = await call(bridge, 'POST', URLS.comment, {
    params: { g_tk: ctx.gtk },
    form: {
      topicId: `${target}_${tid}__1`,
      uin: ctx.uin,
      hostUin: target,
      feedsType: 100,
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      plat: 'qzone',
      source: 'ic',
      platformid: 52,
      format: 'fs',
      ref: 'feeds',
      content: String(content || ''),
    },
  })
  return { ok: r.ok, code: r.code, message: r.message, data: r.data }
}

/** 回复某一条评论（楼中楼）：先走 PC 代理，明确失败再回退 h5 */
export async function qzoneReply(bridge, { uin, tid, commentTid, commentUin, replyUin, replyNick, content }) {
  const ctx = await qzoneCtx(bridge)
  const target = String(uin || '').replace(/\D/g, '') || ctx.uin
  const rUin = String(replyUin || commentUin || target).replace(/\D/g, '')
  const rNick = String(replyNick || rUin)
  const cUin = String(commentUin || rUin).replace(/\D/g, '')
  const text = String(content || '').startsWith('@{') ? String(content) : `@{uin:${rUin},nick:${rNick},auto:1} ${content}`
  const pc = await call(bridge, 'POST', URLS.comment, {
    params: { g_tk: ctx.gtk },
    form: {
      hostUin: target,
      topicId: `${target}_${tid}`,
      content: text,
      format: 'json',
      qzreferrer: `${BASE_URL}/${ctx.uin}/main`,
      commentId: String(commentTid || ''),
      replyUin: rUin,
      commentUin: cUin,
    },
  })
  if (pc.ok) return { ok: true, via: 'pc', code: pc.code, message: pc.message, data: pc.data }
  if (pc.code === 0) return { ok: false, via: 'pc', code: pc.code, message: 'PC 回复结果不明，未回退 h5', data: pc.data }
  const h5 = await call(bridge, 'POST', URLS.replyH5, {
    params: { g_tk: ctx.gtk },
    form: {
      topicId: `${target}_${tid}__1`,
      uin: ctx.uin,
      hostUin: target,
      feedsType: 100,
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      plat: 'qzone',
      source: 'ic',
      platformid: 50,
      format: 'fs',
      ref: 'feeds',
      content: text,
      commentId: String(commentTid || ''),
      commentUin: cUin,
      t1_uin: target,
      t1_tid: String(tid),
      t2_uin: rUin,
      t2_tid: String(commentTid || ''),
      richval: '',
      richtype: '',
      private: '0',
      paramstr: '2',
      qzreferrer: `${BASE_URL}/${ctx.uin}/main`,
    },
  })
  return { ok: h5.ok, via: 'h5', code: h5.code, message: h5.message, data: h5.data }
}

/** 删说说 */
export async function qzoneDelete(bridge, { tid }) {
  const ctx = await qzoneCtx(bridge)
  const r = await call(bridge, 'POST', URLS.delete, {
    params: { g_tk: ctx.gtk },
    form: {
      uin: ctx.uin,
      topicId: `${ctx.uin}_${tid}__1`,
      feedsType: 0,
      feedsFlag: 0,
      feedsKey: String(tid),
      feedsAppid: 311,
      feedsTime: Math.floor(Date.now() / 1000),
      fupdate: 1,
      ref: 'feeds',
      qzreferrer:
        'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds_html_module' +
        `?g_iframeUser=1&i_uin=${ctx.uin}&i_login_uin=${ctx.uin}` +
        '&mode=4&previewV8=1&style=35&version=8&needDelOpr=true',
    },
    headers: { referer: `https://user.qzone.qq.com/${ctx.uin}` },
  })
  return { ok: r.ok, code: r.code, message: r.message, data: r.data }
}

/** 好友最近动态（信息流） */
export async function qzoneRecentFeeds(bridge, { page = 1 } = {}) {
  const ctx = await qzoneCtx(bridge)
  const r = await call(bridge, 'GET', URLS.zoneList, {
    params: {
      uin: ctx.uin,
      scope: 0,
      view: 1,
      filter: 'all',
      flag: 1,
      applist: 'all',
      pagenum: page,
      aisortEndTime: 0,
      aisortOffset: 0,
      aisortBeginTime: 0,
      begintime: 0,
      format: 'json',
      g_tk: ctx.gtk,
      useutf8: 1,
      outputhtmlfeed: 1,
    },
  })
  return { ok: r.ok, code: r.code, message: r.message, data: r.data }
}

export const QZONE_HTTP_URLS = URLS
