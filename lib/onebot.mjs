/**
 * lib/onebot.mjs — OneBot 11 客户端（归属：xingzhu）
 * ============================================================================
 * 我们只依赖一个很薄的协议面（QQ 桥 side，推荐 NapCat）：
 *   - 入站：WS 上的 JSON 事件（message / heartbeat / lifecycle）
 *   - 出站：WS 上的 JSON action 请求（send_private_msg / send_group_msg / get_login_info ...）
 * 不自己实现 QQ 协议；桥的实现（NapCat 等）由用户本机安装。
 * 使用 Node 自带全局 WebSocket（Node 22+），失败再退回宿主树里的 ws 包。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { safeFetch } from './netguard.mjs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from './redact.mjs'

const execFileAsync = promisify(execFile)

/**
 * QQ 视频缩略图位置：.../Video/YYYY-MM/Ori/xxx.mp4 → .../Video/YYYY-MM/Thumb/xxx_0.png
 * QQ 会清理原视频，但缩略图通常还在——有封面总比什么都没有强。
 */
function findVideoThumb(filePath) {
  const m = /^(.*?)[\\/]Ori[\\/]([^\\/]+)\.(mp4|mov|m4v|avi|mkv|webm|flv|wmv|ts|mpg|mpeg)$/i.exec(
    String(filePath || ''),
  )
  if (!m) return ''
  const dir = join(m[1], 'Thumb')
  const base = m[2]
  for (const name of [`${base}_0.png`, `${base}.png`, `${base}_0.jpg`, `${base}.jpg`]) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return ''
}

/** 解析 ffmpeg.exe：优先插件状态目录 bin，其次系统 PATH */
function resolveFfmpeg() {
  const roots = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const root of roots) {
    const exe = join(root, 'qq-fish', 'bin', 'ffmpeg.exe')
    if (existsSync(exe)) return exe
  }
  return 'ffmpeg'
}

/** 用 ffmpeg 读取视频时长（秒）；拿不到就返回 0 */
async function probeVideoSeconds(file, ffmpeg) {
  const parse = (text) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
  }
  try {
    const { stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20_000, windowsHide: true })
    return parse(stderr)
  } catch (e) {
    return parse((e && e.stderr) || '')
  }
}

/** 把一组图片字节拼成一张网格图（视频多帧/多图共用） */
async function composeImageSheet(buffers, { cell = 480, cols = 0 } = {}) {
  const mod = await import('sharp')
  const sharp = mod.default || mod
  const tiles = []
  for (const buf of buffers) {
    const png = await sharp(buf)
      .resize({ width: cell, height: cell, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    const m = await sharp(png).metadata()
    tiles.push({ png, width: Number(m.width) || cell, height: Number(m.height) || cell })
  }
  if (!tiles.length) return null
  const columns = cols > 0 ? Math.min(cols, tiles.length) : Math.ceil(Math.sqrt(tiles.length))
  const rows = Math.ceil(tiles.length / columns)
  const cellW = Math.max(...tiles.map((t) => t.width))
  const cellH = Math.max(...tiles.map((t) => t.height))
  const composites = tiles.map((t, i) => ({
    input: t.png,
    left: (i % columns) * cellW + Math.round((cellW - t.width) / 2),
    top: Math.floor(i / columns) * cellH + Math.round((cellH - t.height) / 2),
  }))
  const out = await sharp({
    create: { width: columns * cellW, height: rows * cellH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer()
  return new Uint8Array(out)
}

const log = createLogger('[qq-fish/bridge]')

/** 把 action 请求的 message 段统一成 OneBot 11 段数组 */
export function textSegments(text) {
  const value = String(text || '')
  const segments = []
  // [at:QQ号] → 真正的 OneBot at 段
  const re = /\[at:(\d{5,12}|all)\]/g
  let last = 0, m
  while ((m = re.exec(value))) {
    if (m.index > last) segments.push({ type: 'text', data: { text: value.slice(last, m.index) } })
    segments.push({ type: 'at', data: { qq: m[1] } })
    segments.push({ type: 'text', data: { text: ' ' } })
    last = m.index + m[0].length
  }
  if (last < value.length) segments.push({ type: 'text', data: { text: value.slice(last) } })
  if (!segments.length) segments.push({ type: 'text', data: { text: value } })
  return segments
}

/** CQ 码里的 HTML 实体反转义（OneBot 字符串格式会把 , ] & 等转义） */
export function cqUnescape(text) {
  return String(text || '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

/** 单个 CQ 码转成 OneBot 消息段 */
function cqToSegment(type, paramText) {
  const data = {}
  for (const pair of String(paramText || '').split(',')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1))
  }
  return { type, data }
}

/**
 * 解析字符串格式消息（CQ 码）。有些 NapCat/OneBot 配置用 messagePostFormat=string，
 * event.message 与 raw_message 都是 `[CQ:image,file=...] 文字` 这种串；
 * 直接当文本展示会出现一长串 CQ 码。这里转成标准消息段，再由 segmentsToText 压成可读文本。
 * @param {string} raw
 * @returns {{segments:Array, text:string, quotedId:string}}
 */
export function parseCqMessage(raw) {
  const source = String(raw || '')
  const segments = []
  let quotedId = ''
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g
  let lastIndex = 0
  let match
  while ((match = re.exec(source)) !== null) {
    if (match.index > lastIndex) {
      const plain = cqUnescape(source.slice(lastIndex, match.index))
      if (plain) segments.push({ type: 'text', data: { text: plain } })
    }
    const type = match[1].toLowerCase()
    const segment = cqToSegment(type, match[2].replace(/^,/, ''))
    if (type === 'reply' && segment.data.id) quotedId = String(segment.data.id)
    segments.push(segment)
    lastIndex = re.lastIndex
  }
  if (lastIndex < source.length) {
    const plain = cqUnescape(source.slice(lastIndex))
    if (plain) segments.push({ type: 'text', data: { text: plain } })
  }
  // @ 占位自带一个尾随空格，CQ 原文里 @ 后面也常有空格，合并多余空格
  const text = segmentsToText(segments).replace(/ {2,}/g, ' ').trim()
  return { segments, text, quotedId }
}

/** 从消息段数组里提取纯文本（@ 与表情给个占位） */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return String(segments || '')
  const out = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const data = seg.data || {}
    switch (seg.type) {
      case 'text':
        out.push(String(data.text || ''))
        break
      case 'at':
        if (data.qq && data.qq !== 'all') out.push(`@${data.qq} `)
        else out.push('@全体成员 ')
        break
      case 'face':
      case 'mface':
        out.push('[表情]')
        break
      case 'image':
        out.push('[图片]')
        break
      case 'record':
        out.push('[语音]')
        break
      case 'video':
        out.push('[视频]')
        break
      case 'file':
        out.push('[文件]')
        break
      case 'json':
      case 'xml':
        out.push('[卡片消息]')
        break
      case 'forward':
        out.push('[聊天记录]')
        break
      case 'reply':
        // 引用留给 quoted 字段，不重复进正文
        break
      default:
        if (typeof data.text === 'string') out.push(data.text)
    }
  }
  return out.join('').trim()
}

/** 判断消息是否 @ 了机器人自己（group 场景） */
export function mentionsSelf(segments, selfId) {
  if (!Array.isArray(segments) || !selfId) return false
  return segments.some((seg) => {
    if (!seg || seg.type !== 'at' || !seg.data) return false
    return String(seg.data.qq) === String(selfId)
  })
}

export class OneBotClient {
  /**
   * @param {object} options { url, token, onEvent, onState, WebSocketImpl }
   */
  constructor(options) {
    this.url = String(options.url || '')
    this.token = String(options.token || '')
    this.onEvent = options.onEvent || (() => {})
    this.onState = options.onState || (() => {})
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket
    this.ws = null
    this.state = 'idle'
    this.selfId = ''
    this.nickname = ''
    this.pending = new Map()
    this.echoSeq = 0
    this.closedByUser = false
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.lastHeartbeatAt = 0
  }

  /** 建立连接（带重连）；返回一个 dispose 函数 */
  connect() {
    this.closedByUser = false
    this.open()
    return () => this.close()
  }

  open() {
    if (!this.WebSocketImpl) {
      this.setState('error', '当前 Node 没有内置 WebSocket，无法连接 QQ 桥')
      return
    }
    if (!this.url) {
      this.setState('idle', '还没填 QQ 桥地址')
      return
    }
    const target = this.buildUrl()
    this.setState('connecting', '正在连接 QQ 桥…')
    let socket
    try {
      socket = new this.WebSocketImpl(target)
    } catch (e) {
      this.setState('error', `连接失败：${String((e && e.message) || e).slice(0, 200)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0
      this.setState('online', 'QQ 桥已连接')
      this.lastHeartbeatAt = Date.now()
      this.startHeartbeatWatch()
      this.call('get_login_info', {}, 8000)
        .then((data) => {
          if (data && data.user_id) {
            this.selfId = String(data.user_id)
            this.nickname = String(data.nickname || '')
            this.onState({ selfId: this.selfId, nickname: this.nickname })
          }
        })
        .catch(() => {})
    })

    socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      this.handlePayload(payload)
    })

    socket.addEventListener('close', () => {
      this.ws = null
      this.stopHeartbeatWatch()
      this.rejectAll('连接已断开')
      if (this.closedByUser) {
        this.setState('idle', '已断开 QQ 桥')
        return
      }
      this.setState('reconnecting', 'QQ 桥断开，正在重连…')
      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      // 具体原因通常由 close 事件带回；这里只标记
      if (this.state !== 'online') this.setState('error', '连接 QQ 桥出错（地址/端口/token 可能不对）')
    })
  }

  buildUrl() {
    const url = this.url
    if (!this.token) return url
    try {
      const parsed = new URL(url)
      if (!parsed.searchParams.get('access_token')) parsed.searchParams.set('access_token', this.token)
      return parsed.toString()
    } catch {
      return url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.token)
    }
  }

  handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return
    // action 响应
    if (payload.echo !== undefined && payload.echo !== null) {
      const id = String(payload.echo)
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (payload.status === 'ok' || payload.retcode === 0) {
        pending.resolve(payload.data)
      } else {
        const message =
          (payload.wording && String(payload.wording)) ||
          (payload.message && String(payload.message)) ||
          `retcode=${payload.retcode}`
        pending.reject(new Error(message))
      }
      return
    }
    // 事件
    if (payload.post_type) {
      if (payload.post_type === 'meta_event') {
        if (payload.meta_event_type === 'heartbeat') this.lastHeartbeatAt = Date.now()
        if (payload.meta_event_type === 'lifecycle') {
          log.info(`lifecycle: ${payload.sub_type || ''}`)
        }
        return
      }
      if (payload.post_type === 'message') this.lastHeartbeatAt = Date.now()
      try {
        this.onEvent(payload)
      } catch (e) {
        log.error('事件处理出错：' + String((e && e.message) || e))
      }
    }
  }

  startHeartbeatWatch() {
    this.stopHeartbeatWatch()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.state !== 'online') return
      if (Date.now() - this.lastHeartbeatAt > 120_000) {
        // 2 分钟没任何事件/心跳：多半是桥挂了，主动重连一次
        log.warn('120 秒没有心跳，主动重连 QQ 桥')
        try {
          this.ws.close()
        } catch {}
      }
    }, 30_000)
  }

  stopHeartbeatWatch() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return
    this.reconnectAttempts += 1
    const delay = Math.min(30_000, 1000 * Math.pow(1.6, Math.min(8, this.reconnectAttempts)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) this.open()
    }, delay)
  }

  setState(state, detail) {
    this.state = state
    try {
      this.onState({ state, detail })
    } catch {}
  }

  /** 发起一个 OneBot action，返回 data */
  call(action, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('QQ 桥未连接'))
    }
    const echo = `qqfish-${Date.now()}-${++this.echoSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot action ${action} 超时`))
      }, Math.max(1000, Number(timeoutMs) || 15_000))
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(new Error(String((e && e.message) || e)))
      }
    })
  }

  rejectAll(message) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  /** 发一条私聊文本 */
  async sendPrivate(userId, text) {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: textSegments(text),
      auto_escape: false,
    })
  }

  /** 发一条群聊文本 */
  async sendGroup(groupId, text) {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message: textSegments(text),
      auto_escape: false,
    })
  }

  /** 统一发送入口：target = { kind:'private', userId } | { kind:'group', groupId } */
  async send(target, text) {
    if (!target) throw new Error('没有发送目标')
    if (target.kind === 'group' || target.groupId) {
      return this.sendGroup(target.groupId, text)
    }
    return this.sendPrivate(target.userId, text)
  }

  /**
   * 发一张图片（公网 http(s) 直链，交给 NapCat 下载）。
   * caption 可选：图片和文字在同一个气泡里（OneBot 里是同一 message 的两个段）。
   */
  async sendImage(target, url, caption) {
    if (!target) throw new Error('没有发送目标')
    const file = String(url || '').trim()
    if (!/^https?:\/\//i.test(file) && !file.startsWith('base64://')) throw new Error('图片必须是 http(s) 直链或 base64://')
    const segments = []
    const text = String(caption || '').trim()
    if (text) segments.push(...textSegments(text))
    segments.push({ type: 'image', data: { file } })
    if (target.kind === 'group' || target.groupId) {
      return this.call('send_group_msg', {
        group_id: Number(target.groupId),
        message: segments,
        auto_escape: false,
      })
    }
    return this.call('send_private_msg', {
      user_id: Number(target.userId),
      message: segments,
      auto_escape: false,
    })
  }

  /** 取线上图片字节（识图用）：只允许 http(s)，限制大小与超时，返回 { data: Uint8Array, mediaType } */
  async fetchImage(url, { maxBytes = 6 * 1024 * 1024, timeoutMs = 20_000, gifFrames = 4 } = {}) {
    const target = String(url || '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('图片必须是 http(s) 直链')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 20_000))
    try {
      const res = await safeFetch(target, {
        signal: controller.signal,
        headers: {
          accept: 'image/*,*/*;q=0.8',
          referer: 'https://q.qq.com/',
          'user-agent': 'Mozilla/5.0 (Linux; Android 13; PHJ110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        },
      })
      if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) throw new Error(`图片太大（${Math.round(declared / 1048576)}MB）`)
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) throw new Error(`图片太大（${Math.round(buf.byteLength / 1048576)}MB）`)
      if (!buf.byteLength) throw new Error('图片是空的')
      const magic = (b) => {
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
        if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp'
        return null
      }
      const mediaType = magic(buf) || String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      // DSH 附件支持 png/jpeg/webp/gif 四种，都放行
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(mediaType)) {
        throw new Error(`不是受支持的图片类型（${mediaType || '未知'}）`)
      }
      // 动图：抽关键帧拼成一张静态图，模型才看得懂 GIF 在演什么
      if (mediaType === 'image/gif') {
        const sheet = await this.composeGifSheet(buf, gifFrames)
        if (sheet) return { data: sheet, mediaType: 'image/png', animated: true }
      }
      return { data: buf, mediaType }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * GIF 抽帧拼图：均匀取 N 帧，拼成网格图（默认 2x2），返回 PNG 字节。
   * 拿不到 sharp / 解析失败就返回 null，调用方回退到原图（至少首帧可看）。
   */
  async composeGifSheet(buffer, frameCount = 4) {
    try {
      const mod = await import('sharp')
      const sharp = mod.default || mod
      const meta = await sharp(buffer, { animated: true }).metadata()
      const pages = Number(meta.pages || meta.nPages || 1)
      if (!pages || pages <= 1) return null
      const want = Math.max(2, Math.min(9, Math.trunc(Number(frameCount) || 4)))
      const count = Math.min(want, pages)
      const indices = []
      for (let i = 0; i < count; i++) {
        indices.push(count === 1 ? 0 : Math.round(((pages - 1) * i) / (count - 1)))
      }
      const cell = 480
      const tiles = []
      for (const page of indices) {
        const png = await sharp(buffer, { animated: true, page, pages: 1 })
          .resize({ width: cell, height: cell, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer()
        const m = await sharp(png).metadata()
        tiles.push({ png, width: Number(m.width) || cell, height: Number(m.height) || cell })
      }
      if (!tiles.length) return null
      const cols = Math.ceil(Math.sqrt(tiles.length))
      const rows = Math.ceil(tiles.length / cols)
      const cellW = Math.max(...tiles.map((t) => t.width))
      const cellH = Math.max(...tiles.map((t) => t.height))
      const composites = tiles.map((t, i) => ({
        input: t.png,
        left: (i % cols) * cellW + Math.round((cellW - t.width) / 2),
        top: Math.floor(i / cols) * cellH + Math.round((cellH - t.height) / 2),
      }))
      const out = await sharp({
        create: {
          width: cols * cellW,
          height: rows * cellH,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite(composites)
        .png()
        .toBuffer()
      return new Uint8Array(out)
    } catch {
      return null
    }
  }

  /**
   * 看懂视频：取视频（http 直链 或 本机路径）→ ffmpeg 均匀抽帧 → 拼成一张网格图（PNG）。
   * NapCat 常把视频给成本机路径（nt_data/Video），所以两种来源都要支持。
   * 返回 { data, mediaType:'image/png', meta:{seconds,frames,bytes,source} }；失败抛错。
   */
  async fetchVideoSheet(source, { maxMb = 30, frames = 6, maxSeconds = 120, timeoutMs = 90_000 } = {}) {
    const target = String(source || '').trim()
    const isHttp = /^https?:\/\//i.test(target)
    const isLocal = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('file://')
    if (!isHttp && !isLocal) throw new Error('视频必须是 http(s) 直链或本机文件路径')
    const maxBytes = Math.max(1, Number(maxMb) || 30) * 1024 * 1024
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 90_000))
    let dir = ''
    try {
      let buf
      if (isHttp) {
        const res = await safeFetch(target, {
          signal: controller.signal,
          headers: { accept: 'video/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; qq-fish/0.1)' },
        })
        if (!res.ok) throw new Error(`下载视频失败：HTTP ${res.status}`)
        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > maxBytes) {
          throw new Error(`视频太大（${Math.round(declared / 1048576)}MB > ${Math.round(maxBytes / 1048576)}MB 上限）`)
        }
        buf = new Uint8Array(await res.arrayBuffer())
      } else {
        // 本机文件：只允许常见视频扩展名，避免被诱导读任意文件
        const filePath = target.startsWith('file://') ? decodeURIComponent(target.replace(/^file:\/\//i, '')) : target
        if (!/\.(mp4|mov|m4v|avi|mkv|webm|flv|wmv|ts|mpg|mpeg)$/i.test(filePath)) {
          throw new Error('本地路径不是受支持的视频文件')
        }
        if (!existsSync(filePath)) {
          // 原视频被 QQ 清理了：退回同目录 Thumb 下的封面图，至少能看个大概
          const thumb = findVideoThumb(filePath)
          if (thumb) {
            const tbuf = readFileSync(thumb)
            // QQ 缩略图的扩展名常和真实字节不符（.png 里其实是 jpg/webp），
            // 直接按扩展名声明的 MIME 会被 DSH 附件校验拒掉，所以统一用 sharp 转成真 PNG。
            let outBuf = tbuf
            let mime = 'image/png'
            try {
              const mod = await import('sharp')
              const sharp = mod.default || mod
              outBuf = await sharp(tbuf).png().toBuffer()
              mime = 'image/png'
            } catch {
              // sharp 也转不了：按 magic bytes 猜，猜不出就报错
              const b = tbuf
              if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) mime = 'image/png'
              else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mime = 'image/jpeg'
              else if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) mime = 'image/gif'
              else if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) mime = 'image/webp'
              else throw new Error('缩略图不是可识别的图片格式')
            }
            return {
              data: new Uint8Array(outBuf),
              mediaType: mime,
              meta: { seconds: 0, frames: 1, bytes: outBuf.length, source: 'local-thumb', note: '原视频已被 QQ 清理，只能看到封面' },
            }
          }
          throw new Error('本地视频文件不存在（QQ 已清理，且没有封面缓存）')
        }
        const st = statSync(filePath)
        if (!st.isFile()) throw new Error('本地路径不是文件')
        if (st.size > maxBytes) {
          throw new Error(`视频太大（${Math.round(st.size / 1048576)}MB > ${Math.round(maxBytes / 1048576)}MB 上限）`)
        }
        buf = new Uint8Array(readFileSync(filePath))
      }
      if (buf.byteLength > maxBytes) throw new Error(`视频太大（${Math.round(buf.byteLength / 1048576)}MB）`)
      if (buf.byteLength < 1024) throw new Error('视频文件是空的')
      dir = mkdtempSync(join(tmpdir(), 'qqfish-vid-'))
      const src = join(dir, 'src')
      writeFileSync(src, buf)
      const ffmpeg = resolveFfmpeg()
      const seconds = await probeVideoSeconds(src, ffmpeg)
      const span = maxSeconds > 0 ? Math.min(seconds || maxSeconds, maxSeconds) : seconds || 30
      const count = Math.max(2, Math.min(9, Math.trunc(Number(frames) || 6)))
      const fps = count / Math.max(1, span)
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          src,
          '-t',
          String(span),
          '-vf',
          `fps=${fps.toFixed(4)},scale=480:-1`,
          '-frames:v',
          String(count),
          join(dir, 'f_%02d.png'),
        ],
        { timeout: 60_000, windowsHide: true },
      )
      const files = readdirSync(dir)
        .filter((f) => /^f_\d+\.png$/.test(f))
        .sort()
      if (!files.length) throw new Error('抽帧失败（视频编码可能不受支持）')
      const buffers = files.map((f) => readFileSync(join(dir, f)))
      const sheet = await composeImageSheet(buffers, { cell: 480 })
      if (!sheet) throw new Error('拼图失败')
      return {
        data: sheet,
        mediaType: 'image/png',
        meta: { seconds: Math.round(seconds), frames: files.length, bytes: buf.byteLength, source: isHttp ? 'http' : 'local' },
      }
    } finally {
      clearTimeout(timer)
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {}
      }
    }
  }

  async getLoginInfo() {
    return this.call('get_login_info', {}, 8000)
  }

  /** 查一条历史消息的完整内容（用于「引用回复」时还原被引用的那条） */
  async getMsg(messageId, timeoutMs = 8000) {
    const raw = String(messageId ?? '').trim()
    if (!raw) throw new Error('缺少 message_id')
    const id = /^-?\d+$/.test(raw) ? Number(raw) : raw
    return this.call('get_msg', { message_id: id }, timeoutMs)
  }

  async getFriendList() {
    return this.call('get_friend_list', {}, 15_000)
  }

  async getGroupList() {
    return this.call('get_group_list', {}, 15_000)
  }

  close() {
    this.closedByUser = true
    this.stopHeartbeatWatch()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAll('主动断开')
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    this.setState('idle', '已断开 QQ 桥')
  }
}
