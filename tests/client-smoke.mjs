/**
 * tests/client-smoke.mjs — 面板半端冒烟测试（零依赖）
 * ============================================================================
 * client.js 是 classic script（进浏览器靠 window.__ModuleLoader__），node 里
 * 不能直接 import。这个测试给它搭一个最小宿主：
 *
 *   - 假的 window.__ModuleLoader__.load({id, factory})
 *   - 假的 require('react')：只实现 createElement / Fragment / hooks 空实现
 *
 * 目的不是「渲染出页面」，而是：
 *   1. 确认 factory 能跑完（顶层没有运行时错误，比如拼错的常量）；
 *   2. 断言那些纯函数的输出契约（脱敏、时间、会话 key、状态色）；
 *   3. 确认 apply() 注册的 slot 名字没变——改名会让老用户的面板直接消失。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = readFileSync(join(ROOT, 'client.js'), 'utf8')

// ---- 最小 React 替身 ---------------------------------------------------------
const noop = () => {}
function createElement(type, props, ...children) {
  return { type, props: props || {}, children }
}
const fakeReact = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useReducer: (r, init) => [init, noop],
  createContext: (v) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: v }),
  useContext: (ctx) => (ctx && ctx._value) || null,
}

// ---- 最小宿主 ---------------------------------------------------------------
let loaded = null
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Date,
  Math,
  JSON,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Map,
  Set,
  URL,
  URLSearchParams,
  Intl,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  AbortController: class { constructor() { this.signal = {} } abort() {} },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  addEventListener: noop,
  removeEventListener: noop,
  window: {},
  document: {
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    head: { appendChild: noop },
    getElementById: () => null,
    querySelector: () => null,
    body: { appendChild: noop },
  },
  navigator: { userAgent: 'node' },
}
sandbox.window = sandbox
sandbox.window.addEventListener = noop
sandbox.window.removeEventListener = noop
sandbox.window.__ModuleLoader__ = {
  load(mod) {
    loaded = mod
  },
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

assert.ok(loaded, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-dafeiyu-home', '插件 id 变了')

const api = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('client.js 只允许 require("react")，实际 require 了：' + name)
})

// ---- 1. 模块形状 -------------------------------------------------------------
assert.equal(typeof api.apply, 'function', '缺少 apply')
assert.deepEqual(Array.from(api.inject), ['slots', 'layout'], 'inject 列表变了')
const smoke = api.__smoke
assert.ok(smoke, '__smoke 导出被删了，纯函数测试无法继续')

// ---- 2. 脱敏 -----------------------------------------------------------------
assert.equal(smoke.maskUin('12345678'), '12****78')
assert.equal(smoke.maskUin('12****78'), '12****78', '已脱敏的号要原样返回')
assert.equal(smoke.maskUin('abc'), 'abc', '非数字原样返回')
assert.equal(smoke.maskUin(''), '')
assert.equal(smoke.maskUin(null), '')
assert.equal(smoke.displayName('12345678'), '12****78', '纯数字昵称也要脱敏')
assert.equal(smoke.displayName('小鱼'), '小鱼')
assert.equal(smoke.displayName('', '12****78'), '12****78')
assert.equal(smoke.displayName('', ''), '未知')

// ---- 3. 会话 key -------------------------------------------------------------
assert.deepEqual({ ...smoke.parseConvKey('group:123') }, { kind: 'group', id: '123', key: 'group:123' })
assert.deepEqual({ ...smoke.parseConvKey('private:456') }, { kind: 'private', id: '456', key: 'private:456' })
assert.equal(smoke.parseConvKey('789').kind, 'private', '没有前缀时按私聊处理')
assert.equal(smoke.parseConvKey('').id, '')

// ---- 4. 时间/数字 ------------------------------------------------------------
assert.equal(smoke.fmtInt(1234567), '1,234,567')
assert.equal(smoke.fmtInt(-1000), '-1,000')
assert.equal(smoke.fmtSeconds(45), '45 秒')
assert.equal(smoke.fmtSeconds(120), '2 分钟')
assert.equal(smoke.relTime(Date.now() - 1000, Date.now()), '刚刚')
assert.equal(smoke.relTime(Date.now() - 90 * 1000, Date.now()), '1 分钟前')
assert.equal(smoke.relTime(Date.now() - 3 * 3600 * 1000, Date.now()), '3 小时前')
assert.equal(smoke.relTime(0, Date.now()), '')

// ---- 5. 状态文案/色调 ---------------------------------------------------------
assert.equal(smoke.phaseText('ready'), '已登录')
assert.equal(smoke.phaseText('不存在的阶段'), '准备中')
assert.equal(smoke.isQrPhase('waiting_qrcode'), true)
assert.equal(smoke.isQrPhase('ready'), false)
assert.equal(smoke.bridgeTone('online'), 'ok')
assert.equal(smoke.bridgeTone('reconnecting'), 'warn')
assert.equal(smoke.bridgeTone('什么鬼'), 'idle')
assert.equal(smoke.errorCodeOf({ code: 'qq-running' }), 'qq-running')
assert.equal(smoke.errorCodeOf({ payload: { code: 'x' } }), 'x')
assert.equal(smoke.errorCodeOf(null), '')

// ---- 6. 主题色必须主要由宿主 CSS 变量派生（写死色值深色主题会瞎） ------------
// 不追求 100%：纯白/纯黑文字、阴影这类与主题无关的值允许写死。
const themeVals = Object.entries(smoke.THEME).map(([k, v]) => [k, String(v)])
const themed = themeVals.filter(
  ([, v]) =>
    v.indexOf('var(--dsw-alias-') >= 0 || v.indexOf('color-mix(') >= 0 || v.indexOf('linear-gradient(') >= 0,
)
const ratio = themed.length / themeVals.length
assert.ok(
  ratio >= 0.7,
  'THEME 里只有 ' + themed.length + '/' + themeVals.length + ' 项走宿主变量，低于 70%',
)
// 几个关键底色必须跟主题走，否则切深色会白到刺眼
for (const key of ['bg', 'card', 'block', 'sub', 'line', 'bubbleInBg']) {
  assert.ok(smoke.THEME[key], 'THEME 缺 ' + key)
  assert.ok(
    String(smoke.THEME[key]).indexOf('var(--dsw-alias-') >= 0,
    'THEME.' + key + ' 必须用宿主变量：' + smoke.THEME[key],
  )
}

// ---- 7. apply() 注册的 slot ------------------------------------------------
// 真实契约：ctx.slots.inject(name, factory)，factory 里再 ctx.slots.register(desc, comp)。
const injected = []
const registered = []
const fakeCtx = {
  slots: {
    inject(name, factory) {
      injected.push(name)
      if (typeof factory === 'function') factory()
    },
    register(desc, component) {
      registered.push({ desc, component })
      return { ok: true }
    },
  },
  layout: { register: noop },
  on: noop,
  effect: noop,
  logger: { info: noop, warn: noop, error: noop },
}
api.apply(fakeCtx)
for (const want of ['sidebar.panellist', 'main']) {
  assert.ok(injected.indexOf(want) >= 0, '没有 inject ' + want + '，实际：' + injected.join(', '))
}
assert.equal(registered.length, 2, '应注册 2 个 slot，实际：' + registered.length)
const sidebar = registered.find((r) => r.desc.name === 'sidebar.panellist')
const main = registered.find((r) => r.desc.name === 'main')
assert.ok(sidebar && main, '注册的 slot 名不对')
assert.equal(sidebar.desc.id, smoke.PANEL_ID, '侧栏 id 必须等于 PANEL_ID')
assert.ok(sidebar.desc.label, '侧栏要有 label')
assert.equal(main.desc.key, smoke.PANEL_ID, '面板 key 必须等于 PANEL_ID')
assert.equal(typeof sidebar.component, 'function', '侧栏图标应是组件')
assert.equal(typeof main.component, 'function', '面板应是组件')

// apply 在缺少 slots 的宿主上必须安静退出（老版本 DSH 没有这个服务）
api.apply({})
api.apply(null)

console.log('[client-smoke] 全部通过（inject：' + injected.join(', ') + '）')
