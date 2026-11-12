/**
 * lib/bridge.mjs — 大肥鱼插件 的总调度（归属：xingzhu）
 * ============================================================================
 * 把六块拼起来：
 *   1. provisioner（lib/napcat.mjs，可选加载）：探测/安装/启动/停止 NapCat；
 *   2. WebUI 客户端（lib/webui.mjs，可选加载）：换 Credential + 二维码/登录态；
 *   3. OneBotClient（lib/onebot.mjs）：和 QQ 桥收发消息；
 *   4. ChatEngine（lib/engine.mjs）：收到消息 → 人设 → 回复；
 *   5. ProactiveScheduler（lib/push.mjs）：主动推送 + 碎碎念；
 *   6. 本地状态（lib/store.mjs / lib/usage.mjs）：配置、聊天记录、token 用量、安全确认。
 *
 * 设计原则：
 *   - 任何一个可选模块没加载成功都不能让插件整条不激活，只在面板里显示降级原因；
 *   - 所有对 QQ 的写操作（发消息、主动推送）都必须桥在线；所有对 NapCat 的写操作必须用户点按钮；
 *   - token/凭据只在内存与本地文件，绝不进快照、日志；
 *   - 首次使用必须先完成风险确认（safetyAck），否则安装/登录/发消息一律拒绝并返回人话。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { ChatEngine } from './engine.mjs'
import { OneBotClient, segmentsToText } from './onebot.mjs'
import { ProactiveScheduler } from './push.mjs'
import { createLogger, maskUin, maskSensitiveText } from './redact.mjs'
import {
  appendMessage,
  bumpStats,
  loadConfig,
  loadContacts,
  loadSafety,
  loadStats,
  pathOf,
  readJson,
  recentMessages,
  repairMessageLog,
  runtime,
  saveConfig,
  saveContacts,
  saveSafety,
  stateHome,
  trimMessages,
  writeJsonAtomic,
} from './store.mjs'
import { usageSummary } from './usage.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LOGIN_ACTIVE_PHASES = new Set([
  'waiting_qrcode',
  'generating_qrcode',
  'qrcode_scanned',
  'initializing',
  'offline',
  'reconnecting',
])

/** 错误对象：带 code 让 HTTP 层能给出可操作提示 */
class BridgeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BridgeError'
    this.code = code || 'bridge-error'
  }
}

function requireSafety() {
  const safety = loadSafety()
  if (!safety.acknowledged) {
    throw new BridgeError('请先在「推送与安全」里勾选「我用的是小号，已知账号可能被风控/封禁」再继续', 'safety-required')
  }
}

function isPng(buffer) {
  return (
    buffer &&
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
}

export class QqFishBridge {
  constructor(options = {}) {
    this.ctx = options.ctx
    this.version = options.version || '0.0.0'
    this.log = options.log || createLogger('[qq-fish]')

    this.provisioner = null
    this.installAbort = null
    this.provisionModuleError = ''
    this.webui = null
    this.webuiModuleError = ''
    this.client = null

    this.provision = {
      mode: 'none',
      qq: { installed: false, path: '', running: null },
      napcat: {
        installed: false,
        running: false,
        version: '',
        dir: '',
        webuiPort: 0,
        onebotPort: 0,
        managed: true,
        lastError: '',
        lastErrorCode: '',
      },
      installJob: { state: 'idle', stage: '', percent: 0, log: '' },
      error: '',
    }
    this.provisionTokens = { webuiPort: 0, webuiToken: '', onebotPort: 0, onebotToken: '' }

    this.login = {
      phase: 'idle',
      isLogin: false,
      isOffline: false,
      qrDataUrl: '',
      qrText: '',
      error: '',
      account: null,
      lastPollAt: 0,
    }

    this.timers = []
    this.disposed = false
    this.initialized = false
    this.loginTicking = false
    this.autoStartFailures = 0
    this.autoStartAttemptAt = 0

    this.engine = new ChatEngine({
      ctx: this.ctx,
      getBridge: () => this.engineClient(),
      getConfig: () => loadConfig(),
      log: this.log,
    })
    this.scheduler = new ProactiveScheduler({
      ctx: this.ctx,
      getBridge: () => this.engineClient(),
      getConfig: () => loadConfig(),
      log: this.log,
    })
  }

  /**
   * 给 engine / scheduler 用的 client 包装。
   * 以前直接返回 this.client，但 _dryRun / _lastSent 挂在 Bridge 上、client 是个独立对象，
   * 结果面板 /say 的"只生成不发送"完全失效：测试消息真发到 QQ，返回还是空的。
   * 这里把两件事绑上去：_dryRun 用 getter 透传，send 在 dryRun 时只记不发。
   */
  engineClient() {
    const c = this.client
    if (!c) return c
    if (c.__dryRunBound) return c
    try {
      Object.defineProperty(c, '_dryRun', {
        configurable: true,
        get: () => !!this._dryRun,
      })
      const origSend = typeof c.send === 'function' ? c.send.bind(c) : null
      if (origSend) {
        c.send = async (target, text) => {
          if (this._dryRun) {
            this._lastSent = String(text || '')
            return { ok: true, dryRun: true }
          }
          return origSend(target, text)
        }
      }
      // 图片、语音这些走 client.call('send_*_msg')，之前没拦，dryRun 预览会真发出去
      const origCall = typeof c.call === 'function' ? c.call.bind(c) : null
      if (origCall) {
        c.call = async (action, params) => {
          if (this._dryRun && /^send_/.test(String(action || ''))) {
            const seg = params && Array.isArray(params.message) ? params.message : []
            const txt = seg.map((x) => (x && x.type === 'text' ? String((x.data && x.data.text) || '') : '')).join('').trim()
            if (txt) this._lastSent = txt
            return { ok: true, dryRun: true, message_id: 0 }
          }
          return origCall(action, params)
        }
      }
      c.__dryRunBound = true
    } catch {}
    return c
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  async init() {
    if (this.initialized || this.disposed) return
    this.initialized = true
    try {
      trimMessages(loadConfig().maxHistory)
      // 修复旧版本留下的问题：同会话时间戳乱序（回复排到消息前）、CQ 码原文进正文
      const repair = await repairMessageLog()
      if (repair.changed) {
        this.log.info(
          `已修复历史聊天记录：时间戳 ${repair.fixedTimestamps} 条、CQ 码文本 ${repair.fixedCq} 条（备份 ${repair.backup}）`,
        )
      }
    } catch (e) {
      this.log.warn('聊天记录修复/瘦身失败：' + String((e && e.message) || e))
    }
    await this.detectProvision()
    this.restoreAccount()
    await this.loadOptionalModules()

    this.timers.push(
      setInterval(() => {
        this.tick().catch((e) => this.log.error('tick 出错：' + String((e && e.message) || e)))
      }, 5000),
    )

    // 启动 4 秒后再做自动恢复（宿主服务/桥可能刚起）
    this.timers.push(
      setTimeout(() => {
        this.autoRecover().catch((e) => this.log.warn('自动恢复失败：' + String((e && e.message) || e)))
      }, 4000),
    )
    this.log.info(`桥接已初始化（模式=${this.provision.mode}，账号=${this.login.account ? maskUin(this.login.account.uin) : '未登录'}）`)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) {
      try {
        clearInterval(timer)
        clearTimeout(timer)
      } catch {}
    }
    this.timers = []
    try {
      this.scheduler.stop()
    } catch {}
    try {
      if (this.client) {
        this.client.close()
        this.client = null
      }
    } catch {}
    this.log.info('桥接已卸载')
  }

  async loadOptionalModules() {
    if (this.modulesLoaded) return
    this.modulesLoaded = true
    // 托管模块（队友并行开发；文件缺失时降级为"进阶路径"）
    try {
      const mod = await import('./napcat.mjs')
      if (mod && typeof mod.NapCatProvisioner === 'function') {
        this.provisioner = new mod.NapCatProvisioner({ log: this.log, stateHome: stateHome() })
      } else {
        this.provisionModuleError = 'lib/napcat.mjs 没有导出 NapCatProvisioner'
      }
    } catch (e) {
      this.provisionModuleError = '托管模块未就绪：' + String((e && e.message) || e)
      this.log.warn(this.provisionModuleError)
    }
    try {
      const mod = await import('./webui.mjs')
      if (!mod || typeof mod.NapCatWebUI !== 'function') {
        this.webuiModuleError = 'lib/webui.mjs 没有导出 NapCatWebUI'
      }
    } catch (e) {
      this.webuiModuleError = 'WebUI 模块未就绪：' + String((e && e.message) || e)
      this.log.warn(this.webuiModuleError)
    }
  }

  restoreAccount() {
    const config = loadConfig()
    if (config.account && typeof config.account === 'object' && config.account.uin) {
      this.login.account = {
        uin: String(config.account.uin),
        nickname: String(config.account.nickname || '小肥鱼'),
        avatarUrl: '',
      }
    }
  }

  async tick() {
    if (this.disposed) return
    const config = loadConfig()

    // 1) 登录流程还在进行 → 自动轮询登录态
    if (LOGIN_ACTIVE_PHASES.has(this.login.phase) && !this.client) {
      const now = Date.now()
      if (now - this.login.lastPollAt > 3500 && !this.loginTicking) {
        this.loginTicking = true
        try {
          await this.loginPoll()
        } catch (e) {
          this.log.warn('登录态轮询失败：' + String((e && e.message) || e))
        } finally {
          this.loginTicking = false
        }
      }
    }

    // 2) 托管 NapCat 掉线后自动拉起（只在用户已经完成过首次登录时；带退避）
    if (
      config.autoStart &&
      this.provision.mode === 'managed' &&
      this.provision.napcat.installed &&
      !this.provision.napcat.running &&
      this.login.account &&
      !this.client &&
      Date.now() - this.autoStartAttemptAt > 90_000 &&
      this.autoStartFailures < 3 &&
      loadSafety().acknowledged
    ) {
      this.autoStartAttemptAt = Date.now()
      this.startNapcat()
        .then(() => this.pollLoginOnce())
        .catch((e) => {
          this.autoStartFailures += 1
          this.provision.napcat.lastError = String((e && e.message) || e)
          this.log.warn('自动拉起 NapCat 失败：' + this.provision.napcat.lastError)
        })
    }

    // 3) NapCat 已在跑、也已登录，但 WS 没连上 → 尝试重连
    if (!this.client && this.login.isLogin && this.provision.mode === 'managed') {
      const now = Date.now()
      if (now - (this.lastConnectAttempt || 0) > 30_000) {
        this.lastConnectAttempt = now
        this.connectBridge().catch((e) => this.log.warn('自动连接 QQ 桥失败：' + String((e && e.message) || e)))
      }
    }
  }

  async autoRecover() {
    const config = loadConfig()
    if (config.onebotMode === 'external') {
      if (!loadSafety().acknowledged) return
      if (config.wsUrl) {
        this.provision.mode = 'external'
        await this.connectBridge().catch((e) => this.log.warn('外部桥连接失败：' + String((e && e.message) || e)))
      }
      return
    }
    if (!loadSafety().acknowledged) return
    if (!config.autoStart) return
    if (!this.provision.napcat.installed || !this.login.account || this.provision.napcat.running) return
    await this.startNapcat()
    await this.pollLoginOnce()
  }

  // ───────────────────────────── 探测 / 配置 ─────────────────────────────

  async getProvisioner() {
    if (this.provisioner) return this.provisioner
    this.modulesLoaded = false
    await this.loadOptionalModules()
    return this.provisioner
  }

  async detectProvision() {
    const config = loadConfig()
    if (config.onebotMode === 'external') {
      this.provision.mode = 'external'
      this.provision.error = ''
      this.provision.napcat = {
        ...this.provision.napcat,
        installed: !!config.wsUrl,
        running: !!(this.client && this.client.state === 'online'),
        dir: '',
        managed: false,
      }
      return this.provision
    }
    const provisioner = await this.getProvisioner()
    if (!provisioner) {
      this.provision.mode = 'none'
      this.provision.error = this.provisionModuleError || '托管模块不可用（可用进阶路径填 NapCat 地址）'
      return this.provision
    }
    try {
      const raw = await provisioner.detect()
      this.applyProvision(raw)
      this.readProvisionTokensFromDisk()
      this.provision.error = ''
    } catch (e) {
      this.provision.error = '探测 NapCat 失败：' + String((e && e.message) || e)
      this.log.warn(this.provision.error)
    }
    return this.provision
  }

  applyProvision(raw) {
    const nap = (raw && raw.napcat) || raw || {}
    const qq = (raw && raw.qq) || this.provision.qq || {}
    this.provision = {
      mode: (raw && raw.mode) || (nap.installed ? 'managed' : 'none'),
      qq: {
        installed: !!qq.installed,
        path: String(qq.path || ''),
        running: qq.running === undefined ? null : qq.running,
      },
      napcat: {
        installed: !!nap.installed,
        running: !!nap.running,
        version: String(nap.version || ''),
        dir: String(nap.dir || ''),
        webuiPort: Number(nap.webuiPort || nap.port || 0),
        onebotPort: Number(nap.onebotPort || 0),
        managed: nap.managed !== false,
        lastError: String(nap.lastError || this.provision.napcat.lastError || ''),
        lastErrorCode: String(nap.lastErrorCode || this.provision.napcat.lastErrorCode || ''),
      },
      installJob: this.provision.installJob,
      error: this.provision.error,
    }
    this.provisionTokens = {
      webuiPort: this.provision.napcat.webuiPort,
      webuiToken: String(nap.webuiToken || ''),
      onebotPort: this.provision.napcat.onebotPort,
      onebotToken: String(nap.onebotToken || ''),
    }
  }

  /** 从托管目录的 config 文件里补读端口/token（provisioner 没给时兜底） */
  readProvisionTokensFromDisk() {
    const dir = this.provision.napcat.dir
    if (!dir) return
    try {
      const webuiFile = join(dir, 'config', 'webui.json')
      if (existsSync(webuiFile)) {
        const webui = JSON.parse(readFileSync(webuiFile, 'utf8'))
        if (!this.provisionTokens.webuiPort) this.provisionTokens.webuiPort = Number(webui.port) || 0
        if (!this.provisionTokens.webuiToken) this.provisionTokens.webuiToken = String(webui.token || '')
      }
    } catch {}
    try {
      const saved = readJson(pathOf('napcat.json'), null)
      if (saved && typeof saved === 'object') {
        this.provisionTokens.webuiPort = this.provisionTokens.webuiPort || Number(saved.webuiPort || 0)
        this.provisionTokens.webuiToken = this.provisionTokens.webuiToken || String(saved.webuiToken || '')
        this.provisionTokens.onebotPort = this.provisionTokens.onebotPort || Number(saved.onebotPort || 0)
        this.provisionTokens.onebotToken = this.provisionTokens.onebotToken || String(saved.onebotToken || '')
        if (!this.provision.napcat.dir && saved.dir) this.provision.napcat.dir = String(saved.dir)
      }
    } catch {}
    if (!this.provisionTokens.onebotPort || !this.provisionTokens.onebotToken) {
      try {
        const configDir = join(dir, 'config')
        const file = readdirSync(configDir).find((name) => /^onebot11.*\.json$/.test(name))
        if (file) {
          const onebot = JSON.parse(readFileSync(join(configDir, file), 'utf8'))
          const servers = (onebot.network && onebot.network.websocketServers) || []
          const server = servers.find((item) => item && item.enable) || servers[0]
          if (server) {
            this.provisionTokens.onebotPort = this.provisionTokens.onebotPort || Number(server.port) || 0
            this.provisionTokens.onebotToken = this.provisionTokens.onebotToken || String(server.token || '')
          }
        }
      } catch {}
    }
  }

  /**
   * 【她的账号号】之前 bridge 上根本没有这个属性：
   * 消息事件里自带 self_id 所以没暴露问题，但戳一戳/系统事件没有，
   * 引擎判断「被戳的是不是她」就会失败。这里统一兜底取一次。
   */
  get selfId() {
    try {
      if (this.client && this.client.selfId) return String(this.client.selfId)
    } catch {}
    const acc = this.login && this.login.account
    const uin = String((acc && acc.uin) || '')
    // account.uin 在有些路径上会被脱敏成 24******36，脱敏值不能用
    return /^\d{5,12}$/.test(uin) ? uin : ''
  }

  publicConfig() {
    const config = loadConfig()
    const out = { ...config }
    out.hasToken = !!config.wsToken
    out.hasWebuiToken = !!config.webuiToken
    delete out.wsToken
    delete out.webuiToken
    out.hasAsrKey = Boolean(config.asrApiKey)
    delete out.asrApiKey
    if (config.account && typeof config.account === 'object') {
      out.account = {
        uin: maskUin(config.account.uin),
        nickname: String(config.account.nickname || ''),
      }
    }
    return out
  }

  updateConfig(patch) {
    const before = loadConfig()
    const config = saveConfig(patch)
    // 连桥参数变了：已连的话断开旧连接，下一次 tick / 面板刷新会重连
    const connectionChanged =
      before.wsUrl !== config.wsUrl ||
      before.onebotMode !== config.onebotMode ||
      before.webuiUrl !== config.webuiUrl
    if (connectionChanged && this.client) {
      this.disconnectBridge()
    }
    return { ok: true, config: this.publicConfig() }
  }

  // ───────────────────────────── 托管 / 安装 / 启停 ─────────────────────────────

  provisionSnapshot() {
    return {
      mode: this.provision.mode,
      qq: this.provision.qq,
      napcat: {
        installed: this.provision.napcat.installed,
        running: this.provision.napcat.running,
        version: this.provision.napcat.version,
        dir: this.provision.napcat.dir,
        webuiPort: this.provision.napcat.webuiPort,
        onebotPort: this.provision.napcat.onebotPort,
        managed: this.provision.napcat.managed,
        lastError: this.provision.napcat.lastError,
        lastErrorCode: this.provision.napcat.lastErrorCode || '',
      },
      installJob: this.provision.installJob,
      error: this.provision.error,
      modules: {
        provisioning: !!this.provisioner,
        provisioningError: this.provisionModuleError,
        webui: !this.webuiModuleError,
        webuiError: this.webuiModuleError,
      },
    }
  }

  async installNapcat(options = {}) {
    requireSafety()
    if (this.provision.installJob.state === 'running') {
      return { ok: true, jobId: this.provision.installJob.jobId, running: true }
    }
    const provisioner = await this.getProvisioner()
    if (!provisioner) {
      throw new BridgeError(this.provisionModuleError || '托管模块不可用：请使用「我已有 NapCat」进阶路径', 'provision-unavailable')
    }
    if (process.platform !== 'win32') {
      throw new BridgeError('一键安装只支持 Windows；当前系统请使用「我已有 NapCat」进阶路径', 'unsupported-platform')
    }
    // 可选：指定安装包（默认 NapCat.Shell.zip；NapCat.Shell.Windows.Node.zip 自带 QQ，适合没装 QQ/想隔离的场景）
    const requestedAsset = String((options && options.asset) || '').trim()
    const jobId = `install-${Date.now()}`
    const controller = new AbortController()
    this.installAbort = controller
    this.provision.installJob = { state: 'running', stage: '准备下载', percent: 0, log: '', jobId }
    const config = loadConfig()
    if (config.onebotMode === 'external') {
      // 外部模式填了地址：一键安装不该覆盖用户的 NapCat；空地址是用户误点/旧状态，自动修复回托管。
      if (config.wsUrl) {
        this.provision.installJob = { state: 'idle', stage: '', percent: 0, log: '', jobId: '' }
        this.installAbort = null
        throw new BridgeError('当前使用外部 NapCat，不需要一键安装；想切回插件托管请到「高级：我自己有 NapCat」点「切回插件托管」', 'external-mode')
      }
      saveConfig({ onebotMode: 'managed' })
      config.onebotMode = 'managed'
      this.provision.mode = 'managed'
      this.provision.napcat.managed = true
      this.appendJobLog('检测到外部模式但没有填地址，已自动切回插件托管')
    }
    // 中国大陆直连 GitHub Releases 经常很慢/中断：先走公共加速代理，最后才回退直连。
    // 注意：DSH「添加插件」里的「中国大陆镜像源」只影响 npm 包下载，管不到 NapCat 的 GitHub 下载。
    const attempts = []
    if (config.napcatMirror) attempts.push(config.napcatMirror)
    attempts.push('https://gh-proxy.com/', 'https://ghproxy.net/', 'https://ghfast.top/', '')
    ;(async () => {
      let lastError = null
      let installed = false
      let cancelled = false
      let attemptIndex = 0
      for (const mirror of attempts) {
        if (controller.signal.aborted) {
          cancelled = true
          break
        }
        const isFirst = attemptIndex === 0
        attemptIndex += 1
        const label = mirror ? mirror.replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'GitHub 直连'
        this.appendJobLog(`${isFirst ? '使用下载源' : '改用下载源'}：${label}`)
        try {
          await provisioner.install({
            // 已装过（含上次下载完但没启动）就直接复用，不重复下载
            mirrorBase: mirror || undefined,
            asset: requestedAsset || undefined,
            signal: controller.signal,
            onProgress: (progress) => {
              if (controller.signal.aborted) return
              const next = progress || {}
              this.provision.installJob = {
                state: 'running',
                stage: String(next.stage || '进行中'),
                percent: Number(next.percent || 0),
                log: String(next.message ? this.appendJobLog(next.message) : this.provision.installJob.log),
                jobId,
              }
            },
          })
          if (controller.signal.aborted) {
            cancelled = true
            break
          }
          installed = true
          break
        } catch (e) {
          lastError = e
          if (controller.signal.aborted) {
            cancelled = true
            break
          }
          const message = String((e && e.message) || e)
          // 已经装好（只是启动/检查出错）时不再换源重下
          if (/已安装|already|up to date/i.test(message)) {
            installed = true
            break
          }
          this.appendJobLog(`${label} 失败：${message.slice(0, 160)}`)
        }
      }
      if (cancelled) {
        if (this.provision.installJob.state !== 'cancelled') {
          this.provision.installJob = {
            state: 'cancelled',
            stage: '已取消',
            percent: this.provision.installJob.percent || 0,
            log: this.appendJobLog('用户取消了安装'),
            jobId,
          }
        }
        return
      }
      if (!installed) {
        throw lastError || new Error('下载 NapCat 失败')
      }
      try {
        await this.detectProvision()
        this.provision.installJob = {
          state: 'done',
          stage: '安装完成',
          percent: 100,
          log: this.appendJobLog('安装完成，接下来会自动启动并出二维码'),
          jobId,
        }
        // 安装完直接拉起，减少一步；拉起失败（例如本机 QQ 还在跑）不算安装失败
        try {
          await this.startNapcat()
        } catch (e) {
          const message = String((e && e.message) || e)
          this.provision.installJob = {
            ...this.provision.installJob,
            state: 'done',
            stage: '已安装，待启动',
            log: this.appendJobLog('已安装，但还不能启动：' + message),
          }
        }
      } catch (e) {
        this.provision.installJob = {
          state: 'failed',
          stage: '安装失败',
          percent: this.provision.installJob.percent || 0,
          log: this.appendJobLog('安装失败：' + String((e && e.message) || e)),
          jobId,
        }
      }
    })().catch((e) => {
      // 兜底：安装任务里的任何遗漏异常都不能变成 unhandledRejection（会把 DSH host 打崩）
      const message = String((e && e.message) || e)
      if (controller.signal.aborted) {
        if (this.provision.installJob.state !== 'cancelled') {
          this.provision.installJob = {
            state: 'cancelled',
            stage: '已取消',
            percent: this.provision.installJob.percent || 0,
            log: this.appendJobLog('用户取消了安装'),
            jobId,
          }
        }
        return
      }
      this.provision.installJob = {
        state: 'failed',
        stage: '安装失败',
        percent: this.provision.installJob.percent || 0,
        log: this.appendJobLog('安装任务异常：' + message),
        jobId,
      }
      this.log.error('安装任务异常：' + message)
    }).finally(() => {
      if (this.installAbort === controller) this.installAbort = null
    })
    return { ok: true, jobId }
  }

  /** 用户点「取消安装」：打断下载/安装，任务落 cancelled 而不是 failed */
  cancelInstall() {
    const job = this.provision.installJob && typeof this.provision.installJob === 'object' ? this.provision.installJob : {}
    if (job.state !== 'running') {
      return { ok: true, cancelled: false, note: '当前没有正在进行的安装' }
    }
    if (this.installAbort) {
      try {
        this.installAbort.abort()
      } catch {}
    }
    this.provision.installJob = {
      state: 'cancelled',
      stage: '已取消',
      percent: Number(job.percent) || 0,
      log: this.appendJobLog('用户取消了安装'),
      jobId: job.jobId || '',
    }
    return { ok: true, cancelled: true, jobId: job.jobId || '' }
  }

  appendJobLog(line) {
    const stamp = new Date().toISOString().slice(11, 19)
    const clean = String(line).replace(/\s+/g, ' ').slice(0, 200)
    const next = `${this.provision.installJob.log ? this.provision.installJob.log + '\n' : ''}${stamp} ${clean}`
    const lines = next.split('\n')
    return lines.slice(-40).join('\n')
  }

  async startNapcat() {
    requireSafety()
    if (this.provision.mode === 'external') {
      return { ok: true, note: '外部模式不需要托管启动' }
    }
    const provisioner = await this.getProvisioner()
    if (!provisioner) throw new BridgeError(this.provisionModuleError || '托管模块不可用', 'provision-unavailable')
    if (!this.provision.napcat.installed && !this.provision.napcat.dir) {
      await this.detectProvision()
    }
    let result
    this.provision.napcat.lastErrorCode = ''
    try {
      result = await provisioner.start()
    } catch (e) {
      this.provision.napcat.lastErrorCode = 'start-failed'
      throw new BridgeError('启动 NapCat 失败：' + String((e && e.message) || e), 'start-failed')
    }
    if (result && result.needsUac) {
      this.provision.napcat.lastError = '需要管理员权限（UAC 弹窗是正常的）：请在弹出的窗口点「是」'
      this.provision.napcat.lastErrorCode = 'uac-required'
      throw new BridgeError(this.provision.napcat.lastError, 'uac-required')
    }
    if (result && result.needsQqStop) {
      this.provision.napcat.lastError =
        '需要先退出正在运行的 QQ：同一个 QQ 号不能同时登录桌面 QQ 和 NapCat。退出 QQ 后再点「启动 QQ 桥」即可（插件不会偷偷杀你的 QQ）。'
      this.provision.napcat.lastErrorCode = 'qq-running'
      throw new BridgeError(this.provision.napcat.lastError, 'qq-running')
    }
    if (result && result.needsInstall) {
      throw new BridgeError(result.error || '还没安装 QQ 桥', 'need-provision')
    }
    if (result && result.ok === false) {
      throw new BridgeError(result.error || '启动 NapCat 失败', 'start-failed')
    }
    this.provision.napcat.lastError = ''
    this.provision.napcat.lastErrorCode = ''
    this.provision.napcat.running = true
    await this.waitWebuiReady()
    await this.detectProvision()
    return { ok: true }
  }

  async waitWebuiReady(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = ''
    while (Date.now() < deadline && !this.disposed) {
      try {
        const webui = await this.ensureWebui(true)
        if (!webui) {
          lastError = '尚未拿到 WebUI 端口/token'
        } else {
          await webui.login()
          try {
            await webui.checkStatus()
          } catch {}
          return { ok: true }
        }
      } catch (e) {
        lastError = String((e && e.message) || e)
      }
      await sleep(1500)
    }
    this.provision.napcat.lastError = 'WebUI 还没就绪：' + (lastError || '超时')
    throw new BridgeError(this.provision.napcat.lastError, 'webui-not-ready')
  }

  async killQQForNapcat() {
    requireSafety()
    if (this.provision.mode === 'external') {
      throw new BridgeError('外部模式不会动你本机的 QQ', 'external-mode')
    }
    const provisioner = await this.getProvisioner()
    if (!provisioner || typeof provisioner.killQQForNapcat !== 'function') {
      throw new BridgeError('托管模块不支持关闭 QQ', 'provision-unavailable')
    }
    const result = await provisioner.killQQForNapcat()
    // 关掉后再尝试启动一次
    try {
      await this.startNapcat()
    } catch (e) {
      return { ok: true, killed: result, started: false, error: String((e && e.message) || e), code: (e && e.code) || '' }
    }
    return { ok: true, killed: result, started: true }
  }

  async stopNapcat() {
    if (this.provision.mode === 'external') {
      this.disconnectBridge()
      return { ok: true, note: '外部模式不会停止你的 NapCat' }
    }
    const provisioner = await this.getProvisioner()
    this.disconnectBridge()
    this.login = { ...this.login, phase: 'idle', isLogin: false, isOffline: false, qrDataUrl: '', error: '' }
    if (provisioner) {
      try {
        await provisioner.stop()
      } catch (e) {
        this.provision.napcat.lastError = '停止 NapCat 失败：' + String((e && e.message) || e)
      }
    }
    this.provision.napcat.running = false
    return { ok: true }
  }

  async setupExternal(input) {
    const wsUrl = String((input && input.wsUrl) || '').trim()
    if (!wsUrl) {
      throw new BridgeError('外部 NapCat 必须填 OneBot WebSocket 地址（例如 ws://127.0.0.1:3001）；想用插件的自动安装请点「切回插件托管」', 'invalid-external')
    }
    const patch = { onebotMode: 'external', wsUrl }
    if (input.wsToken !== undefined) patch.wsToken = input.wsToken
    if (input.webuiUrl !== undefined) patch.webuiUrl = input.webuiUrl
    if (input.webuiToken !== undefined) patch.webuiToken = input.webuiToken
    saveConfig(patch)
    this.disconnectBridge()
    this.webui = null
    this.provision.mode = 'external'
    this.provision.napcat.managed = false
    this.provision.napcat.installed = !!loadConfig().wsUrl
    if (this.provision.napcat.installed) {
      return this.connectBridge()
    }
    return { ok: true }
  }

  /** 从「外部 NapCat」切回插件托管：清空外部地址，重新按托管模式探测 */
  async useManaged() {
    saveConfig({ onebotMode: 'managed', wsUrl: '', wsToken: '', webuiUrl: '', webuiToken: '' })
    this.disconnectBridge()
    this.webui = null
    this.provision.mode = 'managed'
    this.provision.napcat.managed = true
    await this.detectProvision()
    this.log.info('已切回插件托管模式')
    return { ok: true, provision: this.provisionSnapshot() }
  }

  // ───────────────────────────── 登录 / 二维码 ─────────────────────────────

  async ensureWebui(force = false) {
    const config = loadConfig()
    let baseUrl = ''
    let token = ''
    if (config.onebotMode === 'external') {
      baseUrl = config.webuiUrl || ''
      token = config.webuiToken || ''
    } else {
      if (!this.provisionTokens.webuiPort || !this.provisionTokens.webuiToken) {
        this.readProvisionTokensFromDisk()
      }
      if (this.provisionTokens.webuiPort) baseUrl = `http://127.0.0.1:${this.provisionTokens.webuiPort}`
      token = this.provisionTokens.webuiToken || ''
    }
    if (!baseUrl || !token) return null
    if (!this.webui || force || this.webui.baseUrl !== baseUrl || this.webui.token !== token) {
      try {
        const mod = await import('./webui.mjs')
        this.webui = new mod.NapCatWebUI({ baseUrl, token, log: this.log })
      } catch (e) {
        this.webuiModuleError = 'WebUI 模块未就绪：' + String((e && e.message) || e)
        return null
      }
    }
    return this.webui
  }

  async loginStart() {
    requireSafety()
    if (this.client && this.client.state === 'online') {
      this.login.phase = 'ready'
      this.login.isLogin = true
      return this.loginSnapshot()
    }
    const config = loadConfig()
    if (config.onebotMode === 'external' && !config.webuiUrl) {
      // 进阶路径：只填了 WS 地址 → 直接连桥，不提供面板扫码
      const result = await this.connectBridge()
      if (!result.ok) {
        throw new BridgeError(
          '进阶路径没有填 WebUI 地址：请直接在手机 QQ 里用你的 NapCat 登录（或用它的 WebUI 扫码），然后回到这里点「连接 QQ」',
          'external-no-webui',
        )
      }
      return this.loginSnapshot()
    }

    // 托管模式：没装就先提示，没跑就先拉起
    if (this.provision.mode === 'none' || (config.onebotMode === 'managed' && !this.provision.napcat.installed)) {
      await this.detectProvision()
    }
    if (config.onebotMode === 'managed' && !this.provision.napcat.installed) {
      throw new BridgeError('还没有装 QQ 桥：请点「一键安装 QQ 桥」（Windows 托管安装），或改用「我已有 NapCat」', 'need-provision')
    }
    if (config.onebotMode === 'managed' && !this.provision.napcat.running) {
      await this.startNapcat()
    }
    const webui = await this.ensureWebui()
    if (!webui) {
      throw new BridgeError(
        this.webuiModuleError || '还没拿到 NapCat 的 WebUI 端口/token：请先启动 QQ 桥，或改用「我已有 NapCat」',
        'webui-unavailable',
      )
    }
    await webui.login()
    // 注意：不要在这里删 cache/qrcode.png —— NapCat 的二维码是在登录服务启动时生成的，
    // 这时候删了就不会再写一张，面板会一直空着。改为「优先取本次启动之后写入的 PNG」。
    const startedAt = Date.now()
    let qr
    try {
      qr = await webui.getQr()
    } catch (e) {
      const message = String((e && e.message) || e)
      if (/logined|已登录/i.test(message)) {
        this.login.phase = 'ready'
        this.login.isLogin = true
        await this.pollLoginOnce()
        return this.loginSnapshot()
      }
      // 可能只是二维码还没生成，交给状态轮询
      this.login.error = message
    }
    this.login.qrText = String((qr && qr.qrcode) || '')
    this.login.qrDataUrl = (await this.waitQrPng(false, startedAt)) || this.login.qrDataUrl
    this.login.phase = 'waiting_qrcode'
    this.login.isLogin = false
    this.login.isOffline = false
    this.login.error = this.login.qrDataUrl ? '' : '二维码正在生成，稍等几秒或点「刷新二维码」'
    this.startLoginPollTimer()
    return this.loginSnapshot()
  }

  startLoginPollTimer() {
    // 统一由 tick 轮询，无需额外 timer；这里只保证 phase 在活跃集合里
    if (!LOGIN_ACTIVE_PHASES.has(this.login.phase)) this.login.phase = 'waiting_qrcode'
  }

  async loginRefresh() {
    requireSafety()
    const webui = await this.ensureWebui()
    if (!webui) throw new BridgeError('WebUI 未就绪', 'webui-unavailable')
    await webui.login()
    this.clearStaleQr()
    let data
    try {
      data = await webui.refreshQr()
    } catch (e) {
      throw new BridgeError('刷新二维码失败：' + String((e && e.message) || e), 'qr-refresh-failed')
    }
    if (data && data.restarting) {
      this.login.phase = 'reconnecting'
      this.login.error = 'NapCat 正在后台重启，请稍等十几秒'
      return this.loginSnapshot()
    }
    if (data && data.qrcodeurl) this.login.qrText = String(data.qrcodeurl)
    this.login.qrDataUrl = (await this.waitQrPng(true)) || this.login.qrDataUrl
    this.login.phase = 'waiting_qrcode'
    this.login.error = ''
    return this.loginSnapshot()
  }

  /** 删掉缓存目录里上一轮的二维码 PNG（只动 NapCat 的 cache 文件） */
  clearStaleQr() {
    const dir = this.provision.napcat.dir
    if (!dir) return
    for (const file of [join(dir, 'cache', 'qrcode.png'), join(dir, 'napcat', 'cache', 'qrcode.png')]) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {}
    }
  }

  /**
   * 读取 NapCat 写盘的二维码 PNG（最稳的展示通道）。
   * @param {boolean} force 刷新时多等一会儿
   * @param {number} minMtimeMs 只优先接受这个时间之后写入的文件（避免显示上一次启动的过期码）
   * @returns {Promise<string>} data URL 或 ''
   */
  async waitQrPng(force = false, minMtimeMs = 0) {
    const attempts = force ? 24 : 16
    let fallback = ''
    for (let i = 0; i < attempts; i++) {
      if (this.disposed) return fallback
      try {
        const dir = this.provision.napcat.dir
        if (dir) {
          // 真机 v4.18.41 的二维码 PNG 只有约 600 字节（147×147 的 1-bit），不能按文件大小卡
          const candidates = [join(dir, 'cache', 'qrcode.png'), join(dir, 'napcat', 'cache', 'qrcode.png')]
          for (const file of candidates) {
            if (!existsSync(file)) continue
            let mtimeMs = 0
            try {
              mtimeMs = statSync(file).mtimeMs
            } catch {}
            const buffer = readFileSync(file)
            if (buffer.length <= 100 || !isPng(buffer)) continue
            const dataUrl = 'data:image/png;base64,' + buffer.toString('base64')
            if (minMtimeMs && mtimeMs && mtimeMs < minMtimeMs) {
              fallback = fallback || dataUrl
              continue
            }
            return dataUrl
          }
        }
      } catch {}
      await sleep(500)
    }
    // 没有「本次新写入」的也先把现有那张给面板（总比空着强）
    return fallback
  }

  async pollLoginOnce() {
    return this.loginPoll()
  }

  async loginPoll() {
    const config = loadConfig()
    this.login.lastPollAt = Date.now()
    if (config.onebotMode === 'external') {
      if (this.client && this.client.state === 'online') {
        this.login.phase = 'ready'
        this.login.isLogin = true
        this.login.isOffline = false
        this.login.error = ''
      }
      return this.loginSnapshot()
    }
    const webui = await this.ensureWebui()
    if (!webui) return this.loginSnapshot()
    let status
    try {
      await webui.login()
      status = await webui.checkStatus()
    } catch (e) {
      const message = String((e && e.message) || e)
      if (!/Unauthorized/.test(message)) this.login.error = message
      return this.loginSnapshot()
    }
    this.applyLoginStatus(status)
    if (this.login.isLogin) {
      // 登录成功：补账号信息 + 连桥
      try {
        const info = await webui.getLoginInfo()
        this.applyAccount(info)
      } catch {}
      if (!this.client) {
        this.connectBridge().catch((e) => this.log.warn('登录后连接 QQ 桥失败：' + String((e && e.message) || e)))
      }
    } else if (LOGIN_ACTIVE_PHASES.has(this.login.phase)) {
      if (!this.login.qrDataUrl) this.login.qrDataUrl = await this.waitQrPng()
    }
    return this.loginSnapshot()
  }

  applyLoginStatus(status) {
    const data = status || {}
    const loginPhase = String(data.loginPhase || '')
    this.login.isLogin = data.isLogin === true
    this.login.isOffline = data.isOffline === true
    this.login.error = String(data.loginError || '')
    if (this.login.isLogin) {
      this.login.phase = 'ready'
      this.login.error = ''
      this.login.qrDataUrl = ''
      this.login.qrText = ''
      this.login.isOffline = false
      return
    }
    if (this.login.isOffline) {
      this.login.phase = 'offline'
      return
    }
    if (loginPhase === 'qrcode_scanned') this.login.phase = 'qrcode_scanned'
    else if (loginPhase === 'initializing') this.login.phase = 'initializing'
    else if (loginPhase === 'reconnecting') this.login.phase = 'reconnecting'
    else if (loginPhase === 'generating_qrcode') this.login.phase = 'generating_qrcode'
    else if (loginPhase === 'offline') this.login.phase = 'offline'
    else if (loginPhase === 'ready') this.login.phase = 'ready'
    else this.login.phase = 'waiting_qrcode'
    if (data.qrcodeurl && !this.login.qrText) this.login.qrText = String(data.qrcodeurl)
  }

  applyAccount(info) {
    if (!info) return
    const uin = String(info.user_id || info.uin || info.uid || '')
    if (!uin) return
    const nickname = String(info.nickname || info.nick || '小肥鱼')
    const avatarUrl = String(info.avatarUrl || info.avatar || '')
    this.login.account = { uin, nickname, avatarUrl }
    this.login.isLogin = true
    this.login.phase = 'ready'
    try {
      saveConfig({ account: { uin: maskUin(uin), nickname } })
    } catch {}
    this.log.info(`账号已就绪：${maskUin(uin)}（${nickname}）`)
  }

  // ───────────────────────────── 快捷登录 ─────────────────────────────

  async quickLoginList() {
    const webui = await this.ensureWebui()
    if (!webui) return { ok: true, items: [] }
    await webui.login()
    const list = await webui.quickList()
    const items = (Array.isArray(list) ? list : []).map((item) => {
      const rawUin = String(item.uin || item.user_id || item.id || '')
      return {
        uin: maskUin(rawUin),
        rawUin,
        // 面板兼容字段：/login/quick 需要明文 uin；同时提供 id 别名
        id: rawUin,
        nickname: String(item.nickname || item.nick || ''),
        avatarUrl: String(item.avatarUrl || ''),
      }
    })
    return { ok: true, items }
  }

  async quickLogin(uin) {
    requireSafety()
    const webui = await this.ensureWebui()
    if (!webui) throw new BridgeError('WebUI 未就绪，无法快速登录', 'webui-unavailable')
    await webui.login()
    await webui.quickLogin(String(uin).replace(/\D/g, ''))
    this.login.phase = 'initializing'
    await sleep(1500)
    return this.loginPoll()
  }

  // ───────────────────────────── OneBot 桥 ─────────────────────────────

  async resolveOneBotConfig() {
    const config = loadConfig()
    if (config.onebotMode === 'external') {
      return { url: config.wsUrl, token: config.wsToken, managed: false }
    }
    if (!this.provisionTokens.onebotPort || !this.provisionTokens.onebotToken) {
      this.readProvisionTokensFromDisk()
    }
    const port = this.provisionTokens.onebotPort
    if (!port) return { url: '', token: '', managed: true }
    return { url: `ws://127.0.0.1:${port}`, token: this.provisionTokens.onebotToken, managed: true }
  }

  async connectBridge() {
    if (this.disposed) return { ok: false, error: '插件已卸载' }
    if (this.client && this.client.state === 'online') return { ok: true, state: 'online' }
    const { url, token } = await this.resolveOneBotConfig()
    if (!url) {
      throw new BridgeError('还没有可连接的 QQ 桥：先完成扫码登录，或在进阶路径里填 WebSocket 地址', 'no-onebot')
    }
    if (this.client) {
      try {
        this.client.close()
      } catch {}
      this.client = null
    }
    const client = new OneBotClient({
      url,
      token,
      onEvent: (event) => { const p = this.engine.handle(event); if (p && typeof p.catch === 'function') p.catch((e) => this.log && this.log.warn && this.log.warn('处理消息失败：' + ((e && e.message) || e))) },
      onState: (state) => this.onBridgeState(state),
    })
    this.client = client
    client.connect()
    return { ok: true }
  }

  onBridgeState(state) {
    if (!state || typeof state !== 'object') return
    runtime.bridge = {
      state: state.state || runtime.bridge.state,
      detail: state.detail || runtime.bridge.detail,
      lastError: state.state === 'error' ? String(state.detail || '') : runtime.bridge.lastError,
    }
    if (state.selfId) {
      this.applyAccount({ user_id: state.selfId, nickname: state.nickname })
    }
    if (state.state === 'online') {
      this.login.phase = 'ready'
      this.login.isLogin = true
      this.login.isOffline = false
      this.login.qrDataUrl = ''
      this.login.error = ''
      this.scheduler.start()
      this.syncContacts().catch(() => {})
      // 连上后补一次账号信息
      if (this.client) {
        this.client
          .getLoginInfo()
          .then((info) => this.applyAccount(info))
          .catch(() => {})
      }
    } else if (state.state === 'reconnecting') {
      this.login.phase = 'reconnecting'
    } else if (state.state === 'error') {
      this.login.error = String(state.detail || '')
    }
  }

  disconnectBridge() {
    if (this.client) {
      try {
        this.client.close()
      } catch {}
      this.client = null
    }
    try {
      this.scheduler.stop()
    } catch {}
    runtime.bridge = { state: 'idle', detail: '已断开 QQ 桥', lastError: '' }
  }

  // ───────────────────────────── 聊天 ─────────────────────────────

  async sendMessage(input) {
    requireSafety()
    const text = String((input && input.text) || '').trim()
    if (!text) throw new BridgeError('消息不能为空', 'empty-message')
    if (!this.client || this.client.state !== 'online') throw new BridgeError('QQ 桥还没连上', 'bridge-offline')
    const kind = input.kind === 'group' ? 'group' : 'private'
    const id = String(input.id || '').replace(/\D/g, '')
    if (!id) throw new BridgeError('缺少发送目标', 'no-target')
    const config = loadConfig()
    const body = text.slice(0, Math.max(60, Number(config.maxReplyChars) || 400))
    const target = kind === 'group' ? { kind, groupId: id } : { kind, userId: id }
    let result
    try {
      // 【dryRun】面板 /say 用：只生成不真发，回复存 _lastSent（不发 QQ、不写聊天记录）
      if (this._dryRun) {
        this._lastSent = String(body || '')
        return { ok: true, messageId: '', dryRun: true }
      }
      result = await this.client.send(target, body)
    } catch (e) {
      throw new BridgeError('发送失败：' + String((e && e.message) || e), 'send-failed')
    }
    appendMessage({
      ts: Date.now(),
      direction: 'out',
      channel: kind,
      conversation: `${kind}:${id}`,
      uin: id,
      who: config.personaName || '小肥鱼',
      text: body,
      generatedBy: 'manual',
    })
    bumpStats('sent')
    return { ok: true, messageId: result && (result.message_id || result.messageId) ? String(result.message_id || result.messageId) : '' }
  }

  /**
   * 发语音（record 段）。NapCat 会自动把 mp3 转成 QQ 语音，不用手动转 amr/silk。
   * @param {{kind:'group'|'private', groupId?:string, userId?:string}} target
   * @param {string} fileBase64 'base64://...'
   */
  async sendVoice(target, fileBase64) {
    // 【dryRun】面板预览语音时不要真发
    if (this._dryRun) return { ok: true, dryRun: true }
    const file = String(fileBase64 || '')
    if (!file.startsWith('base64://')) throw new BridgeError('语音必须是 base64:// 形式', 'bad-voice')
    if (!this.client || this.client.state !== 'online') throw new BridgeError('QQ 桥还没连上', 'bridge-offline')
    const segment = { type: 'record', data: { file } }
    const t = target || {}
    if (t.kind === 'group') {
      return this.client.call('send_group_msg', { group_id: Number(t.groupId), message: [segment] })
    }
    return this.client.call('send_private_msg', { user_id: Number(t.userId), message: [segment] })
  }

  /** 发一张 json 卡片（B 站小程序卡 / structmsg ark）；target 同 send 的 {kind, groupId|userId} */
  async sendCard(target, jsonStr) {
    const t = target || {}
    const message = [{ type: 'json', data: { data: String(jsonStr || '') } }]
    if (t.kind === 'group') {
      return this.client.call('send_group_msg', { group_id: Number(t.groupId), message })
    }
    return this.client.call('send_private_msg', { user_id: Number(t.userId), message })
  }

  listChats() {
    const rows = recentMessages(2000)
    const contacts = loadContacts()
    const nameMap = new Map()
    for (const item of contacts.friends || []) nameMap.set(`private:${item.uin}`, item.name || '')
    for (const item of contacts.groups || []) nameMap.set(`group:${item.groupId}`, item.name || '')
    const map = new Map()
    for (const row of rows) {
      if (!row || !row.conversation || !row.uin) continue
      const key = row.conversation
      const item =
        map.get(key) ||
        {
          key,
          kind: row.channel === 'group' ? 'group' : 'private',
          id: String(row.uin),
          name: nameMap.get(key) || '',
          lastText: '',
          lastTs: 0,
          count: 0,
        }
      item.count += 1
      if (Number(row.ts) >= item.lastTs) {
        item.lastTs = Number(row.ts) || 0
        item.lastText = String(row.text || '')
        if (!item.name && row.direction === 'in' && row.who) item.name = String(row.who)
      }
      map.set(key, item)
    }
    const list = [...map.values()]
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 60)
      .map((item) => ({
        ...item,
        idMasked: maskUin(item.id),
        name: item.name || (item.kind === 'group' ? `群 ${maskUin(item.id)}` : maskUin(item.id)),
      }))
    return { ok: true, conversations: list }
  }

  /**
   * 查一条被引用消息的「谁 + 说了什么」，供面板在引用气泡上显示。
   * 带内存缓存：面板刷新会重复请求同一批 quoted，不能每次都打 get_msg。
   */
  async describeQuoted(messageId) {
    const id = String(messageId || '').trim()
    if (!id) return ''
    if (!this.quotedTextCache) this.quotedTextCache = new Map()
    if (this.quotedTextCache.has(id)) return this.quotedTextCache.get(id)
    let out = ''
    try {
      if (this.client && this.client.state === 'online' && typeof this.client.getMsg === 'function') {
        const orig = await this.client.getMsg(id)
        if (orig) {
          const sender = orig.sender && typeof orig.sender === 'object' ? orig.sender : {}
          const who = String(sender.card || sender.nickname || sender.user_id || '对方').slice(0, 30)
          const segs = Array.isArray(orig.message) ? orig.message : []
          const body = segs.length ? segmentsToText(segs) : String(orig.raw_message || '')
          const clean = String(body || '').replace(/\s+/g, ' ').trim()
          if (clean) out = `${who}：${clean.slice(0, 120)}`
        }
      }
    } catch {}
    this.quotedTextCache.set(id, out)
    if (this.quotedTextCache.size > 800) {
      const oldest = this.quotedTextCache.keys().next().value
      if (oldest !== undefined) this.quotedTextCache.delete(oldest)
    }
    return out
  }

  async getMessages(conversation, limit = 200) {
    const config = loadConfig()
    const key = String(conversation || '')
    const rows = recentMessages(Math.max(200, Number(limit) || 200) * 2)
    const filtered = rows.filter((row) => row && row.conversation === key).slice(-Math.max(20, Number(limit) || 200))
    const messages = []
    for (const row of filtered) {
      const quotedId = String(row.quoted || '')
      messages.push({
        ts: Number(row.ts) || 0,
        direction: row.direction === 'out' ? 'out' : 'in',
        who: String(row.who || ''),
        text: config.privacyMode ? maskSensitiveText(String(row.text || '')) : String(row.text || ''),
        generatedBy: String(row.generatedBy || ''),
        usage: row.usage || null,
        // 引用：面板要展示被引用的原文，这里补查（带缓存）
        quoted: quotedId,
        quotedText: quotedId ? await this.describeQuoted(quotedId) : '',
      })
    }
    return { ok: true, messages, privacyMode: !!config.privacyMode }
  }

  async syncContacts() {
    if (!this.client || this.client.state !== 'online') {
      throw new BridgeError('QQ 桥还没连上，无法同步联系人', 'bridge-offline')
    }
    const [friendsRaw, groupsRaw] = await Promise.all([
      this.client.getFriendList().catch(() => []),
      this.client.getGroupList().catch(() => []),
    ])
    const friends = (Array.isArray(friendsRaw) ? friendsRaw : []).map((item) => ({
      uin: String(item.user_id || ''),
      name: String(item.remark || item.nickname || ''),
    })).filter((item) => item.uin)
    const groups = (Array.isArray(groupsRaw) ? groupsRaw : []).map((item) => ({
      groupId: String(item.group_id || ''),
      name: String(item.group_name || ''),
    })).filter((item) => item.groupId)
    saveContacts({ friends, groups, updatedAt: Date.now() })
    return { ok: true, friends: friends.length, groups: groups.length }
  }

  // ───────────────────────────── 主动推送 / 碎碎念 ─────────────────────────────

  normalizeTarget(target) {
    if (!target) return null
    const kind = target.kind === 'group' ? 'group' : 'private'
    const id = String(target.id || target.groupId || target.userId || '').replace(/\D/g, '')
    if (!id) return null
    const name = String(target.name || '')
    return kind === 'group' ? { kind, id, groupId: id, name } : { kind, id, userId: id, name }
  }

  async pushNow(target) {
    requireSafety()
    const config = loadConfig()
    return this.scheduler.pushOnce(config, { manual: true, target: this.normalizeTarget(target) || undefined })
  }

  async whisperNow() {
    requireSafety()
    const config = loadConfig()
    return this.scheduler.whisperOnce(config, { manual: true })
  }

  // ───────────────────────────── 安全 / 紧急停止 ─────────────────────────────

  ackSafety() {
    const safety = saveSafety({ acknowledged: true })
    return { ok: true, safety }
  }

  async emergencyStop() {
    try {
      this.scheduler.stop()
    } catch {}
    this.disconnectBridge()
    if (this.provision.mode !== 'external') {
      const provisioner = await this.getProvisioner()
      if (provisioner) {
        try {
          await provisioner.stop()
        } catch {}
      }
      this.provision.napcat.running = false
    }
    this.login = { ...this.login, phase: 'idle', isLogin: false, isOffline: false, qrDataUrl: '', error: '' }
    return { ok: true }
  }

  // ───────────────────────────── 快照 ─────────────────────────────

  loginSnapshot() {
    return {
      phase: this.login.phase,
      isLogin: !!this.login.isLogin,
      isOffline: !!this.login.isOffline,
      qrDataUrl: this.login.qrDataUrl || '',
      qrText: this.login.qrText || '',
      error: this.login.error || '',
      account: this.login.account
        ? { uin: maskUin(this.login.account.uin), nickname: this.login.account.nickname, avatarUrl: this.login.account.avatarUrl || '' }
        : null,
    }
  }

  bridgeSnapshot() {
    const config = loadConfig()
    return {
      state: this.client ? this.client.state : runtime.bridge.state === 'online' ? 'idle' : runtime.bridge.state,
      detail: this.client ? runtime.bridge.detail : '还没连 QQ 桥',
      lastError: runtime.bridge.lastError || '',
      selfId: this.client && this.client.selfId ? maskUin(this.client.selfId) : this.login.account ? maskUin(this.login.account.uin) : '',
      nickname: (this.client && this.client.nickname) || (this.login.account && this.login.account.nickname) || '',
      wsConfigured: !!(config.wsUrl || this.provisionTokens.onebotPort),
    }
  }

  snapshot() {
    const config = loadConfig()
    const safety = loadSafety()
    const stats = loadStats()
    const usage = usageSummary()
    return {
      ok: true,
      version: this.version,
      home: stateHome(),
      now: Date.now(),
      config: { ...config, wsToken: undefined, webuiToken: undefined, hasToken: !!config.wsToken },
      provision: this.provisionSnapshot(),
      login: this.loginSnapshot(),
      bridge: this.bridgeSnapshot(),
      scheduler: this.scheduler.snapshot(config),
      stats: {
        today: { received: stats.received, sent: stats.sent, replies: stats.replies, llmCalls: usage.today.calls },
        lifetime: {
          received: stats.lifetime.received || 0,
          sent: stats.lifetime.sent || 0,
          replies: stats.lifetime.replies || 0,
          llmCalls: usage.lifetime.calls || 0,
        },
      },
      safety,
      usage: {
        today: usage.today,
        lifetime: usage.lifetime,
      },
    }
  }
}

export { BridgeError }
