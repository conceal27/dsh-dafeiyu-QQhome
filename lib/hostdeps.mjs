/**
 * lib/hostdeps.mjs — 从宿主（DSH 安装树）里取 `@deepseek-ai/*` 模块（归属：xingzhu）
 * ============================================================================
 * 为什么需要：外部插件装在 profile 里，profile 是 `autoInstallPeers: false`，
 * 所以 `@deepseek-ai/dsh-llm` / `schemastery` 不一定在插件自己的 node_modules 里。
 * 做法：先按 DSH 安装树找（桌面版 app.asar 的 dsh/node_modules，或 npm 全局树），
 * 其次退回裸 import（插件自己 dependencies 装的那份），最后返回 null 让调用方降级。
 * 绝不因为一个拿不到的可选依赖让整条插件不激活。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_MODULES = join(SELF_DIR, '..', 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const roots = []
  const push = (p) => {
    if (!p) return
    if (!roots.includes(p)) roots.push(p)
  }
  push(process.env.DSH_HOST_MODULES)

  // 桌面版：安装目录下的 app.asar 内 dsh/node_modules（Node 可直接从 asar 读）
  const exe = process.execPath
  if (exe) {
    const dir = dirname(exe)
    // resources/app.asar/dsh/node_modules/@deepseek-ai
    push(join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(dir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
    // .exe 在安装根目录
    push(join(dir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'))
  }

  // npm 全局安装（cli 版）
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const name of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', name, 'node_modules', '@deepseek-ai'))
      }
    } catch {}
  }

  // Linux / macOS CLI：Node 全局安装的包（/usr/lib/node_modules 等）
  for (const prefix of ['/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    push(join(prefix, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(prefix, '@deepseek-ai'))
  }

  // 各 profile 的 node_modules（有些机器上被别的插件 hoist 上来）
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(home, 'profiles'))) {
      push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch {}

  push(PKG_MODULES)
  return roots
}

function entryUrl(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports && pkg.exports['.']
    const rel = typeof dot === 'string' ? dot : dot && (dot.import || dot.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

/** 从宿主树里取一个包；拿不到返回 null（调用方自行降级） */
export async function loadHostModule(name, log) {
  for (const root of candidateRoots()) {
    const url = entryUrl(root, name)
    if (!url) continue
    try {
      return await import(url)
    } catch (e) {
      log?.(`${name}: 从 ${root} 加载失败（${e && e.code ? e.code : String(e).slice(0, 80)}）`)
    }
  }
  try {
    return await import(name)
  } catch (e) {
    log?.(`${name}: 裸 import 也失败（${e && e.code ? e.code : String(e).slice(0, 80)}）`)
    return null
  }
}

/** dsh-llm 的那几个运行时导出（BlockAssembler / createUserMessage / createAssistantMessage） */
export async function loadLlmKit(log) {
  const mod = await loadHostModule('dsh-llm', log)
  const kit = mod && (mod.BlockAssembler ? mod : mod.default)
  if (!kit || typeof kit.BlockAssembler !== 'function') return null
  return kit
}
