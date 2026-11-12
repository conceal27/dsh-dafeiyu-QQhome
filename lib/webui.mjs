/**
 * lib/webui.mjs — NapCat WebUI HTTP 客户端（归属：xingzhu）
 * ============================================================================
 * 只做一件事：把 NapCat WebUI 的 HTTP API 包成一个带「Credential 缓存 + 过期重登」
 * 的小客户端，供 lib/bridge.mjs 做登录/扫码/快速登录/OneBot 配置读写。
 *
 * 事实（来源：_research/qq/napcat-reference.md §4、§5，源码 api_Auth.ts / auth.ts）：
 *   1. 鉴权第一步：POST /api/auth/login
 *         body {hash: sha256(token + ".napcat") 的 hex}
 *      成功信封 {code:0,message:"success",data:{Credential:"<base64>"}}
 *   2. 后续所有请求带 Authorization: Bearer <Credential>（也支持 ?webui_token=）；
 *      Credential 解码后为 {Data:{CreatedTime,HashEncoded},Hmac}，有效期 3600 秒。
 *   3. 所有路由前缀 /api，返回信封 {code,message,data}，**HTTP 状态恒 200**，
 *      必须看 code；失败示例 {code:-1,message:"Unauthorized"}。
 *   4. 二维码接口 data.qrcode 是「二维码要编码的 URL 字符串」，不是图片。
 *   5. 常见错误 message：Unauthorized / token is invalid / login rate limit /
 *      QQ Is Logined / QRCode Get Error / uin is empty …
 *
 * 安全：
 *   - token 与 Credential 只留在内存，不进日志、不写面板响应（本模块日志由
 *     redact.createLogger 兜底脱敏）；
 *   - 只做本机 HTTP 客户端，不监听端口、不读写磁盘。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { createLogger } from './redact.mjs'

/** 默认连接 NapCat 默认端口（实际端口以 webui.json / 启动日志为准） */
export const DEFAULT_WEBUI_BASE_URL = 'http://127.0.0.1:6099'
/** 单次请求超时：8 秒（NapCat 本机接口正常都是毫秒级） */
export const DEFAULT_WEBUI_TIMEOUT_MS = 8000
/** Credential 服务端有效期：3600 秒 */
const CREDENTIAL_TTL_MS = 60 * 60 * 1000
/** 主动重登阈值：剩余 < 5 分钟时先换一张 Credential，避免请求途中过期 */
const CREDENTIAL_REFRESH_BEFORE_MS = 5 * 60 * 1000
/** 不鉴权的接口（登录自身） */
const LOGIN_PATH = '/api/auth/login'

/**
 * 算 WebUI 登录用的 hash：sha256(token + ".napcat") 的 hex。
 * 注意这不是 token 本身，照抄 NapCat helper/SignToken.ts 的 generatePasswordHash。
 */
export function hashWebuiToken(token) {
  return createHash('sha256').update(String(token || '') + '.napcat').digest('hex')
}

/**
 * 规整 baseUrl：补 http://、把 0.0.0.0/:: 换成 127.0.0.1、丢掉路径和查询参数。
 * NapCat 的 API 固定挂在根路径 /api 上；用户就算粘了面板地址
 * （http://127.0.0.1:6099/webui?token=xxx）也能自动纠正。
 */
export function normalizeBaseUrl(baseUrl) {
  let text = String(baseUrl || '').trim() || DEFAULT_WEBUI_BASE_URL
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text
  let url
  try {
    url = new URL(text)
  } catch {
    throw new NapCatWebUIError(`NapCat WebUI 地址不对：${text}（示例 http://127.0.0.1:6099）`, { kind: 'config' })
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '::') url.hostname = '127.0.0.1'
  if (!url.port && url.protocol === 'http:') url.port = '6099'
  return url.origin
}

/** WebUI 客户端错误：带 code/httpStatus/path/kind，路由层可直接展示 message */
export class NapCatWebUIError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'NapCatWebUIError'
    this.code = info.code
    this.httpStatus = info.httpStatus || 0
    this.path = info.path || ''
    this.kind = info.kind || 'api'
    this.detail = info.detail || ''
    if (info.cause) this.cause = info.cause
  }
}

/** NapCat 常见错误文案 → 人话（原文放在括号里，方便排障对日志） */
const MESSAGE_HINTS = [
  [/^QQ Is Logined$/i, 'QQ 已经登录了，不用再扫二维码'],
  [/^QRCode Get Error$/i, 'NapCat 还没生成好二维码（可能仍在启动），稍后再点「刷新二维码」'],
  [/^uin is empty$/i, '快速登录缺少 QQ 号'],
  [/^token is invalid$/i, 'WebUI token 不对：NapCat 重启后 token 可能变了，请重新读取 token'],
  [/^token is empty$/i, '请求里缺少 token'],
  [/^login rate limit$/i, 'WebUI 登录太频繁（默认每分钟最多 3 次），请等一分钟再试'],
  [/^Unauthorized$/i, 'WebUI 登录态失效了（Credential 过期或 NapCat 重启）'],
  [/^Authorization Failed$/i, 'WebUI 鉴权失败（Credential 不对）'],
  [/^Server token not initialized$/i, 'NapCat WebUI 还没初始化完成，稍等几秒再试'],
  [/^QRCode Refresh Error/i, '刷新二维码失败（NapCat 登录服务可能还没就绪）'],
]

/** 把 NapCat 的错误 message 翻成人话；没命中就保留原文并加前缀 */
function humanMessage(message) {
  const text = String(message || '').trim()
  if (!text) return 'NapCat WebUI 返回了错误（没有 message）'
  for (const [pattern, hint] of MESSAGE_HINTS) {
    if (pattern.test(text)) return `${hint}（NapCat 原文：${text}）`
  }
  return `NapCat WebUI 返回错误：${text}`
}

/** 判断是不是「登录态失效」类错误：清缓存重登一次再重试 */
function isAuthError(message, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return true
  const text = String(message || '')
  return /unauthorized|authorization failed|token has been revoked|token is invalid|token is empty|server token not initialized/i.test(text)
}

/** 把接口路径规整成 /api/... */
function normalizeApiPath(path) {
  let value = String(path || '').trim()
  if (!value) throw new NapCatWebUIError('NapCat WebUI 调用缺少接口路径')
  if (/^https?:\/\//i.test(value)) throw new NapCatWebUIError(`接口路径不能是完整 URL：${value}`)
  if (!value.startsWith('/')) value = '/' + value
  if (!/^\/api(\/|$)/i.test(value)) value = '/api' + value
  return value
}

function messageOf(error) {
  if (!error) return '未知错误'
  return String(error.message || error)
}

/** 日志适配：接受 createLogger 的形状，也接受单个函数；没给就造一个带前缀的 */
function normalizeLog(log, prefix) {
  if (log && typeof log.info === 'function' && typeof log.warn === 'function' && typeof log.error === 'function') return log
  if (typeof log === 'function') return { info: log, warn: log, error: log }
  return createLogger(prefix)
}

/**
 * NapCat WebUI 客户端。
 *
 * @example
 *   const webui = new NapCatWebUI({ baseUrl: 'http://127.0.0.1:6099', token })
 *   const { qrcode } = await webui.getQr()
 *   const st = await webui.checkStatus()
 */
export class NapCatWebUI {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] 形如 http://127.0.0.1:6099（可省略协议/端口）
   * @param {string} options.token     NapCat WebUI token（webui.json 里的 token）
   * @param {object|Function} [options.log] 日志对象；默认 createLogger('[qq-fish/webui]')
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   * @param {number} [options.timeoutMs=8000] 单请求超时
   * @param {Function} [options.now=Date.now] 时钟（测试用）
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.token = String(options.token || '').trim()
    this.log = normalizeLog(options.log, '[qq-fish/webui]')
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_WEBUI_TIMEOUT_MS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** Credential（base64 字符串）只在内存 */
    this.credential = ''
    this.credentialCreatedAt = 0
    this.credentialExpiresAt = 0
    this.lastError = ''
    this.disposed = false
    this._loginPromise = null
  }

  /** 换一个 token（例如 NapCat 重启后 token 变了）；会作废缓存 Credential */
  setToken(token) {
    this.token = String(token || '').trim()
    this.credential = ''
    this.credentialCreatedAt = 0
    this.credentialExpiresAt = 0
  }

  /** 换一个 baseUrl（注意会作废缓存 Credential） */
  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.credential = ''
    this.credentialExpiresAt = 0
  }

  /** 当前 Credential 是否还「足够新」（剩余 > 5 分钟才算够） */
  get credentialFresh() {
    if (!this.credential) return false
    return this.now() < this.credentialExpiresAt - CREDENTIAL_REFRESH_BEFORE_MS
  }

  /**
   * 登录换 Credential：POST /api/auth/login {hash}。
   * 并发调用会合并成一次（NapCat 登录有 loginRate 限速，别自己刷）。
   * @returns {Promise<{ok:true, createdAt:number, expiresAt:number}>}
   */
  async login(options = {}) {
    if (this.disposed) throw new NapCatWebUIError('WebUI 客户端已释放', { kind: 'disposed' })
    // 已有新鲜 Credential 就直接复用：NapCat 的 /api/auth/login 有 3 次/分钟限速，
    // 面板每 3 秒轮询登录态时不能每次都重新登录（否则会被自身的轮询打到限速）。
    if (!options.force && this.credentialFresh) {
      return { ok: true, createdAt: this.credentialCreatedAt, expiresAt: this.credentialExpiresAt, cached: true }
    }
    if (this._loginPromise) return this._loginPromise
    this._loginPromise = this._doLogin().finally(() => {
      this._loginPromise = null
    })
    return this._loginPromise
  }

  async _doLogin() {
    if (!this.token) {
      throw new NapCatWebUIError(
        '还没有 NapCat WebUI token：先在面板点「安装 / 启动 NapCat」，或把现有 WebUI 的 token 填进来',
        { kind: 'config' },
      )
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new NapCatWebUIError('当前 Node 环境没有 fetch，无法调用 NapCat WebUI', { kind: 'env' })
    }
    const hash = hashWebuiToken(this.token)
    const { status, payload, text } = await this._request(LOGIN_PATH, { hash }, {
      method: 'POST',
      authHeader: '',
      timeoutMs: this.timeoutMs,
    })
    if (!payload || typeof payload !== 'object') {
      throw new NapCatWebUIError(
        `NapCat WebUI 登录接口返回的不是 JSON（HTTP ${status}）：检查地址/端口是否指向 NapCat`,
        { kind: 'format', httpStatus: status, path: LOGIN_PATH, detail: String(text || '').slice(0, 200) },
      )
    }
    const detail = String(payload.message || '')
    if (payload.code !== 0) {
      const error = new NapCatWebUIError(humanMessage(detail) || 'WebUI 登录失败', {
        code: payload.code,
        httpStatus: status,
        path: LOGIN_PATH,
        detail,
        kind: isAuthError(detail, status) ? 'auth' : 'api',
      })
      this.lastError = error.message
      throw error
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
    if (data.require2FA) {
      throw new NapCatWebUIError(
        '这个 NapCat WebUI 开了两步验证（2FA），插件暂不支持自动登录：请在 NapCat WebUI 里关掉 2FA 再试',
        { kind: 'auth', path: LOGIN_PATH },
      )
    }
    const credential = String(data.Credential || '')
    if (!credential) {
      throw new NapCatWebUIError('NapCat WebUI 登录成功但没返回 Credential（版本不兼容？）', {
        kind: 'format',
        path: LOGIN_PATH,
        detail: JSON.stringify(data).slice(0, 200),
      })
    }
    const at = this.now()
    this.credential = credential
    this.credentialCreatedAt = at
    this.credentialExpiresAt = at + CREDENTIAL_TTL_MS
    this.lastError = ''
    this.log.info('NapCat WebUI 登录成功（Credential 已缓存，约 1 小时有效）')
    return { ok: true, createdAt: at, expiresAt: this.credentialExpiresAt }
  }

  /** 快过期的 Credential 先主动换掉；没有就登录 */
  async _ensureCredential() {
    if (this.credentialFresh) return
    await this.login()
  }

  /**
   * 调一个 NapCat WebUI 接口，返回信封里的 data；失败抛人话 Error。
   * 收到 Unauthorized 会自动重登一次再重试（只重试一次）。
   *
   * @param {string} path 例如 '/api/QQLogin/GetQQLoginQrcode'、'QQLogin/CheckLoginStatus'
   * @param {object} [body] JSON body（GET 时忽略）
   * @param {object} [opts]
   * @param {'GET'|'POST'|string} [opts.method='POST']
   * @param {number} [opts.timeoutMs]
   * @param {boolean} [opts.retryOnAuth=true]
   * @returns {Promise<any>} data
   */
  async call(path, body = {}, opts = {}) {
    if (this.disposed) throw new NapCatWebUIError('WebUI 客户端已释放', { kind: 'disposed' })
    if (typeof this.fetchImpl !== 'function') {
      throw new NapCatWebUIError('当前 Node 环境没有 fetch，无法调用 NapCat WebUI', { kind: 'env' })
    }
    const apiPath = normalizeApiPath(path)
    const method = String(opts.method || 'POST').toUpperCase()
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs
    const retryOnAuth = opts.retryOnAuth !== false
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this._ensureCredential()
      const { status, payload, text } = await this._request(apiPath, body, {
        method,
        authHeader: this.credential,
        timeoutMs,
      })
      const detail = payload && typeof payload === 'object' ? String(payload.message || '') : ''
      if (!payload || typeof payload !== 'object') {
        const error = new NapCatWebUIError(
          `NapCat WebUI 返回的不是 JSON（HTTP ${status}）：${apiPath}`,
          { kind: 'format', httpStatus: status, path: apiPath, detail: String(text || '').slice(0, 200) },
        )
        this.lastError = error.message
        throw error
      }
      if (payload.code === 0) return payload.data === undefined ? null : payload.data
      const authLike = isAuthError(detail, status)
      const error = new NapCatWebUIError(humanMessage(detail), {
        code: payload.code,
        httpStatus: status,
        path: apiPath,
        detail,
        kind: authLike ? 'auth' : 'api',
      })
      this.lastError = error.message
      if (authLike && retryOnAuth && attempt === 0) {
        this.log.warn('WebUI 登录态失效，自动重登一次后重试')
        this.credential = ''
        this.credentialCreatedAt = 0
        this.credentialExpiresAt = 0
        lastError = error
        continue
      }
      throw error
    }
    throw lastError || new NapCatWebUIError(`调用 ${apiPath} 失败`, { path: apiPath })
  }

  /** 真正发 HTTP 请求（不做鉴权重试），返回 {status, payload, text} */
  async _request(apiPath, body, options = {}) {
    const url = this.baseUrl + apiPath
    const method = String(options.method || 'POST').toUpperCase()
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs
    const headers = { accept: 'application/json' }
    let payloadBody
    if (method !== 'GET' && method !== 'HEAD') {
      headers['content-type'] = 'application/json'
      payloadBody = JSON.stringify(body === undefined ? {} : body)
    }
    if (options.authHeader) headers.authorization = `Bearer ${options.authHeader}`
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payloadBody,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw this._networkError(e, url, timeoutMs)
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    return { status: Number(response.status) || 0, payload, text }
  }

  /** 网络层错误 → 人话（连不上/端口不对/超时/被重置） */
  _networkError(error, url, timeoutMs) {
    const causeCode = (error && error.cause && error.cause.code) || (error && error.code) || ''
    const name = (error && error.name) || ''
    const isTimeout =
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
      causeCode === 'ETIMEDOUT'
    let message
    let kind = 'network'
    if (isTimeout) {
      kind = 'timeout'
      message = `请求 NapCat WebUI 超时（${Math.round(timeoutMs / 1000)} 秒）：${url}。若 NapCat 刚启动，稍后再试`
    } else if (causeCode === 'ECONNREFUSED') {
      kind = 'connect'
      message = `连不上 NapCat WebUI（${url}）：可能 NapCat 还没启动，或端口填错了`
    } else if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
      kind = 'connect'
      message = `解析不了 NapCat WebUI 地址（${url}）：地址写错了？`
    } else if (causeCode === 'ECONNRESET' || causeCode === 'EPIPE') {
      kind = 'connect'
      message = `连接 NapCat WebUI 被重置（${url}）：NapCat 可能刚重启，稍后再试`
    } else {
      message = `连接 NapCat WebUI 失败（${url}）：${messageOf(error)}`
    }
    const wrapped = new NapCatWebUIError(message, { kind, path: url, detail: messageOf(error), cause: error })
    this.lastError = wrapped.message
    return wrapped
  }

  /** 二维码：返回 {qrcode:"<二维码要编码的 URL 字符串>"}；已登录会抛「QQ 已经登录了」 */
  async getQr() {
    const data = await this.call('/api/QQLogin/GetQQLoginQrcode')
    const qrcode = data && typeof data.qrcode === 'string' ? data.qrcode.trim() : ''
    if (!qrcode) {
      throw new NapCatWebUIError('NapCat 还没生成二维码（可能仍在启动），稍后再点「刷新二维码」', {
        kind: 'empty',
        path: '/api/QQLogin/GetQQLoginQrcode',
      })
    }
    return { qrcode }
  }

  /** 登录态：{isLogin,isOffline,loginPhase,qrLoginAccepted,coreReady,qrcodeurl,loginError} */
  async checkStatus() {
    const data = await this.call('/api/QQLogin/CheckLoginStatus')
    const value = data && typeof data === 'object' ? data : {}
    return {
      isLogin: value.isLogin === true,
      isOffline: value.isOffline === true,
      loginPhase: String(value.loginPhase || ''),
      qrLoginAccepted: value.qrLoginAccepted === true,
      coreReady: value.coreReady === true,
      qrcodeurl: String(value.qrcodeurl || ''),
      loginError: String(value.loginError || ''),
    }
  }

  /** 刷新二维码：{qrcodeurl, restarting}；restarting=true 时「正在后台重启，别再点刷新」 */
  async refreshQr() {
    const data = await this.call('/api/QQLogin/RefreshQRcode')
    const value = data && typeof data === 'object' ? data : {}
    return {
      qrcodeurl: String(value.qrcodeurl || ''),
      restarting: value.restarting === true,
    }
  }

  /**
   * 快速登录列表：优先 GetQuickLoginListNew（含昵称/头像），失败退回旧版
   * GetQuickLoginList（string[]）。统一成 [{uin,nickname,avatarUrl,isQuickLogin,raw}]。
   */
  async quickList() {
    let data
    try {
      data = await this.call('/api/QQLogin/GetQuickLoginListNew')
    } catch (newError) {
      try {
        data = await this.call('/api/QQLogin/GetQuickLoginList')
      } catch {
        throw newError
      }
    }
    return normalizeQuickList(data)
  }

  /** 一键快速登录指定 QQ 号（上次登录过的号才能快登） */
  async quickLogin(uin) {
    const value = String(uin || '').replace(/\D/g, '')
    if (!value) throw new NapCatWebUIError('快速登录需要一个 QQ 号', { kind: 'config' })
    const data = await this.call('/api/QQLogin/SetQuickLogin', { uin: value })
    return data === undefined ? { ok: true, uin: value } : data
  }

  /** 当前登录账号信息（uin/user_id、nickname、avatarUrl、online） */
  async getLoginInfo() {
    const data = await this.call('/api/QQLogin/GetQQLoginInfo')
    return data && typeof data === 'object' ? data : {}
  }

  /** 读 OneBot 11 配置（data 若为 JSON 字符串会自动 parse 成对象） */
  async getOb11Config() {
    const data = await this.call('/api/OB11Config/GetConfig')
    if (typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch {
        return data
      }
    }
    if (data && typeof data === 'object' && typeof data.config === 'string') {
      try {
        return JSON.parse(data.config)
      } catch {
        return data
      }
    }
    return data
  }

  /** 写 OneBot 11 配置：body 是 {config:"<JSON 字符串>"}（NapCat 要字符串，不是对象） */
  async setOb11Config(config) {
    let text
    if (typeof config === 'string') text = config
    else if (config && typeof config === 'object') text = JSON.stringify(config)
    else throw new NapCatWebUIError('OneBot 配置必须是对象或 JSON 字符串', { kind: 'config' })
    const data = await this.call('/api/OB11Config/SetConfig', { config: text })
    return { ok: true, data: data === undefined ? null : data }
  }

  /** 检查当前 Credential 是否仍有效（POST /api/auth/check） */
  async authCheck() {
    await this.call('/api/auth/check')
    return true
  }

  /** 注销当前 Credential（能连上才注销；失败不抛） */
  async logout() {
    try {
      await this.call('/api/auth/logout')
    } catch (e) {
      this.log.warn(`WebUI 注销失败（忽略）：${messageOf(e)}`)
    } finally {
      this.credential = ''
      this.credentialCreatedAt = 0
      this.credentialExpiresAt = 0
    }
  }

  /** 释放客户端内存态（不关 NapCat、不发请求）；之后调用会直接抛错 */
  dispose() {
    this.disposed = true
    this.credential = ''
    this.credentialCreatedAt = 0
    this.credentialExpiresAt = 0
    this.token = ''
  }
}

/** 把 GetQuickLoginListNew / GetQuickLoginList 的返回统一成面板友好结构 */
function normalizeQuickList(data) {
  let list = []
  if (Array.isArray(data)) list = data
  else if (data && typeof data === 'object' && Array.isArray(data.list)) list = data.list
  const out = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string' || typeof item === 'number') {
      const uin = String(item).replace(/\D/g, '')
      if (uin) out.push({ uin, nickname: '', avatarUrl: '', isQuickLogin: true, raw: item })
      continue
    }
    if (typeof item !== 'object') continue
    // 字段名以 QQ LoginListItem 为准，同时兼容常见别名（研究文档未给出全部字段，容错优先）
    const uin = String(item.uin ?? item.uid ?? item.user_id ?? item.userId ?? '').replace(/\D/g, '')
    if (!uin) continue
    const nickname = String(item.nickName ?? item.nickname ?? item.nick ?? item.name ?? item.nickNameA ?? '')
    const avatarUrl = String(item.avatarUrl ?? item.avatar ?? item.faceUrl ?? item.face_url ?? '')
    out.push({
      uin,
      nickname,
      avatarUrl,
      isQuickLogin: item.isQuickLogin !== false,
      raw: item,
    })
  }
  return out
}

export default NapCatWebUI
