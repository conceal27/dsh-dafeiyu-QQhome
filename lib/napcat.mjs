/**
 * lib/napcat.mjs — NapCat 本机托管：探测 / 下载安装 / 配置 / 启停 / 二维码兜底（归属：xingzhu）
 * ============================================================================
 * 本模块只做「把 NapCat 装好、管好」这件事，不碰人设/LLM/聊天：
 *   1. detectQQ()      读注册表 + 常见路径探测本机 QQ NT，查 QQ.exe 进程路径；
 *   2. detectManaged() 找托管目录里已解压的 NapCat，读 config/webui.json 的端口/token
 *                      与 config/onebot11*.json 的 websocketServers；
 *   3. install()       Windows：GitHub Releases 下载 NapCat.Shell.zip（需本机 QQ）
 *                      或 NapCat.Shell.Windows.Node.zip（自带 QQ），系统 tar.exe /
 *                      PowerShell Expand-Archive 解压，写 webui.json + onebot11.json，
 *                      端口/token 落进 `$DSH_HOME/qq-fish/napcat.json`（0600 尽力而为）；
 *   4. start()/stop()  优先 launcher-user.bat（免 UAC），再 launcher.bat；只结束自己拉起的
 *                      进程树，绝不 `taskkill /IM QQ.exe` 一把全杀；
 *   5. readQrPng()     `<dir>/cache/qrcode.png` 作为二维码兜底通道（PNG 头 + ≥10KB 校验）。
 *
 * 权威事实：_research/qq/napcat-reference.md（安装形态/启动器/配置/端口/鉴权/二维码/坑）。
 * 安全红线：
 *   - WebUI 与 OneBot 一律绑 127.0.0.1，不接受 0.0.0.0；
 *   - token 只在内存与本地 0600 文件里，不进日志、不回显面板（出面板前套 maskProvisionStatus）；
 *   - 外部命令一律 execFile/spawn + 参数数组；下载 URL 与解压路径做路径穿越校验。
 * ============================================================================
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { readJson, stateHome as defaultStateHome, writeJsonAtomic } from './store.mjs'
import { createLogger, scrubLogLine } from './redact.mjs'

/** NapCat 官方仓库 Releases 最新版接口（asset 名大小写必须精确） */
export const NAPCAT_RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest'
export const NAPCAT_ASSETS = {
  shell: 'NapCat.Shell.zip',
  node: 'NapCat.Shell.Windows.Node.zip',
}
/** 启动器优先级：先免 UAC 的 user 版，再普通版（会弹 UAC），最后 OneKey 的 napcat.bat */
export const LAUNCHER_ORDER = ['launcher-user.bat', 'launcher-win10-user.bat', 'launcher.bat', 'launcher-win10.bat', 'napcat.bat']
/** 用来识别「这是不是一个 NapCat 目录」的特征文件 */
export const MARKER_FILES = [
  'launcher-user.bat',
  'launcher-win10-user.bat',
  'launcher.bat',
  'launcher-win10.bat',
  'napcat.bat',
  'napcat.mjs',
  'qqnt.json',
  'NapCatWinBootMain.exe',
]
const DEFAULT_WEBUI_PORT = 6099
const DEFAULT_ONEBOT_PORT = 3001
const QQ_REG_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
]
/** 安装进度阶段（面板直接展示中文 label；stageKey 给程序判断） */
const STAGE_LABELS = {
  detect: '检测 QQ',
  resolve: '获取版本',
  prepare: '准备安装',
  download: '下载安装包',
  extract: '解压',
  configure: '写配置',
  done: '完成',
}

/** 安装失败错误：带 stage/httpStatus/url/targetDir/hint/diagnostics，方便面板与日志排障 */
export class NapCatInstallError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'NapCatInstallError'
    this.stage = info.stage || ''
    this.httpStatus = info.httpStatus || 0
    this.url = info.url || ''
    this.targetDir = info.targetDir || ''
    this.hint = info.hint || ''
    this.detail = info.detail || ''
    this.diagnostics = null
    if (info.cause) this.cause = info.cause
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function messageOf(error) {
  if (!error) return '未知错误'
  return String(error.message || error)
}

function normalizeLog(log, prefix) {
  if (log && typeof log.info === 'function' && typeof log.warn === 'function' && typeof log.error === 'function') return log
  if (typeof log === 'function') return { info: log, warn: log, error: log }
  return createLogger(prefix)
}

/** 32 位随机 token（hex，含字母与数字，符合 NapCat 改 token 的强度要求） */
function randomToken() {
  return randomBytes(16).toString('hex')
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536
}

function validToken(value) {
  return typeof value === 'string' && value.trim().length >= 8
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 1)))
}

function chmodBestEffort(file, mode = 0o600) {
  try {
    chmodSync(file, mode)
  } catch {
    // Windows 上 chmod 基本无效；尽力而为，不因权限失败中断安装
  }
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase()
  return value === '' || value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]'
}

/** Windows 路径比较（大小写不敏感），用于「同路径 QQ 进程」判定 */
function samePath(left, right) {
  const a = resolvePath(String(left || ''))
  const b = resolvePath(String(right || ''))
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/** target 是否在 root 之内（不含 root 自身） */
function isInside(root, target) {
  const rel = relative(resolvePath(String(root || '')), resolvePath(String(target || '')))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 解压目标必须在托管目录内，防止 .. 穿越写文件 */
function assertInside(root, target) {
  const rel = relative(resolvePath(String(root || '')), resolvePath(String(target || '')))
  if (rel === '') return true
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new NapCatInstallError(`目标路径不在托管目录内，拒绝写入：${target}`, { stage: 'prepare', targetDir: String(target || '') })
  }
  return true
}

function stripOuterQuotes(text) {
  const value = String(text || '').trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
  return value
}

/** 从 UninstallString 里抠出可执行文件路径（支持带引号/带参数两种形态） */
function extractExecutablePath(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const quoted = /^"([^"]+)"/.exec(raw)
  if (quoted) return quoted[1]
  const exe = /^(.+?\.exe)(?:\s|$)/i.exec(raw)
  if (exe) return exe[1]
  return raw
}

/** 解析 `reg query` 输出里的 REG_SZ 值 */
function parseRegValues(text) {
  const values = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s+([A-Za-z0-9_.\-]+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.*)$/.exec(line)
    if (match) values[match[1]] = String(match[2]).trim()
  }
  return values
}

/**
 * 从注册表值推断 QQ.exe 完整路径。
 * 本机实测（QQ 9.9.30）：
 *   UninstallString = "C:\Program Files\Tencent\QQNT\Uninstall.exe"  ← 不是 QQ.exe，要取目录再拼
 *   DisplayIcon     = C:\Program Files\Tencent\QQNT\QQ.exe,0
 *   InstallLocation = 某个目录（可能不存在）
 */
function qqExeFromRegistryValues(values) {
  const candidates = []
  if (values.UninstallString) candidates.push(extractExecutablePath(values.UninstallString))
  if (values.InstallLocation) candidates.push(stripOuterQuotes(String(values.InstallLocation).trim()))
  if (values.DisplayIcon) candidates.push(String(values.DisplayIcon).replace(/,\d+\s*$/, '').trim())
  for (const candidate of candidates) {
    const text = stripOuterQuotes(String(candidate || '').trim())
    if (!text) continue
    if (/QQ\.exe$/i.test(text)) return text
    // 任何 .exe（典型是 Uninstall.exe）：和 QQ.exe 同目录
    if (/\.exe$/i.test(text)) return join(dirname(text), 'QQ.exe')
    // 目录形态：补 QQ.exe
    const name = basename(text)
    if (name && !/\.[A-Za-z0-9]{2,5}$/.test(name)) return join(text, 'QQ.exe')
  }
  return ''
}

/** 常见 QQ NT 安装路径（注册表探测失败时的兜底） */
function commonQQPathsWindows() {
  const out = ['C:\\Program Files\\Tencent\\QQNT\\QQ.exe', 'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe']
  for (const envName of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const root = process.env[envName]
    if (!root) continue
    out.push(join(root, 'Tencent', 'QQNT', 'QQ.exe'))
    if (envName === 'LOCALAPPDATA') out.push(join(root, 'Programs', 'Tencent', 'QQNT', 'QQ.exe'))
  }
  return [...new Set(out)]
}

function escapePowerShell(text) {
  return String(text || '').replace(/'/g, "''")
}

function safeVersionDirName(version) {
  let name = String(version || '')
    .trim()
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .slice(0, 64)
  if (!name || name.startsWith('.')) name = `v${name || 'manual'}`
  return name
}

function versionFromDirName(dir) {
  const match = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)?)/.exec(basename(String(dir || '')))
  return match ? match[1] : ''
}

function formatDateStamp(ms) {
  const date = new Date(Number(ms) || Date.now())
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

/** 目录里存在哪些 NapCat 特征文件 */
function napcatMarkers(dir) {
  const found = []
  for (const name of MARKER_FILES) {
    try {
      if (existsSync(join(dir, name))) found.push(name)
    } catch {
      // ignore
    }
  }
  return found
}

/** 一个目录像不像 NapCat 安装目录：有启动器或主程序（不能光靠单个 qqnt.json 误判） */
function isNapcatDir(dir) {
  if (!dir) return false
  const markers = napcatMarkers(dir)
  if (!markers.length) return false
  const hasLauncher = markers.some((name) => /^launcher.*\.bat$/i.test(name) || name === 'napcat.bat')
  const hasMain = markers.includes('napcat.mjs') || markers.includes('qqnt.json')
  return hasLauncher || hasMain || markers.length >= 2
}

/** 在解压目录里找 NapCat 主目录：可能在根、也可能套了一层/两层；找不到返回 '' */
export function locateNapcatDir(root) {
  const start = String(root || '')
  if (!start || !existsSync(start)) return ''
  if (isNapcatDir(start)) return start
  let children = []
  try {
    children = readdirSync(start, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(start, entry.name))
  } catch {
    return ''
  }
  for (const child of children) if (isNapcatDir(child)) return child
  for (const child of children) {
    let grandchildren = []
    try {
      grandchildren = readdirSync(child, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(child, entry.name))
    } catch {
      continue
    }
    for (const grandchild of grandchildren) if (isNapcatDir(grandchild)) return grandchild
  }
  return ''
}

/** 选启动器：user 版优先（免 UAC），没有就退回普通版（会弹 UAC） */
function pickLauncher(dir) {
  for (const name of LAUNCHER_ORDER) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    return { name, path: file, needsUac: !/user/i.test(name) }
  }
  return null
}

// ---------------------------------------------------------------------------
// 端口探测：安装/启动前找一个空闲端口（专供 127.0.0.1）
// ---------------------------------------------------------------------------

/** 检测某个本机端口是否空闲（bind 成功即空闲） */
export function isPortFree(port, options = {}) {
  const value = Number(port)
  if (!validPort(value)) return Promise.resolve(false)
  const host = options.host || '127.0.0.1'
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port: value, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/** 从 startPort 起找一个空闲端口（默认最多试 100 个，和 NapCat 自己 +1 的策略一致） */
export async function pickFreePort(startPort, options = {}) {
  const base = Number(startPort)
  if (!Number.isInteger(base) || base < 1 || base > 65535) {
    throw new NapCatInstallError(`起始端口不合法：${startPort}`, { stage: 'port' })
  }
  const span = Number(options.span) > 0 ? Math.min(200, Math.trunc(Number(options.span))) : 100
  const host = options.host || '127.0.0.1'
  let lastBusy = ''
  for (let offset = 0; offset < span; offset += 1) {
    const port = base + offset
    if (port > 65535) break
    if (await isPortFree(port, { host })) return port
    lastBusy = String(port)
  }
  throw new NapCatInstallError(`从 ${base} 起连续 ${span} 个端口都被占用了（最后一个被占：${lastBusy}）`, { stage: 'port' })
}

/** 探测本机端口是否有服务在听（TCP connect） */
export function isPortOpen(port, options = {}) {
  const value = Number(port)
  if (!validPort(value)) return Promise.resolve(false)
  const host = options.host || '127.0.0.1'
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        socket?.destroy()
      } catch {}
      resolve(ok)
    }
    socket = net.connect({ port: value, host })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 等端口就绪（NapCat 启动到 WebUI 可用通常 3~20 秒，最多等 timeoutMs） */
export async function waitPortOpen(port, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90_000
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 800
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port, { host: options.host, timeoutMs: Math.min(800, intervalMs) })) {
      return { ok: true, port: Number(port), waitedMs: Date.now() - startedAt }
    }
    const remain = timeoutMs - (Date.now() - startedAt)
    if (remain <= 0) break
    await sleep(Math.min(intervalMs, remain))
  }
  return { ok: false, port: Number(port), waitedMs: Date.now() - startedAt }
}

/** 等端口关闭（停止 NapCat 后确认真的断了） */
export async function waitPortClosed(port, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10_000
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 300
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isPortOpen(port, { host: options.host, timeoutMs: 400 }))) {
      return { ok: true, port: Number(port), waitedMs: Date.now() - startedAt }
    }
    await sleep(intervalMs)
  }
  return { ok: false, port: Number(port), waitedMs: Date.now() - startedAt }
}

// ---------------------------------------------------------------------------
// 写配置：webui.json + onebot11.json（幂等，保留用户已有字段）
// ---------------------------------------------------------------------------

/**
 * 生成/读取 NapCat 的 WebUI + OneBot 11 配置并写盘（幂等）。
 * 已存在合法端口/token 就沿用，避免每次启动都改 token（否则已登录的 WebUI 会断）。
 *
 * @param {string} dir NapCat 安装目录（其下应有 config/）
 * @param {object} [options] { webuiPortStart=6099, onebotPortStart=3001, force=false }
 * @returns {Promise<{dir:string, configDir:string,
 *   webui:{host:string,port:number,token:string,file:string},
 *   onebot:{host:string,port:number,token:string,file:string},
 *   created:{webui:boolean,onebot:boolean}}>}
 */
export async function ensureNapcatTokens(dir, options = {}) {
  const base = String(dir || '').trim()
  if (!base) throw new NapCatInstallError('ensureNapcatTokens 需要 NapCat 安装目录', { stage: 'config' })
  const configDir = join(base, 'config')
  mkdirSync(configDir, { recursive: true })

  // ---- webui.json ----
  const webuiFile = join(configDir, 'webui.json')
  const existingWebuiRaw = readJson(webuiFile, null)
  const existingWebui = existingWebuiRaw && typeof existingWebuiRaw === 'object' ? existingWebuiRaw : {}
  let webuiPort = validPort(existingWebui.port) ? Number(existingWebui.port) : 0
  let webuiToken = validToken(existingWebui.token) ? String(existingWebui.token).trim() : ''
  const createdWebui = !webuiPort || !webuiToken || options.force === true
  if (options.force === true) {
    webuiPort = 0
    webuiToken = ''
  }
  if (!webuiPort) webuiPort = await pickFreePort(Number(options.webuiPortStart) || DEFAULT_WEBUI_PORT)
  if (!webuiToken) webuiToken = randomToken()
  const webuiConfig = {
    ...existingWebui,
    // 安全红线：强制只监听本机；用户原来写 0.0.0.0 也纠正回 127.0.0.1
    host: '127.0.0.1',
    port: webuiPort,
    token: webuiToken,
    loginRate: Number.isFinite(Number(existingWebui.loginRate)) && Number(existingWebui.loginRate) > 0 ? Number(existingWebui.loginRate) : 3,
  }
  if (JSON.stringify(existingWebuiRaw) !== JSON.stringify(webuiConfig)) {
    writeJsonAtomic(webuiFile, webuiConfig)
    chmodBestEffort(webuiFile, 0o600)
  }

  // ---- onebot11.json（默认模板，登录后新账号继承）----
  const onebotFile = join(configDir, 'onebot11.json')
  const existingOnebotRaw = readJson(onebotFile, null)
  const existingOnebot = existingOnebotRaw && typeof existingOnebotRaw === 'object' ? existingOnebotRaw : {}
  const existingNetwork = existingOnebot.network && typeof existingOnebot.network === 'object' ? existingOnebot.network : {}
  const existingServers = Array.isArray(existingNetwork.websocketServers) ? existingNetwork.websocketServers : []
  const firstServer = existingServers[0] && typeof existingServers[0] === 'object' ? existingServers[0] : {}
  let onebotPort = validPort(firstServer.port) ? Number(firstServer.port) : 0
  let onebotToken = validToken(firstServer.token) ? String(firstServer.token).trim() : ''
  const createdOnebot = !onebotPort || !onebotToken || options.force === true || existingServers.length === 0
  if (options.force === true) {
    onebotPort = 0
    onebotToken = ''
  }
  if (!onebotPort) onebotPort = await pickFreePort(Number(options.onebotPortStart) || DEFAULT_ONEBOT_PORT)
  if (!onebotToken) onebotToken = randomToken()
  const wsServer = {
    ...firstServer,
    name: String(firstServer.name || 'dsh-qq-fish'),
    enable: true,
    host: '127.0.0.1',
    port: onebotPort,
    // array 直接拿消息段数组，避免 string 模式解析 CQ 码踩坑
    messagePostFormat: 'array',
    // 要能看到小肥鱼自己发的消息（聊天记录/上下文需要）
    reportSelfMessage: true,
    token: onebotToken,
    enableForcePushEvent: true,
    debug: false,
    heartInterval: 30_000,
  }
  const onebotConfig = {
    ...existingOnebot,
    network: {
      httpServers: Array.isArray(existingNetwork.httpServers) ? existingNetwork.httpServers : [],
      httpClients: Array.isArray(existingNetwork.httpClients) ? existingNetwork.httpClients : [],
      websocketServers: [wsServer, ...existingServers.slice(1)],
      websocketClients: Array.isArray(existingNetwork.websocketClients) ? existingNetwork.websocketClients : [],
    },
    musicSignUrl: typeof existingOnebot.musicSignUrl === 'string' ? existingOnebot.musicSignUrl : '',
    enableLocalFile2Url: existingOnebot.enableLocalFile2Url === true,
    parseMultMsg: existingOnebot.parseMultMsg === true,
  }
  if (JSON.stringify(existingOnebotRaw) !== JSON.stringify(onebotConfig)) {
    writeJsonAtomic(onebotFile, onebotConfig)
    chmodBestEffort(onebotFile, 0o600)
  }

  return {
    dir: base,
    configDir,
    webui: { host: '127.0.0.1', port: webuiPort, token: webuiToken, file: webuiFile },
    onebot: { host: '127.0.0.1', port: onebotPort, token: onebotToken, file: onebotFile },
    created: { webui: createdWebui, onebot: createdOnebot },
  }
}

// ---------------------------------------------------------------------------
// 下载地址 / 解压安全校验（纯函数，便于测试）
// ---------------------------------------------------------------------------

/**
 * 把 mirrorBase 拼成实际下载地址。
 * - mirrorBase 形如 `https://ghfast.top/https://github.com`（含 github.com）：
 *   直接把 NapNeko/... 拼在后面；
 * - 形如 `https://ghproxy.net`：按 ghproxy 惯例拼成 `<mirrorBase>/https://github.com/NapNeko/...`。
 */
export function resolveDownloadUrl({ mirrorBase, tag, assetName }) {
  const base = String(mirrorBase || '').trim().replace(/\/+$/, '')
  if (!base) throw new NapCatInstallError('mirrorBase 为空', { stage: 'resolve' })
  if (!/^https?:\/\//i.test(base)) throw new NapCatInstallError(`mirrorBase 必须是 http(s) 地址：${base}`, { stage: 'resolve' })
  const version = String(tag || '').trim()
  const asset = String(assetName || '').trim()
  if (!version || !asset) throw new NapCatInstallError('拼下载地址缺少版本号或资产名', { stage: 'resolve' })
  const tail = `NapNeko/NapCatQQ/releases/download/${version}/${asset}`
  if (/github\.com/i.test(base)) return `${base}/${tail}`
  return `${base}/https://github.com/${tail}`
}

/** 校验 zip 条目名：拒绝绝对路径 / Windows 盘符 / `..` 穿越 */
export function validateZipEntryNames(names) {
  const list = Array.isArray(names) ? names : []
  for (const raw of list) {
    const name = String(raw || '').replace(/\\/g, '/').trim()
    if (!name) continue
    if (name.startsWith('/')) {
      throw new NapCatInstallError(`压缩包里有绝对路径条目，拒绝解压：${name}`, { stage: 'extract' })
    }
    if (/^[A-Za-z]:/.test(name)) {
      throw new NapCatInstallError(`压缩包里有盘符路径条目，拒绝解压：${name}`, { stage: 'extract' })
    }
    if (name.split('/').includes('..')) {
      throw new NapCatInstallError(`压缩包里有 .. 路径穿越条目，拒绝解压：${name}`, { stage: 'extract' })
    }
  }
  return true
}

/** 按资产名挑 release asset；想要的没有就退到另一个官方包 */
export function pickReleaseAsset(assets, wanted) {
  const list = Array.isArray(assets) ? assets.filter((asset) => asset && asset.name) : []
  const target = String(wanted || '')
  const exact = list.find((asset) => String(asset.name).toLowerCase() === target.toLowerCase())
  if (exact) return exact
  const fallbackName = /windows\.node/i.test(target) ? NAPCAT_ASSETS.shell : NAPCAT_ASSETS.node
  const fallback = list.find((asset) => String(asset.name).toLowerCase() === fallbackName.toLowerCase())
  if (fallback) return fallback
  throw new NapCatInstallError(`NapCat 发布包里没有 ${target || '任何官方包'}（可用：${list.map((asset) => asset.name).join('、') || '空'}）`, {
    stage: 'resolve',
    hint: 'NapCat 可能改了资产名；请升级插件，或用 assetUrl 手动指定下载地址',
  })
}

// ---------------------------------------------------------------------------
// NapCatProvisioner：探测 / 安装 / 启停
// ---------------------------------------------------------------------------

export class NapCatProvisioner {
  /**
   * @param {object} options
   * @param {object|Function} [options.log] 日志对象；默认 createLogger('[qq-fish/napcat]')
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   * @param {Function|string} [options.stateHome] 状态目录（默认 store.stateHome()；可传函数或字符串）
   * @param {Function} [options.execFileImpl] 注入 execFile（测试用）
   * @param {Function} [options.spawnImpl] 注入 spawn（测试用）
   * @param {string} [options.platform=process.platform] 测试用平台覆盖
   * @param {Function} [options.now=Date.now] 时钟
   * @param {string[]} [options.qqCommonPaths] 覆盖 Windows QQ 常见路径（测试用）
   */
  constructor(options = {}) {
    this.log = normalizeLog(options.log, '[qq-fish/napcat]')
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.execFileImpl = typeof options.execFileImpl === 'function' ? options.execFileImpl : execFile
    this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
    this.platform = String(options.platform || process.platform)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.qqCommonPaths = Array.isArray(options.qqCommonPaths) ? options.qqCommonPaths : null
    if (typeof options.stateHome === 'function') this.stateHomeFn = options.stateHome
    else if (typeof options.stateHome === 'string' && options.stateHome) this.stateHomeFn = () => options.stateHome
    else this.stateHomeFn = defaultStateHome

    /** 当前由本实例拉起的子进程（只结束它，不碰用户其它 QQ） */
    this.child = null
    this.childPid = 0
    this.startedAt = 0
    this.lastError = ''
    this.lastProgress = { stage: 'idle', stageKey: 'idle', percent: 0, message: '' }
    this._childExit = null
    this._logBuffer = ''
    this._logTail = []
    this._observedWebuiPort = 0
    this._observedQrUrl = ''
    this._startupHint = ''
    this._qqCache = null
    this._managedCache = null
    this._installJob = { state: 'idle', stage: '', percent: 0, log: '' }
  }

  /** 本插件状态目录（$DSH_HOME/qq-fish），保证存在 */
  home() {
    const dir = this.stateHomeFn()
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** NapCat 托管根目录（$DSH_HOME/qq-fish/napcat） */
  managedRoot() {
    return join(this.home(), 'napcat')
  }

  /** 托管清单（含 WebUI/OneBot 的端口与 token；token 不进日志） */
  manifestPath() {
    return join(this.home(), 'napcat.json')
  }

  /** 安装任务快照，给面板进度条用（stage 是中文 label） */
  installJobSnapshot() {
    const job = this._installJob || { state: 'idle', stage: '', percent: 0, log: '' }
    return { state: job.state, stage: job.stage, percent: job.percent, log: job.log }
  }

  _setInstallJob(state, stage, percent, message = '') {
    const job = this._installJob || { state: 'idle', stage: '', percent: 0, log: '' }
    job.state = state
    job.stage = stage
    if (Number.isFinite(Number(percent))) job.percent = Math.max(0, Math.min(100, Math.round(Number(percent))))
    if (message) {
      const line = `[${stage}] ${message}`
      job.log = job.log ? `${job.log}\n${line}` : line
      if (job.log.length > 4000) job.log = job.log.slice(-4000)
    }
    this._installJob = job
  }

  // ── 探测 QQ ────────────────────────────────────────────────────────────

  /**
   * 探测本机 QQ NT。
   * @returns {Promise<{installed:boolean,path:string,version:string,running:boolean|null,
   *   anyRunning:boolean,pathKnown:boolean,processesKnown:boolean,
   *   processes:Array<{pid:number,path:string}>,note:string,platform:string}>}
   */
  async detectQQ(options = {}) {
    const cached = this._qqCache
    // 面板 /state 会高频轮询：QQ 进程状态变化不频繁，缓存 30 秒，避免每轮都起 PowerShell（约 1.7s）
    if (options.force !== true && cached && this.now() - cached.at < 30_000) return cached.value
    let value
    try {
      value = this.platform === 'win32' ? await this._detectQQWindows() : await this._detectQQUnix()
    } catch (error) {
      value = {
        installed: false,
        path: '',
        version: '',
        running: null,
        anyRunning: false,
        pathKnown: false,
        processesKnown: false,
        processes: [],
        note: `探测 QQ 失败：${messageOf(error)}`,
        platform: this.platform,
      }
    }
    this._qqCache = { at: this.now(), value }
    return value
  }

  async _detectQQWindows() {
    const found = []
    const notes = []
    for (const key of QQ_REG_KEYS) {
      const { error, stdout } = await this._run('reg.exe', ['query', key], { timeoutMs: 8000 })
      if (error || !stdout) continue
      const values = parseRegValues(stdout)
      const candidate = qqExeFromRegistryValues(values)
      if (!candidate) continue
      if (!found.some((item) => samePath(item.path, candidate))) {
        found.push({
          path: candidate,
          version: String(values.DisplayVersion || '').trim(),
          source: key,
          installed: existsSync(candidate),
        })
      }
    }
    for (const candidate of this.qqCommonPaths || commonQQPathsWindows()) {
      if (!candidate || !existsSync(candidate)) continue
      if (found.some((item) => samePath(item.path, candidate))) continue
      found.push({ path: candidate, version: '', source: 'common-path', installed: true })
    }
    const chosen = found.find((item) => item.installed) || found[0] || null
    const processProbe = await this._probeQQProcessesWindows()
    let running = null
    let runningNote = ''
    if (processProbe.known) {
      if (!processProbe.processes.length) {
        running = false
      } else if (chosen && chosen.path) {
        running = processProbe.processes.some((process) => process.path && samePath(process.path, chosen.path))
        if (!running) runningNote = '有 QQ 在运行，但不是探测到的这个安装路径'
      } else {
        running = true
        runningNote = '没拿到 QQ 安装路径，只确认有 QQ 在跑'
      }
    } else if (processProbe.anyRunning) {
      runningNote = '拿不到 QQ.exe 的完整路径（WMI 不可用），只确认有 QQ 在跑'
    } else {
      runningNote = '没能确认 QQ 进程状态（WMI / tasklist 都不可用）'
    }
    if (!chosen) notes.push('注册表与常见路径都没找到 QQ NT')
    else if (!chosen.installed) notes.push(`注册表指向 ${chosen.path}，但文件不存在`)
    return {
      installed: Boolean(chosen && chosen.installed),
      path: chosen ? chosen.path : '',
      version: chosen ? chosen.version : '',
      running,
      anyRunning: processProbe.anyRunning,
      pathKnown: Boolean(chosen && chosen.path),
      processesKnown: processProbe.known,
      processes: processProbe.processes,
      note: [...notes, runningNote].filter(Boolean).join('；'),
      platform: 'win32',
    }
  }

  async _detectQQUnix() {
    const candidates = this.qqCommonPaths || (this.platform === 'darwin'
      ? ['/Applications/QQ.app/Contents/MacOS/QQ']
      : ['/opt/QQ/qq', '/opt/QQ/qq-bin', '/usr/bin/qq', '/usr/local/bin/qq'])
    const path = candidates.find((candidate) => candidate && existsSync(candidate)) || ''
    let anyRunning = false
    try {
      const probe = this.platform === 'darwin' ? ['-x', 'QQ'] : ['-f', '/opt/QQ']
      const { error, stdout } = await this._run('pgrep', probe, { timeoutMs: 5000 })
      anyRunning = !error && String(stdout || '').trim() !== ''
    } catch {
      anyRunning = false
    }
    return {
      installed: Boolean(path),
      path,
      version: '',
      running: null,
      anyRunning,
      pathKnown: Boolean(path),
      processesKnown: false,
      processes: [],
      note: 'macOS / Linux 只做只读探测；插件代管安装仅支持 Windows，请走「我已有 NapCat」进阶路径',
      platform: this.platform,
    }
  }

  async _probeQQProcessesWindows() {
    const script =
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
    const { error, stdout } = await this._run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeoutMs: 15_000 },
    )
    if (!error) {
      const parsed = parseCimProcessJson(stdout)
      if (parsed) return { known: true, processes: parsed, anyRunning: parsed.length > 0 }
    } else {
      this.log.warn(`PowerShell 查 QQ 进程失败，退回 tasklist：${String(messageOf(error)).slice(0, 120)}`)
    }
    const fallback = await this._tasklistQQ()
    return { known: false, processes: [], anyRunning: fallback.anyRunning }
  }

  async _tasklistQQ() {
    const { error, stdout } = await this._run('tasklist.exe', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 8000 })
    if (error) return { anyRunning: false }
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^"QQ\.exe"/i.test(line))
    return { anyRunning: lines.length > 0 }
  }

  // ── 探测托管 NapCat ────────────────────────────────────────────────────

  /**
   * 探测托管目录里的 NapCat（优先读 napcat.json 清单，其次扫 napcat/<版本>/）。
   * @param {object} [options] { force, dir } dir 可指定一个外部安装目录做只读探测
   */
  async detectManaged(options = {}) {
    const cached = this._managedCache
    if (options.force !== true && !options.dir && cached && this.now() - cached.at < 2000) return cached.value
    const manifest = this._readManifest()
    const candidates = []
    if (options.dir) candidates.push({ versionDir: '', dir: String(options.dir) })
    if (manifest && manifest.dir) candidates.push({ versionDir: String(manifest.versionDir || ''), dir: String(manifest.dir) })
    let versionDirs = []
    try {
      versionDirs = readdirSync(this.managedRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.managedRoot(), entry.name))
        .sort()
        .reverse()
    } catch {
      versionDirs = []
    }
    for (const versionDir of versionDirs) candidates.push({ versionDir, dir: '' })

    for (const candidate of candidates) {
      const resolved = this._resolveManagedCandidate(candidate)
      if (!resolved) continue
      const value = await this._describeManaged(resolved, manifest)
      this._managedCache = { at: this.now(), value }
      return value
    }
    const empty = {
      installed: false,
      dir: '',
      installDir: '',
      versionDir: '',
      version: '',
      managed: true,
      webuiPort: 0,
      webuiToken: '',
      webuiHost: '127.0.0.1',
      onebotPort: 0,
      onebotToken: '',
      onebotHost: '127.0.0.1',
      onebot: { host: '127.0.0.1', port: 0, token: '' },
      running: false,
      runningReason: '',
      markers: [],
      launcher: '',
      launcherPath: '',
      asset: '',
      assetKind: 'shell',
      warnings: [],
      configFiles: { webui: '', onebot: '' },
    }
    this._managedCache = { at: this.now(), value: empty }
    return empty
  }

  _resolveManagedCandidate(candidate) {
    const versionDir = String(candidate.versionDir || '')
    const dir = String(candidate.dir || '')
    if (dir && isNapcatDir(dir)) return { versionDir, dir }
    if (versionDir) {
      const located = locateNapcatDir(versionDir)
      if (located) return { versionDir, dir: located }
    }
    return null
  }

  async _describeManaged(resolved, manifest) {
    const dir = resolved.dir
    const versionDir = resolved.versionDir || ''
    const marker = versionDir ? readJson(join(versionDir, '.dsh-napcat.json'), null) : null
    const config = this._readNapcatConfig(dir, manifest || {})
    const runningInfo = await this._runningState(config.webuiPort)
    const launcher = pickLauncher(dir)
    const version = String(
      (marker && marker.version) || (manifest && manifest.version) || versionFromDirName(versionDir || dir) || '',
    )
    const asset = String((marker && marker.asset) || (manifest && manifest.asset) || '')
    const warnings = []
    if (config.webuiPort && !isLoopbackHost(config.webuiHost)) {
      warnings.push(`WebUI 监听在 ${config.webuiHost}，建议改成 127.0.0.1（暴露到局域网等于把配置面板交出去）`)
    }
    if (config.onebotPort && !isLoopbackHost(config.onebotHost)) {
      warnings.push(`OneBot WS 监听在 ${config.onebotHost}，建议改成 127.0.0.1`)
    }
    return {
      installed: true,
      dir,
      installDir: dir,
      versionDir,
      version,
      managed: isInside(this.managedRoot(), dir),
      webuiPort: config.webuiPort,
      webuiToken: config.webuiToken,
      webuiHost: config.webuiHost,
      onebotPort: config.onebotPort,
      onebotToken: config.onebotToken,
      onebotHost: config.onebotHost,
      onebot: { host: config.onebotHost, port: config.onebotPort, token: config.onebotToken },
      running: runningInfo.running,
      runningReason: runningInfo.reason,
      markers: napcatMarkers(dir),
      launcher: launcher ? launcher.name : '',
      launcherPath: launcher ? launcher.path : '',
      asset,
      assetKind: /windows\.node/i.test(asset) ? 'node' : 'shell',
      warnings,
      configFiles: config.files,
    }
  }

  /** 读 installDir/config 下的 WebUI 与 OneBot 配置（读不到就用清单兜底） */
  _readNapcatConfig(dir, manifest) {
    const configDir = join(dir, 'config')
    const files = { webui: join(configDir, 'webui.json'), onebot: join(configDir, 'onebot11.json') }
    const webui = readJson(files.webui, null)
    const onebotFiles = [join(configDir, 'onebot11.json')]
    try {
      for (const name of readdirSync(configDir)) {
        if (/^onebot11_\d+\.json$/.test(name)) onebotFiles.push(join(configDir, name))
      }
    } catch {
      // config 目录可能还不存在
    }
    let server = null
    for (const file of onebotFiles) {
      const config = readJson(file, null)
      const servers = config && config.network && config.network.websocketServers
      if (Array.isArray(servers) && servers.length > 0 && servers[0] && typeof servers[0] === 'object') {
        server = servers[0]
        files.onebot = file
        break
      }
    }
    const manifestWebui = (manifest && manifest.webui) || {}
    const manifestOnebot = (manifest && manifest.onebot) || {}
    const webuiPort = validPort(webui && webui.port) ? Number(webui.port) : validPort(manifestWebui.port) ? Number(manifestWebui.port) : 0
    const webuiToken = validToken(webui && webui.token)
      ? String(webui.token).trim()
      : validToken(manifestWebui.token)
        ? String(manifestWebui.token).trim()
        : ''
    const onebotPort = validPort(server && server.port) ? Number(server.port) : validPort(manifestOnebot.port) ? Number(manifestOnebot.port) : 0
    const onebotToken = validToken(server && server.token)
      ? String(server.token).trim()
      : validToken(manifestOnebot.token)
        ? String(manifestOnebot.token).trim()
        : ''
    return {
      webuiPort,
      webuiToken,
      webuiHost: String((webui && webui.host) || manifestWebui.host || '127.0.0.1'),
      onebotPort,
      onebotToken,
      onebotHost: String((server && server.host) || manifestOnebot.host || '127.0.0.1'),
      files,
    }
  }

  async _runningState(webuiPort) {
    if (this.child && this.child.exitCode === null) return { running: true, reason: '插件拉起的进程在跑' }
    if (validPort(webuiPort) && (await isPortOpen(webuiPort, { timeoutMs: 500 }))) {
      return { running: true, reason: 'WebUI 端口有响应（可能是上次拉起的 NapCat）' }
    }
    return { running: false, reason: validPort(webuiPort) ? '' : '还没配置 WebUI 端口' }
  }

  _readManifest() {
    const value = readJson(this.manifestPath(), null)
    return value && typeof value === 'object' ? value : null
  }

  _writeManifest(value) {
    const file = this.manifestPath()
    writeJsonAtomic(file, value)
    chmodBestEffort(file, 0o600)
    return file
  }

  _updateManifest(patch) {
    const current = this._readManifest() || {}
    const next = { ...current, ...patch }
    if (patch && patch.webui) next.webui = { ...(current.webui || {}), ...patch.webui }
    if (patch && patch.onebot) next.onebot = { ...(current.onebot || {}), ...patch.onebot }
    this._managedCache = null
    return this._writeManifest(next)
  }

  // ── 组合探测 ───────────────────────────────────────────────────────────

  /**
   * 一次拿到面板要的全部托管信息。
   * @returns {Promise<{qq:object,napcat:object,mode:'managed'|'none',installJob:object,lastError:string}>}
   */
  async detect(options = {}) {
    const [qq, napcat] = await Promise.all([this.detectQQ(options), this.detectManaged(options)])
    return {
      qq,
      napcat: { ...napcat, lastError: this.lastError },
      mode: napcat.installed ? 'managed' : 'none',
      installJob: this.installJobSnapshot(),
      lastError: this.lastError,
    }
  }

  /**
   * 面板状态（扁平结构）。webuiToken/onebotToken 是明文，给 Host 自己用；
   * 出面板前请套一层 maskProvisionStatus()。
   */
  async status(options = {}) {
    const [qq, napcat] = await Promise.all([this.detectQQ(options), this.detectManaged(options)])
    return {
      installed: napcat.installed,
      running: napcat.running,
      runningReason: napcat.runningReason,
      version: napcat.version,
      dir: napcat.dir,
      installDir: napcat.installDir,
      versionDir: napcat.versionDir,
      managed: napcat.managed,
      webuiPort: napcat.webuiPort,
      webuiHost: napcat.webuiHost,
      webuiToken: napcat.webuiToken,
      onebotPort: napcat.onebotPort,
      onebotHost: napcat.onebotHost,
      onebotToken: napcat.onebotToken,
      onebot: napcat.onebot,
      asset: napcat.asset,
      assetKind: napcat.assetKind,
      launcher: napcat.launcher,
      pid: this.childPid || 0,
      mode: napcat.installed ? 'managed' : 'none',
      qq: { installed: qq.installed, path: qq.path, running: qq.running, version: qq.version },
      lastError: this.lastError,
      installJob: this.installJobSnapshot(),
      warnings: napcat.warnings || [],
    }
  }

  // ── 安装 ───────────────────────────────────────────────────────────────

  /**
   * 下载并安装 NapCat（仅 Windows）。
   * @param {object} [options]
   * @param {Function} [options.onProgress] ({stage,stageKey,percent,message}) => void
   * @param {Function} [options.fetchImpl] 注入 fetch
   * @param {string} [options.mirrorBase] GitHub 代理前缀（见 resolveDownloadUrl）
   * @param {string} [options.asset] 强制资产名（默认有 QQ 用 Shell、没 QQ 用 Windows.Node）
   * @param {string} [options.assetUrl] 直接用这个下载地址（跳过 release 查询）
   * @param {object} [options.release] 注入 release JSON（测试用）
   * @param {boolean} [options.force] 已装也重装 / 覆盖
   * @param {boolean} [options.checkUpdate] 已装也去查最新版，版本不同则升级
   * @param {number} [options.webuiPortStart] WebUI 端口起点
   * @param {number} [options.onebotPortStart] OneBot WS 端口起点
   * @returns {Promise<object>} {...detectManaged(), ok:true}
   */
  async install(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
    const fetchImpl = options.fetchImpl || this.fetchImpl
    const startTime = this.now()
    this.lastError = ''
    this._installJob = { state: 'running', stage: STAGE_LABELS.detect, percent: 0, log: '' }
    let downloadUrl = ''
    let versionDir = ''

    // stage 给面板看（中文），stageKey 给程序判断；message 是详细人话
    const progress = (stageKey, percent, message = '') => {
      const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      const stage = STAGE_LABELS[stageKey] || stageKey
      this.lastProgress = { stage, stageKey, percent: safePercent, message }
      this._setInstallJob('running', stage, safePercent, message)
      if (message) this.log.info(`[安装 ${stage} ${safePercent}%] ${message}`)
      if (onProgress) {
        try {
          onProgress({ stage, stageKey, percent: safePercent, message })
        } catch {
          // 进度回调出错不影响安装
        }
      }
    }

    try {
      if (this.platform !== 'win32') {
        throw new NapCatInstallError(
          '自动安装只支持 Windows。macOS / Linux 请自己安装 NapCat，再用面板的「我已有 NapCat」进阶路径填 WebUI 地址',
          { stage: 'platform' },
        )
      }
      if (typeof fetchImpl !== 'function') {
        throw new NapCatInstallError('当前 Node 环境没有 fetch，无法下载 NapCat', { stage: 'prepare' })
      }

      progress('detect', 2, '正在检查本机 QQ…')
      const qq = await this.detectQQ({ force: true })
      progress('detect', 4, qq.installed ? `检测到 QQ：${qq.path}` : '本机没检测到 QQ，将下载自带 QQ 的完整包（约 118 MB）')

      // 已经装过：默认直接复用（不联网、不烧 GitHub API 限流）；
      // 想升级就传 checkUpdate:true，让下面去查最新 release 对比版本。
      const existing = await this.detectManaged({ force: true })
      if (existing.installed && options.force !== true && options.checkUpdate !== true) {
        progress('done', 100, `已经装过 NapCat ${existing.version || ''}，直接复用`)
        this._setInstallJob('done', STAGE_LABELS.done, 100, '已安装，跳过下载')
        return { ok: true, alreadyInstalled: true, dir: existing.dir, version: existing.version, ...existing }
      }

      let release = null
      let assetName = ''
      let expectedSize = 0
      let version = ''
      if (options.assetUrl) {
        downloadUrl = String(options.assetUrl)
        assetName = String(options.assetName || basename(new URL(downloadUrl).pathname) || 'NapCat.zip')
        expectedSize = Number(options.assetSize) || 0
        version = String(options.version || `manual-${formatDateStamp(startTime)}`)
      } else {
        progress('resolve', 5, '正在获取 NapCat 最新版本（GitHub Releases）…')
        release = options.release ? normalizeRelease(options.release) : await this._fetchRelease({ fetchImpl, signal: options.signal })
        const wanted = String(options.asset || (qq.installed ? NAPCAT_ASSETS.shell : NAPCAT_ASSETS.node))
        const picked = pickReleaseAsset(release.assets, wanted)
        assetName = String(picked.name)
        expectedSize = Number(picked.size) || 0
        downloadUrl = options.mirrorBase
          ? resolveDownloadUrl({ mirrorBase: options.mirrorBase, tag: release.tag, assetName })
          : String(picked.browser_download_url || picked.url || '')
        if (!downloadUrl) throw new NapCatInstallError(`发布包里的 ${assetName} 没有下载地址`, { stage: 'resolve' })
        version = release.version
        progress(
          'resolve',
          8,
          `准备安装 NapCat ${release.tag}：${assetName}${expectedSize ? `（约 ${(expectedSize / 1048576).toFixed(1)} MB）` : ''}`,
        )
      }

      if (!assetName) throw new NapCatInstallError('没能确定要下载的安装包', { stage: 'resolve' })
      versionDir = join(this.managedRoot(), safeVersionDirName(version))
      assertInside(this.managedRoot(), versionDir)
      progress('prepare', 9, `安装目录：${versionDir}`)

      if (existing.installed && options.force !== true) {
        const sameVersion = !version || !existing.version || existing.version === version
        if (sameVersion) {
          progress('done', 100, `已经装过 NapCat ${existing.version || ''}，直接复用`)
          this._setInstallJob('done', STAGE_LABELS.done, 100, '已安装，跳过下载')
          return { ok: true, alreadyInstalled: true, dir: existing.dir, version: existing.version, ...existing }
        }
        progress('prepare', 10, `检测到旧版本 ${existing.version}，将安装 ${version}（旧目录保留可回滚）`)
      }
      mkdirSync(this.managedRoot(), { recursive: true })
      if (existsSync(versionDir)) {
        rmSync(versionDir, { recursive: true, force: true })
        if (existsSync(versionDir)) {
          throw new NapCatInstallError(`清理旧安装目录失败：${versionDir}（可能被占用或被杀软锁定）`, {
            stage: 'prepare',
            targetDir: versionDir,
          })
        }
      }
      mkdirSync(versionDir, { recursive: true })

      // ---- 下载 ----
      const zipPath = join(versionDir, assetName)
      const tmpPath = `${zipPath}.part`
      progress('download', 10, `开始下载 ${assetName}${expectedSize ? `（${(expectedSize / 1048576).toFixed(1)} MB）` : ''}…`)
      const downloaded = await this._downloadToFile(downloadUrl, tmpPath, {
        fetchImpl,
        expectedSize,
        signal: options.signal,
        onProgress: (received, total) => {
          const size = total || expectedSize || 0
          const percent = size ? 10 + (received / size) * 50 : 20
          progress('download', percent, `已下载 ${(received / 1048576).toFixed(1)}${size ? ` / ${(size / 1048576).toFixed(1)}` : ''} MB`)
        },
      })
      const zipBytes = statSync(tmpPath).size
      if (zipBytes < 1024 * 1024) {
        throw new NapCatInstallError(`下载到的文件只有 ${zipBytes} 字节，不像 NapCat 安装包（可能被代理/登录页拦截）`, {
          stage: 'download',
          url: downloadUrl,
          targetDir: tmpPath,
          hint: '换镜像或检查网络；也可手动下载后用 assetUrl 指定下载地址',
        })
      }
      validateZipMagic(tmpPath)
      renameSync(tmpPath, zipPath)
      progress('download', 62, `下载完成（${(downloaded.bytes / 1048576).toFixed(1)} MB）`)

      // ---- 解压 ----
      progress('extract', 64, '正在校验压缩包并解压（优先系统自带 tar）…')
      const entries = await this._listZipEntries(zipPath)
      if (entries) {
        validateZipEntryNames(entries)
        progress('extract', 68, `压缩包 ${entries.length} 个条目，路径校验通过`)
      } else {
        this.log.warn('系统 tar 不可用，跳过压缩包条目预检，改用 PowerShell Expand-Archive')
      }
      const extracted = await this._extractZip(zipPath, versionDir)
      progress('extract', 86, `已解压（${extracted.method === 'tar' ? '系统 tar' : 'PowerShell Expand-Archive'}）`)
      const installDir = locateNapcatDir(versionDir)
      if (!installDir) {
        throw new NapCatInstallError('解压完成，但目录里没找到 NapCat 的启动文件（launcher*.bat / napcat.mjs）', {
          stage: 'extract',
          targetDir: versionDir,
          hint: '可能被杀软拦截/隔离，或发布包结构变了；检查 Windows Defender 隔离区，或手动解压后把目录放进托管目录',
        })
      }
      if (options.keepZip !== true) {
        try {
          rmSync(zipPath, { force: true })
        } catch {}
      }

      // ---- 写配置 ----
      progress('configure', 90, '正在写 WebUI / OneBot 11 配置（只绑 127.0.0.1）…')
      const tokens = await ensureNapcatTokens(installDir, {
        webuiPortStart: options.webuiPortStart,
        onebotPortStart: options.onebotPortStart,
      })
      const installedAt = this.now()
      const manifest = {
        version,
        tag: release ? release.tag : '',
        dir: installDir,
        versionDir,
        asset: assetName,
        source: { url: downloadUrl, mirror: options.mirrorBase || '', releaseApi: release ? NAPCAT_RELEASE_API : '' },
        installedAt,
        // nested + 平铺两套字段：nested 给本模块，平铺给 bridge/面板直读
        webui: { host: tokens.webui.host, port: tokens.webui.port, token: tokens.webui.token },
        onebot: { host: tokens.onebot.host, port: tokens.onebot.port, token: tokens.onebot.token },
        webuiHost: tokens.webui.host,
        webuiPort: tokens.webui.port,
        webuiToken: tokens.webui.token,
        onebotHost: tokens.onebot.host,
        onebotPort: tokens.onebot.port,
        onebotToken: tokens.onebot.token,
        qq: { path: qq.path || '' },
        lastStartedAt: 0,
      }
      this._writeManifest(manifest)
      // 版本标记：detectManaged 在清单丢失时靠它认版本/资产
      writeJsonAtomic(join(versionDir, '.dsh-napcat.json'), {
        version,
        dir: installDir,
        asset: assetName,
        assetKind: /windows\.node/i.test(assetName) ? 'node' : 'shell',
        installedAt,
        source: manifest.source,
      })
      progress('configure', 96, `WebUI 端口 ${tokens.webui.port}，OneBot WS 端口 ${tokens.onebot.port}`)
      progress('done', 100, 'NapCat 已装好：接着点「启动」，等二维码出来扫码')
      this._setInstallJob('done', STAGE_LABELS.done, 100, '安装完成')
      this._managedCache = null
      const detected = await this.detectManaged({ force: true })
      return {
        ok: true,
        installed: true,
        alreadyInstalled: false,
        dir: installDir,
        version,
        tag: release ? release.tag : '',
        manifest,
        webui: tokens.webui,
        onebot: tokens.onebot,
        elapsedMs: this.now() - startTime,
        ...detected,
      }
    } catch (error) {
      const failure = error instanceof NapCatInstallError
        ? error
        : new NapCatInstallError(`安装 NapCat 失败：${messageOf(error)}`, {
            stage: (this.lastProgress && this.lastProgress.stageKey) || 'unknown',
            cause: error,
          })
      const diagnostics = {
        at: this.now(),
        stage: failure.stage || (this.lastProgress && this.lastProgress.stageKey) || 'unknown',
        message: failure.message,
        httpStatus: failure.httpStatus || 0,
        url: failure.url || downloadUrl || '',
        targetDir: failure.targetDir || versionDir || '',
        hint:
          failure.hint ||
          '检查网络 / GitHub 可达性、磁盘空间（34MB~118MB）与杀软隔离区；详细日志已写进本文件（napcat-install-error.json）',
      }
      failure.diagnostics = diagnostics
      this.lastError = failure.message
      try {
        writeJsonAtomic(join(this.home(), 'napcat-install-error.json'), diagnostics)
      } catch {}
      this._setInstallJob('failed', '安装失败', this._installJob ? this._installJob.percent : 0, failure.message)
      this.log.error(`安装失败（${diagnostics.stage}）：${failure.message}`)
      throw failure
    }
  }

  /** 拉 GitHub Releases 最新版元数据 */
  async _fetchRelease({ fetchImpl, signal } = {}) {
    const fn = fetchImpl || this.fetchImpl
    if (typeof fn !== 'function') throw new NapCatInstallError('当前环境没有 fetch', { stage: 'resolve' })
    const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined
    const combined =
      signal && timeoutSignal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, timeoutSignal])
        : signal || timeoutSignal
    let response
    try {
      response = await fn(NAPCAT_RELEASE_API, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-dafeiyu-home' },
        redirect: 'follow',
        signal: combined,
      })
    } catch (error) {
      throw new NapCatInstallError('连不上 GitHub Releases 接口（api.github.com）：检查网络/代理是否可达 GitHub', {
        stage: 'resolve',
        url: NAPCAT_RELEASE_API,
        detail: messageOf(error),
        hint: '国内网络常需镜像；也可以手动下载 NapCat 包解压到托管目录后重试',
      })
    }
    if (!response || !response.ok) {
      const status = response ? Number(response.status) || 0 : 0
      // GitHub API 未登录限额 60 次/小时，共用出口 IP 很容易 403；
      // API 被限流不一定要让用户干等：退回 releases/latest 的 HTML 跳转拿 tag，再拼官方资产 URL。
      if (status === 403 || status === 429) {
        try {
          const fallback = await this._fetchReleaseFallback({ fetchImpl: fn, signal: combined })
          if (fallback) {
            this.log.warn('GitHub API 限流，已改用 releases/latest 跳转解析 NapCat 版本')
            return fallback
          }
        } catch (error) {
          this.log.warn('releases/latest 兜底解析失败：' + messageOf(error))
        }
      }
      let detail = ''
      try {
        detail = String(await response.text()).slice(0, 200)
      } catch {}
      throw new NapCatInstallError(`获取 NapCat 最新版本失败：HTTP ${status}`, {
        stage: 'resolve',
        httpStatus: status,
        url: NAPCAT_RELEASE_API,
        detail,
        hint:
          status === 403
            ? 'GitHub API 限流（未登录每小时 60 次）；可稍后重试，或手动下载 NapCat 包走「我已有 NapCat」'
            : '检查网络 / 代理设置',
      })
    }
    let release
    try {
      release = await response.json()
    } catch (error) {
      throw new NapCatInstallError('GitHub Releases 返回的不是 JSON', {
        stage: 'resolve',
        url: NAPCAT_RELEASE_API,
        detail: messageOf(error),
      })
    }
    return normalizeRelease(release)
  }

  /**
   * GitHub API 403/429 时的兜底：访问 releases/latest 页面，跟随 302 得到 /releases/tag/<tag>，
   * 再用官方资产名拼下载 URL（不需要 API 配额）。只解析 tag，不抓 HTML 内容。
   */
  async _fetchReleaseFallback({ fetchImpl, signal } = {}) {
    const fn = fetchImpl || this.fetchImpl
    if (typeof fn !== 'function') throw new NapCatInstallError('当前环境没有 fetch', { stage: 'resolve' })
    const pageUrl = 'https://github.com/NapNeko/NapCatQQ/releases/latest'
    const response = await fn(pageUrl, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-dafeiyu-home' },
      redirect: 'follow',
      signal,
    })
    if (!response || !response.ok) throw new NapCatInstallError(`releases/latest 返回 HTTP ${response ? response.status : 0}`, { stage: 'resolve' })
    const finalUrl = String(response.url || '')
    const match = finalUrl.match(/\/releases\/tag\/([^/?#]+)/)
    if (!match) throw new NapCatInstallError('releases/latest 没有跳到 tag 页', { stage: 'resolve' })
    const tag = decodeURIComponent(match[1])
    const assets = Object.values(NAPCAT_ASSETS).map((assetName) => ({
      name: assetName,
      size: 0,
      browser_download_url: `https://github.com/NapNeko/NapCatQQ/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`,
    }))
    return normalizeRelease({ tag_name: tag, html_url: `https://github.com/NapNeko/NapCatQQ/releases/tag/${tag}`, assets })
  }

  /** 下载到本地文件（流式；进度回调用「已收到字节 / 总字节」） */
  async _downloadToFile(url, destFile, options = {}) {
    const fetchImpl = options.fetchImpl || this.fetchImpl
    if (typeof fetchImpl !== 'function') throw new NapCatInstallError('当前环境没有 fetch', { stage: 'download' })
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30 * 60 * 1000
    // 卡住判定：连续 stallMs 收不到任何字节就中止，让上层换镜像；避免慢源把 30 分钟耗光。
    const stallMs = Number(options.stallMs) > 0 ? Number(options.stallMs) : 20_000
    const controller = new AbortController()
    let stalled = false
    const timer = setTimeout(() => {
      try {
        controller.abort()
      } catch {}
    }, timeoutMs)
    let stallTimer = null
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        try {
          controller.abort()
        } catch {}
      }, stallMs)
    }
    const signals = [controller.signal]
    if (options.signal) signals.push(options.signal)
    const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : controller.signal
    const report = (received, total) => {
      if (typeof options.onProgress !== 'function') return
      try {
        options.onProgress(received, total)
      } catch {}
    }
    try {
      let response
      try {
        resetStallTimer()
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-dafeiyu-home' },
          redirect: 'follow',
          signal,
        })
      } catch (error) {
        clearTimeout(stallTimer)
        throw new NapCatInstallError(
          stalled
            ? `下载地址 ${Math.round(stallMs / 1000)} 秒没有响应，已自动中止`
            : `下载失败：连不上下载地址（${url}）`,
          {
            stage: 'download',
            url,
            detail: messageOf(error),
            hint: stalled ? '正在自动换下一个下载源；也可以手动下载后走「我已有 NapCat」' : '检查网络 / 代理；国内直连 GitHub Releases 常常很慢或不通，建议用 mirrorBase 镜像',
          },
        )
      }
      if (!response || !response.ok) {
        clearTimeout(stallTimer)
        const status = response ? Number(response.status) || 0 : 0
        let detail = ''
        try {
          detail = String(await response.text()).slice(0, 200)
        } catch {}
        throw new NapCatInstallError(`下载失败：HTTP ${status}${response && response.statusText ? ` ${response.statusText}` : ''}`, {
          stage: 'download',
          httpStatus: status,
          url,
          detail,
          hint: '下载源不可用/被拦截；换 mirrorBase 镜像，或手动下载后用 assetUrl 指定',
        })
      }
      const headerTotal =
        Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : 0) || 0
      const total = headerTotal || Number(options.expectedSize) || 0
      if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer())
        clearTimeout(stallTimer)
        writeFileSync(destFile, buffer)
        report(buffer.length, total || buffer.length)
        return { bytes: buffer.length, total: total || buffer.length }
      }
      const out = createWriteStream(destFile)
      let received = 0
      let lastReported = 0
      try {
        for await (const chunk of Readable.fromWeb(response.body)) {
          resetStallTimer()
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += buffer.length
          if (!out.write(buffer)) await once(out, 'drain')
          if (received - lastReported >= 1.5 * 1024 * 1024) {
            lastReported = received
            report(received, total)
          }
        }
        out.end()
        await finished(out)
      } catch (error) {
        try {
          out.destroy()
        } catch {}
        try {
          rmSync(destFile, { force: true })
        } catch {}
        throw new NapCatInstallError(
          stalled
            ? `下载卡住 ${Math.round(stallMs / 1000)} 秒没有进度，已自动中止（可换镜像重试）`
            : `下载中断（已收到 ${(received / 1048576).toFixed(1)} MB）：${messageOf(error)}`,
          {
            stage: 'download',
            url,
            hint: stalled ? '已自动中止，正在尝试下一个下载源；也可以手动下载后用 assetUrl 指定' : '网络不稳定或被代理打断，重试一次通常就好了',
          },
        )
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
      }
      report(received, total || received)
      return { bytes: received, total: total || received }
    } finally {
      clearTimeout(timer)
      if (stallTimer) clearTimeout(stallTimer)
    }
  }

  _tarCommand() {
    return this.platform === 'win32' ? 'tar.exe' : 'tar'
  }

  /** 列出 zip 条目做路径穿越预检；系统没有 tar 返回 null（改用 PowerShell 解压） */
  async _listZipEntries(zipPath) {
    const tar = this._tarCommand()
    const { error, stdout } = await this._run(tar, ['-tf', zipPath], { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 })
    if (error) {
      this.log.warn(`tar -tf 预检失败（忽略）：${String(messageOf(error)).slice(0, 120)}`)
      return null
    }
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  /** 解压 zip：系统 tar.exe（Win10+ 自带 bsdtar）优先，失败再用 PowerShell Expand-Archive */
  async _extractZip(zipPath, destDir) {
    const tar = this._tarCommand()
    const tarResult = await this._run(tar, ['-xf', zipPath, '-C', destDir], { timeoutMs: 300_000 })
    if (!tarResult.error) return { method: 'tar' }
    this.log.warn(`系统 tar 解压失败，改用 PowerShell Expand-Archive：${String(tarResult.stderr || messageOf(tarResult.error)).slice(0, 200)}`)
    if (this.platform !== 'win32') {
      throw new NapCatInstallError('解压失败：系统里没有可用的 tar', {
        stage: 'extract',
        targetDir: destDir,
        detail: String(tarResult.stderr || messageOf(tarResult.error)).slice(0, 500),
      })
    }
    const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${escapePowerShell(zipPath)}' -DestinationPath '${escapePowerShell(destDir)}' -Force`
    const psResult = await this._run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeoutMs: 300_000 },
    )
    if (psResult.error) {
      throw new NapCatInstallError('解压失败：系统 tar 与 PowerShell Expand-Archive 都没成功', {
        stage: 'extract',
        targetDir: destDir,
        detail: String(psResult.stderr || messageOf(psResult.error)).slice(0, 500),
        hint: '检查磁盘剩余空间、Windows Defender 隔离区；也可以手动解压 zip 后放到该目录',
      })
    }
    return { method: 'powershell' }
  }

  // ── 启动 / 停止 ────────────────────────────────────────────────────────

  /**
   * 启动托管 NapCat（内部最多等 waitMs 让 WebUI 端口就绪）。
   * @param {object} [options]
   * @param {string} [options.uin] 快速登录的 QQ 号（可选，转成 launcher 的 `-q <uin>`）
   * @param {number} [options.waitMs=90000] 等 WebUI 端口就绪的上限
   * @param {boolean} [options.allowQqRunning] 用户已确认「QQ 可以先开着」时跳过 needsQqStop 拦截
   * @param {boolean} [options.preferUserLauncher=true] 优先免 UAC 的 launcher-user.bat
   * @returns {Promise<object>} {ok, pid?, webuiPort?, needsUac?, needsQqStop?, error?, hint?, logTail?}
   */
  async start(options = {}) {
    this.lastError = ''
    this._childExit = null
    this._startupHint = ''
    this._childWarnCount = 0
    this._observedWebuiPort = 0
    if (this.platform !== 'win32') {
      return {
        ok: false,
        error: '托管启动只支持 Windows：macOS / Linux 请自己启动 NapCat，再用「我已有 NapCat」进阶路径填 WebUI 地址',
      }
    }
    const managed = await this.detectManaged({ force: true })
    if (!managed.installed) {
      return { ok: false, needsInstall: true, error: '还没安装 NapCat，先点「安装 NapCat」' }
    }
    const dir = managed.installDir || managed.dir
    let launcher = pickLauncher(dir)
    if (!launcher) {
      return { ok: false, error: 'NapCat 目录里找不到 launcher-user.bat / launcher.bat，安装可能不完整；建议重新安装', dir }
    }
    if (options.preferUserLauncher === false) {
      const normal = LAUNCHER_ORDER.map((name) => ({ name, path: join(dir, name) })).find(
        (item) => !/user/i.test(item.name) && existsSync(item.path),
      )
      if (normal) launcher = { name: normal.name, path: normal.path, needsUac: true }
    }

    const qq = await this.detectQQ({ force: true })
    // Shell 包复用本机 QQ：同账号不能同时登录桌面 QQ 与 NapCat，需要用户先退出 QQ。
    // Node 包自带 QQ，不受本机 QQ 影响。
    if (managed.assetKind !== 'node' && qq.running === true && options.allowQqRunning !== true) {
      return {
        ok: false,
        needsQqStop: true,
        qq,
        launcher: basename(launcher.path),
        error: '让 NapCat 接管账号前，需要先退出正在运行的 QQ（同一个号不能同时登录桌面 QQ 和 NapCat）',
        hint: '面板上点「关闭 QQ 并继续」（只关这个安装路径下的 QQ），或自己退出 QQ 后重试；插件不会偷偷杀 QQ',
      }
    }

    if (this.child && this.child.exitCode === null) {
      return {
        ok: true,
        alreadyRunning: true,
        pid: this.childPid || this.child.pid,
        webuiPort: managed.webuiPort,
        launcher: basename(launcher.path),
        launcherNeedsUac: launcher.needsUac,
        needsUac: false,
      }
    }

    // 配置缺失（例如用户手动解压的包）先补一份，保证 WebUI 端口/token 可控
    let webuiPort = validPort(managed.webuiPort) ? managed.webuiPort : 0
    let webuiToken = String(managed.webuiToken || '')
    let onebotPort = validPort(managed.onebotPort) ? managed.onebotPort : 0
    let onebotToken = String(managed.onebotToken || '')
    if (!webuiPort || !webuiToken) {
      const tokens = await ensureNapcatTokens(dir, {
        webuiPortStart: options.webuiPortStart,
        onebotPortStart: options.onebotPortStart,
      })
      webuiPort = tokens.webui.port
      webuiToken = tokens.webui.token
      onebotPort = tokens.onebot.port
      onebotToken = tokens.onebot.token
      this._updateManifest({
        version: managed.version,
        dir,
        versionDir: managed.versionDir,
        webui: { host: tokens.webui.host, port: tokens.webui.port, token: tokens.webui.token },
        onebot: { host: tokens.onebot.host, port: tokens.onebot.port, token: tokens.onebot.token },
        webuiPort: tokens.webui.port,
        webuiToken: tokens.webui.token,
        onebotPort: tokens.onebot.port,
        onebotToken: tokens.onebot.token,
      })
    }

    const env = {
      ...process.env,
      // 用环境变量指定 token/端口，比改用户的 webui.json 更稳（NapCat 启动时会写回配置）
      NAPCAT_WEBUI_SECRET_KEY: webuiToken,
      NAPCAT_WEBUI_PREFERRED_PORT: String(webuiPort),
    }
    const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    // .bat 在 Windows 上必须经 cmd 执行；用 spawn 参数数组 + `call`，不自己拼命令行
    const command = ['/d', '/s', '/c', 'call', launcher.path]
    const uin = String(options.uin || '').replace(/\D/g, '')
    if (uin) command.push('-q', uin)
    let child
    try {
      child = this.spawnImpl(comspec, command, {
        cwd: dir,
        env,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const message = `启动 NapCat 失败：${messageOf(error)}`
      this.lastError = message
      return { ok: false, error: message, launcher: basename(launcher.path), needsUac: launcher.needsUac }
    }
    this.child = child
    this.childPid = Number(child.pid) || 0
    this.startedAt = this.now()
    this._attachChildLog(child)
    child.once('error', (error) => {
      this.lastError = `NapCat 进程出错：${messageOf(error)}`
      this.log.error(this.lastError)
    })
    child.once('exit', (code, signal) => {
      this._childExit = { code, signal, at: this.now() }
      if (code !== 0 && code !== null) this.log.warn(`NapCat 启动器退出（code=${code}）`)
      else this.log.info(`NapCat 启动器进程结束（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`)
    })
    this.log.info(`已拉起 NapCat 启动器：${basename(launcher.path)}（pid=${this.childPid}，目录 ${dir}）`)

    // 等 WebUI 端口就绪：优先配置端口；launcher 日志里报的实际端口（可能 +1）也认
    const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 90_000
    const deadline = this.now() + waitMs
    let actualPort = webuiPort
    let ready = false
    while (this.now() < deadline) {
      if (webuiPort && (await isPortOpen(webuiPort, { timeoutMs: 500 }))) {
        ready = true
        actualPort = webuiPort
        break
      }
      if (this._observedWebuiPort && this._observedWebuiPort !== webuiPort) {
        if (await isPortOpen(this._observedWebuiPort, { timeoutMs: 500 })) {
          ready = true
          actualPort = this._observedWebuiPort
          break
        }
      }
      await sleep(800)
    }
    if (!ready) {
      const hint = this._startupHint || (this._childExit ? `启动器已退出（退出码 ${this._childExit.code}）` : '')
      const message = hint
        ? `NapCat 启动失败：${hint}`
        : `等了 ${Math.round(waitMs / 1000)} 秒，NapCat WebUI 端口 ${webuiPort} 还没就绪`
      this.lastError = message
      return {
        ok: false,
        error: message,
        hint: launcher.needsUac ? '试着用管理员权限运行（普通版 launcher.bat 会弹 UAC）' : hint,
        needsUac: launcher.needsUac,
        webuiPort,
        pid: this.childPid,
        logTail: this._logTail.slice(-20),
      }
    }
    // 启动成功：把版本/目录/端口/token 补进清单（手动解压的包也会有一份完整清单）
    this._updateManifest({
      version: managed.version,
      dir,
      versionDir: managed.versionDir,
      webui: { host: '127.0.0.1', port: actualPort, token: webuiToken },
      onebot: { host: '127.0.0.1', port: onebotPort, token: onebotToken },
      webuiHost: '127.0.0.1',
      webuiPort: actualPort,
      webuiToken,
      onebotHost: '127.0.0.1',
      onebotPort,
      onebotToken,
      lastStartedAt: this.now(),
    })
    this._managedCache = null
    return {
      ok: true,
      pid: this.childPid,
      webuiPort: actualPort,
      onebotPort,
      launcher: basename(launcher.path),
      launcherNeedsUac: launcher.needsUac,
      needsUac: false,
      ready: true,
      logTail: this._logTail.slice(-10),
    }
  }

  /** 把启动器 stdout/stderr 按行接住：抓 WebUI 实际端口、二维码 URL、常见启动错误 */
  _attachChildLog(child) {
    const handle = (chunk) => {
      this._logBuffer += String(chunk || '')
      if (this._logBuffer.length > 40_000) this._logBuffer = this._logBuffer.slice(-20_000)
      const lines = this._logBuffer.split(/\r?\n/)
      this._logBuffer = lines.pop() || ''
      for (const line of lines) this._handleLauncherLine(line)
    }
    try {
      child.stdout?.on('data', handle)
      child.stderr?.on('data', handle)
    } catch {}
  }

  _handleLauncherLine(line) {
    const raw = String(line || '')
    if (!raw.trim()) return
    // 日志尾巴给面板排障用：先脱敏（token=... 会被替换成 ***）
    const safe = scrubLogLine(raw.trim())
    this._logTail.push(safe)
    if (this._logTail.length > 60) this._logTail.shift()
    const webuiMatch = /WebUi User Panel Url:\s*(https?:\/\/\S+)/i.exec(raw)
    if (webuiMatch) {
      try {
        const url = new URL(webuiMatch[1])
        if (url.port) this._observedWebuiPort = Number(url.port)
      } catch {}
      this.log.info('NapCat WebUI 已就绪')
      return
    }
    if (/二维码解码URL[:：]/.test(raw)) {
      // 只记内存，不记日志（URL 里带登录票据）
      this._observedQrUrl = raw.replace(/^.*二维码解码URL[:：]\s*/, '').trim()
      this.log.info('NapCat 已生成登录二维码')
      return
    }
    if (/administrator mode detected/i.test(raw)) return
    if (/QQ installation was not found/i.test(raw)) {
      this._startupHint = '启动器在注册表里没找到 QQ：请确认本机装了 QQ NT（或用自带 QQ 的 Windows.Node 包）'
      this.log.warn(this._startupHint)
      return
    }
    if (/provided QQ path is invalid/i.test(raw)) {
      this._startupHint = '启动器读到的 QQ 路径无效：QQ 可能装在非默认位置或已卸载'
      this.log.warn(this._startupHint)
      return
    }
    if (/access is denied|拒绝访问|elevat|管理员权限|请求的操作需要提升/i.test(raw)) {
      this._startupHint = '启动器需要管理员权限（UAC）：请用普通版 launcher.bat 并允许提权'
      this.log.warn(this._startupHint)
      return
    }
    // 只把「人可能要看」的错误转到宿主日志：QQ 客户端会刷大量 QUIC/GPU 噪音（每条都带 ERROR:），
    // 全转出去会把 DSH 控制台淹掉；噪音行仍留在 _logTail 里供排障。
    const noisy = /light_quic|OnNewEncryptionKeyAvailable|GetCryptoConfig|quic|gpu_|dxgi|vulkan|tls_|stream_bytes|packets_/i
    if (/error|fail|失败|exception/i.test(raw) && !noisy.test(raw) && this._childWarnCount < 20) {
      this._childWarnCount += 1
      this.log.warn(`napcat> ${safe}`)
    }
  }

  /**
   * 停止本插件拉起的 NapCat（只动自己 spawn 的进程树 / 自己配置的 WebUI 端口）。
   * 不碰用户其它 QQ；平台不支持时返回 {ok:false}。
   */
  async stop(options = {}) {
    const managed = await this.detectManaged({ force: true })
    const dir = managed.installDir || managed.dir || ''
    if (this.platform !== 'win32') {
      return { ok: false, error: '托管停止只支持 Windows', running: managed.running }
    }
    let stopped = false
    let method = ''
    const pids = []
    const child = this.child
    if (child && child.exitCode === null && child.pid) {
      const result = await this._killTree(child.pid)
      if (result.ok) {
        stopped = true
        method = 'child-tree'
        pids.push(Number(child.pid))
      }
    }
    // 启动器（cmd）可能提前退出但 QQ/NapCat 还在：按自己配置的 WebUI 端口找进程
    if (!stopped && managed.installed && validPort(managed.webuiPort) && this.startedAt > 0) {
      const owner = await this._findPidOnPort(managed.webuiPort)
      if (owner && owner !== process.pid) {
        const result = await this._killTree(owner)
        if (result.ok) {
          stopped = true
          method = 'port-owner'
          pids.push(owner)
        }
      }
    }
    const portClosed = validPort(managed.webuiPort)
      ? await waitPortClosed(managed.webuiPort, { timeoutMs: Number(options.timeoutMs) || 10_000 })
      : { ok: true }
    this.child = null
    this.childPid = 0
    this.startedAt = 0
    this._childExit = null
    this._observedWebuiPort = 0
    this._logTail = []
    this._managedCache = null
    if (stopped) this.lastError = ''
    return { ok: true, stopped, method, pids, portClosed: portClosed.ok, dir, webuiPort: managed.webuiPort || 0 }
  }

  /** 只结束指定安装路径下的 QQ.exe（供面板「关闭 QQ 并继续」按钮用） */
  async killQQForNapcat() {
    if (this.platform !== 'win32') return { ok: false, error: '只支持 Windows' }
    const qq = await this.detectQQ({ force: true })
    if (!qq.pathKnown || !qq.path) {
      return { ok: false, error: '没探测到本机 QQ 安装路径；为了不误杀，插件不动手，请手动退出 QQ', qq }
    }
    if (!qq.processesKnown) {
      return { ok: false, error: '拿不到 QQ.exe 的完整路径，无法只关同一份安装的 QQ；请手动退出 QQ', qq }
    }
    const targets = qq.processes.filter((process) => process.path && samePath(process.path, qq.path))
    const others = qq.processes.filter((process) => !process.path || !samePath(process.path, qq.path))
    if (!targets.length) return { ok: true, killed: [], skipped: others, message: `没有正在运行的 QQ（${qq.path}）`, qq }
    const killed = []
    const failed = []
    for (const process of targets) {
      const result = await this._run('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { timeoutMs: 15_000 })
      if (result.error) failed.push({ pid: process.pid, error: String(result.stderr || messageOf(result.error)).slice(0, 200) })
      else killed.push(process.pid)
    }
    this._qqCache = null
    const message = failed.length
      ? `关了 ${killed.length} 个 QQ 进程，${failed.length} 个没关掉（可能需要管理员权限）`
      : `已关闭 ${killed.length} 个 QQ 进程（只动了 ${qq.path} 这份安装）`
    return { ok: failed.length === 0, killed, failed, skipped: others, message, qq }
  }

  /** 等 WebUI 端口就绪（start() 已经等过，这里给 Host 补一次机会） */
  async waitWebuiReady(options = {}) {
    const managed = await this.detectManaged({ force: true })
    const port = Number(options.port) || managed.webuiPort
    const result = await waitPortOpen(port, {
      timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90_000,
      intervalMs: Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 800,
    })
    return { ...result, webuiPort: port }
  }

  // ── 二维码兜底 ─────────────────────────────────────────────────────────

  /**
   * 读 `<NapCat 目录>/cache/qrcode.png`，返回 data URL；文件不存在/不是 PNG/尺寸不像二维码返回 null。
   * 这是 API 通道拿不到二维码时的兜底（NapCat 会把它落盘）。
   * 注意：真机实测 NapCat v4.18.41 落盘的是 147×147 的 1-bit PNG，只有约 600 字节，
   * 所以不能用「≥10KB」当门槛（会一直显示不出二维码）——改看 PNG 头与边长。
   */
  async readQrPng() {
    const info = await this.readQrPngInfo()
    return info ? info.dataUrl : null
  }

  /** 同 readQrPng，但带文件元信息（排障用）；拿不到返回 null */
  async readQrPngInfo(options = {}) {
    const managed = await this.detectManaged()
    const dir = managed.installDir || managed.dir
    if (!dir) return null
    const candidates = [join(dir, 'cache', 'qrcode.png'), join(dir, 'napcat', 'cache', 'qrcode.png')]
    let file = ''
    let buffer = null
    for (const candidate of candidates) {
      try {
        buffer = readFileSync(candidate)
        file = candidate
        break
      } catch {}
    }
    if (!Buffer.isBuffer(buffer)) return null
    const minBytes = Number(options.minBytes) > 0 ? Number(options.minBytes) : 100
    if (buffer.length < minBytes) return null
    if (!isPngBuffer(buffer)) return null
    if (!looksLikeQrPng(buffer)) return null
    let mtimeMs = 0
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {}
    return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, file, size: buffer.length, mtimeMs }
  }

  // ── OneBot 配置写盘封装 ────────────────────────────────────────────────

  /**
   * 把 OneBot 11 配置写到托管目录（默认 config/onebot11.json；给 uin 则写 onebot11_<uin>.json）。
   * 还没启动 NapCat 时用这个；启动后也可以走 lib/webui.mjs 的 setOb11Config API。
   */
  async writeOb11Config(config, options = {}) {
    const managed = await this.detectManaged({ force: true })
    const dir = managed.installDir || managed.dir
    if (!managed.installed || !dir) {
      throw new NapCatInstallError('还没安装 NapCat，没法写 OneBot 配置', { stage: 'config' })
    }
    let value
    if (typeof config === 'string') {
      try {
        value = JSON.parse(config)
      } catch (error) {
        throw new NapCatInstallError(`OneBot 配置不是合法 JSON：${messageOf(error)}`, { stage: 'config' })
      }
    } else if (config && typeof config === 'object') {
      value = config
    } else {
      throw new NapCatInstallError('OneBot 配置必须是对象或 JSON 字符串', { stage: 'config' })
    }
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    const uin = String(options.uin || '').replace(/\D/g, '')
    const file = join(configDir, uin ? `onebot11_${uin}.json` : 'onebot11.json')
    writeJsonAtomic(file, value)
    chmodBestEffort(file, 0o600)
    this._managedCache = null
    return { ok: true, file, config: value }
  }

  // ── 内部工具 ───────────────────────────────────────────────────────────

  /** execFile 的 Promise 包装（统一带 windowsHide / timeout / maxBuffer） */
  _run(command, args = [], options = {}) {
    return new Promise((resolve) => {
      let settled = false
      const done = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      try {
        this.execFileImpl(
          command,
          args,
          {
            windowsHide: true,
            timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10_000,
            maxBuffer: Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : 8 * 1024 * 1024,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            done({ error: error || null, stdout: String(stdout || ''), stderr: String(stderr || '') })
          },
        )
      } catch (error) {
        done({ error, stdout: '', stderr: '' })
      }
    })
  }

  /** 结束一个进程树（Windows：taskkill /PID <pid> /T /F） */
  async _killTree(pid) {
    const value = Number(pid)
    if (!value) return { ok: false, detail: '没有 pid' }
    if (this.platform !== 'win32') {
      try {
        process.kill(value, 'SIGTERM')
        return { ok: true }
      } catch (error) {
        return { ok: false, detail: messageOf(error) }
      }
    }
    const result = await this._run('taskkill.exe', ['/PID', String(value), '/T', '/F'], { timeoutMs: 15_000 })
    if (result.error) return { ok: false, detail: String(result.stderr || messageOf(result.error)).slice(0, 300) }
    return { ok: true }
  }

  /** 找监听某端口的进程 pid（netstat -ano），只在自己拉起过 NapCat 时才用于停止 */
  async _findPidOnPort(port) {
    if (!validPort(port) || this.platform !== 'win32') return 0
    const result = await this._run('netstat.exe', ['-ano', '-p', 'tcp'], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 })
    if (result.error) return 0
    const pattern = new RegExp(`[.:]${Number(port)}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (!match) continue
      const pid = Number(match[1])
      if (pid && pid !== process.pid) return pid
    }
    return 0
  }

  /** 释放实例内存态（不杀进程、不写盘）；之后一般由 Host 重新 new 一个 */
  dispose() {
    this._qqCache = null
    this._managedCache = null
    this.child = null
    this.childPid = 0
  }
}

// ---------------------------------------------------------------------------
// 模块内纯函数
// ---------------------------------------------------------------------------

function normalizeRelease(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const tag = String(raw.tag_name || raw.tag || raw.version || '')
  if (!tag) throw new NapCatInstallError('release 信息里没有 tag_name', { stage: 'resolve' })
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    assets: Array.isArray(raw.assets) ? raw.assets : [],
    htmlUrl: String(raw.html_url || ''),
    raw,
  }
}

function parseCimProcessJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .map((item) => ({ pid: Number(item && item.ProcessId) || 0, path: String((item && item.ExecutablePath) || '') }))
      .filter((item) => item.pid > 0)
  } catch {
    return null
  }
}

/** 校验文件头是不是 zip（PK\x03\x04 / 空 zip 的 PK\x05\x06） */
function validateZipMagic(file) {
  let fd = 0
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(4)
    readSync(fd, head, 0, 4, 0)
    const isZip =
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06)
    if (!isZip) {
      throw new NapCatInstallError('下载到的文件不是 zip（可能被代理/登录页拦截），拒绝解压', {
        stage: 'download',
        targetDir: file,
        hint: '换镜像或检查网络；也可手动下载后通过 assetUrl 指定直链',
      })
    }
    return true
  } finally {
    if (fd) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function isPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
}

/**
 * 二维码 PNG 的尺寸门槛：真机 v4.18.41 落盘 147×147 的 1-bit PNG（~600B），
 * 所以只要求是 PNG 且边长在合理区间（≥64、≤2048），不按文件大小判断。
 */
function looksLikeQrPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 26) return false
  // IHDR 紧跟在 8 字节签名后（PNG 规范），宽高为大端 uint32
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  return width >= 64 && height >= 64 && width <= 2048 && height <= 2048
}

/**
 * 把 status()/detect() 里的 token 脱敏，给面板 HTTP 响应用。
 * 返回新对象，不修改原对象。
 */
export function maskProvisionStatus(status) {
  if (!status || typeof status !== 'object') return status
  const out = { ...status }
  out.hasWebuiToken = Boolean(status.webuiToken)
  out.hasOnebotToken = Boolean(status.onebotToken)
  out.webuiToken = ''
  out.onebotToken = ''
  if (status.onebot && typeof status.onebot === 'object') {
    out.onebot = { ...status.onebot, token: '', hasToken: Boolean(status.onebot.token) }
  }
  if (status.qq && typeof status.qq === 'object') out.qq = { ...status.qq }
  return out
}

export default NapCatProvisioner
