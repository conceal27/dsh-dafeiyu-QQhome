import { homedir } from 'node:os'
/**
 * lib/douyin.mjs — 抖音（无头 Chromium，A 方案）
 * ============================================================================
 * 为什么是这套：
 *   · 抖音没有开放接口；网页版不登录也能看「精选/推荐」流，登录后才能发作品/回评论；
 *   · 服务器是 Linux 无桌面，所以用 chrome-headless-shell（puppeteer-core 驱动）；
 *   · 登录只做一次：打开首页 → 点登录 → 抓二维码（data:image/png;base64）
 *     → 主人用抖音 App 扫 → cookie 落在 profile 目录，重启仍在；
 *   · 风控：随机停顿、每次只刷一小会儿、每天次数有限；不批量点赞/评论。
 *
 * 数据：$DSH_HOME/qq-fish/douyin/
 *   profile/   浏览器用户目录（cookie、localStorage）
 *   shots/     登录二维码截图
 *   state.json 登录/上次刷/发过什么
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateHome } from './store.mjs'
import { addMemory } from './memory-decay.mjs'

const HOME_URL = 'https://www.douyin.com/'
const CREATOR_URL = 'https://creator.douyin.com/creator-micro/home'
const LOGIN_PAGE = 'https://www.douyin.com/user/self'
const IDLE_CLOSE_MS = 10 * 60 * 1000
const CHROME_CACHE = join(process.env.HOME || homedir(), '.cache/puppeteer/chrome-headless-shell')

let PUPPETEER = null
let BROWSER = null
let IDLE_TIMER = null
let LAUNCHING = null

export function douyinDir() {
  return join(stateHome(), 'douyin')
}

export function douyinPaths() {
  const dir = douyinDir()
  return {
    dir,
    profile: join(dir, 'profile'),
    shots: join(dir, 'shots'),
    state: join(dir, 'state.json'),
    events: join(dir, 'events.jsonl'),
  }
}

function ensureDirs() {
  const p = douyinPaths()
  for (const d of [p.dir, p.profile, p.shots]) mkdirSync(d, { recursive: true })
  return p
}

export function loadState() {
  try { return JSON.parse(readFileSync(douyinPaths().state, 'utf8')) || {} } catch { return {} }
}

export function saveState(patch) {
  const p = ensureDirs()
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() }
  writeFileSync(p.state, JSON.stringify(next, null, 2))
  return next
}

function appendEvent(ev) {
  try {
    const p = ensureDirs()
    writeFileSync(p.events, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n', { flag: 'a' })
  } catch {}
}

/**
 * 找可用的 Chrome：优先完整版（headless-shell 是老 headless，抖音的二维码图渲不出来，
 * 只显示成 TikTok 图标占位——2026-11-13 实测踩过这个坑）。
 */
export function findChrome() {
  const env = String(process.env.DOUYIN_CHROME || '').trim()
  if (env && existsSync(env)) return env
  const home = process.env.HOME || homedir()
  const fullRoot = join(home, '.cache/puppeteer/chrome')
  try {
    const dirs = readdirSync(fullRoot).filter((d) => d.startsWith('linux-')).sort().reverse()
    for (const d of dirs) {
      const exe = join(fullRoot, d, 'chrome-linux64', 'chrome')
      if (existsSync(exe)) return exe
    }
  } catch {}
  try {
    const dirs = readdirSync(CHROME_CACHE).filter((d) => d.startsWith('linux-')).sort().reverse()
    for (const d of dirs) {
      const exe = join(CHROME_CACHE, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
      if (existsSync(exe)) return exe
    }
  } catch {}
  return ''
}

async function puppeteer() {
  if (!PUPPETEER) {
    const mod = await import('puppeteer-core')
    PUPPETEER = mod.default || mod
  }
  return PUPPETEER
}

function armIdleClose() {
  if (IDLE_TIMER) clearTimeout(IDLE_TIMER)
  IDLE_TIMER = setTimeout(() => { closeBrowser().catch(() => {}) }, IDLE_CLOSE_MS)
  IDLE_TIMER.unref?.()
}

export async function getBrowser({ log } = {}) {
  if (BROWSER && BROWSER.connected) { armIdleClose(); return BROWSER }
  if (LAUNCHING) return LAUNCHING
  LAUNCHING = (async () => {
    const exe = findChrome()
    if (!exe) throw new Error('没找到 chrome-headless-shell，先装：见 AI-CHANGELOG 的抖音条目')
    const p = await puppeteer()
    const paths = ensureDirs()
    BROWSER = await p.launch({
      executablePath: exe,
      headless: true,
      userDataDir: paths.profile,
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN',
      ],
    })
    BROWSER.on('disconnected', () => { BROWSER = null })
    armIdleClose()
    log && log.info && log.info('[抖音] 浏览器已启动')
    return BROWSER
  })().finally(() => { LAUNCHING = null })
  return LAUNCHING
}

export async function closeBrowser() {
  const b = BROWSER
  BROWSER = null
  if (IDLE_TIMER) { clearTimeout(IDLE_TIMER); IDLE_TIMER = null }
  if (b) { try { await b.close() } catch {} }
  return true
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function newPage({ log } = {}) {
  const browser = await getBrowser({ log })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    })
  } catch {}
  page.setDefaultTimeout(45_000)
  armIdleClose()
  return page
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function rand(a, b) { return a + Math.floor(Math.random() * Math.max(1, b - a)) }

/** 登录态：cookie 里有没有 sessionid / sid_tt 这一族 */
export async function readCookies(page) {
  const cookies = await page.cookies()
  const names = new Set(cookies.map((c) => c.name))
  const hits = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'passport_csrf_token'].filter((n) => names.has(n))
  return { total: cookies.length, hits, loggedIn: (names.has('sessionid') || names.has('sessionid_ss')) && names.size > 3 }
}

export async function loginStatus({ log } = {}) {
  const page = await newPage({ log })
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    const ck = await readCookies(page)
    const nick = await page.evaluate(() => {
      const el = document.querySelector('[data-e2e="user-info"] img, header img[alt]')
      return el ? String(el.getAttribute('alt') || '') : ''
    }).catch(() => '')
    saveState({ loggedIn: ck.loggedIn })
    return { ok: true, ...ck, nick }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally { await page.close().catch(() => {}) }
}

/** 打开登录弹窗，抓二维码（data URL）——主人扫这个 */
export async function startLogin({ log } = {}) {
  const page = await newPage({ log })
  const paths = ensureDirs()
  try {
    // 「我的」页未登录时必定弹出登录框，且二维码是页面自带的（比点右上角按钮稳）
    await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    let box = null
    for (let i = 0; i < 30 && !box; i++) {
      await sleep(1000)
      box = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((e) => {
          const r = e.getBoundingClientRect()
          return e.offsetParent && r.width >= 140 && r.width <= 300 && Math.abs(r.width - r.height) <= 6 && e.naturalWidth >= 100
        })
        for (const e of imgs) {
          const r = e.getBoundingClientRect()
          const src = e.getAttribute('src') || ''
          if (src.startsWith('data:image')) return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
        }
        return null
      }).catch(() => null)
    }
    if (!box) {
      // 兜底：点右上角「登录」再找一次
      const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '登录'))
      try { await btn.asElement()?.click() } catch {}
      for (let i = 0; i < 20 && !box; i++) {
        await sleep(1000)
        box = await page.evaluate(() => {
          const imgs = [...document.querySelectorAll('img')].filter((e) => {
            const r = e.getBoundingClientRect()
            return e.offsetParent && r.width >= 140 && r.width <= 300 && Math.abs(r.width - r.height) <= 6 && e.naturalWidth >= 100 && (e.getAttribute('src') || '').startsWith('data:image')
          })
          if (!imgs.length) return null
          const r = imgs[0].getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
        }).catch(() => null)
      }
    }
    if (!box) {
      const shot = join(paths.shots, `login-noqr-${Date.now()}.png`)
      await page.screenshot({ path: shot })
      return { ok: false, error: '二维码没渲染出来（可能被风控或网络挡了），已整页截图', shot }
    }
    const b64 = await page.screenshot({
      encoding: 'base64',
      clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.w, height: box.w },
    })
    const buf = Buffer.from(b64, 'base64')
    const file = join(paths.shots, `qr-${Date.now()}.png`)
    writeFileSync(file, buf)
    saveState({ lastLoginAt: new Date().toISOString(), lastQr: file })
    appendEvent({ kind: 'login-qr', file })
    log && log.info && log.info('[抖音] 登录二维码已生成：' + file)
    return { ok: true, qr: 'data:image/png;base64,' + b64, shot: file, bytes: buf.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally { await page.close().catch(() => {}) }
}

export async function waitLogin({ minutes = 8, log } = {}) {
  const deadline = Date.now() + Math.max(1, minutes) * 60_000
  while (Date.now() < deadline) {
    const st = await loginStatus({ log })
    if (st.ok && st.loggedIn) {
      saveState({ loggedIn: true, loginAt: new Date().toISOString() })
      appendEvent({ kind: 'login-ok' })
      return { ok: true, loggedIn: true, nick: st.nick }
    }
    await sleep(5000)
  }
  return { ok: false, loggedIn: false, timeout: true }
}

/**
 * 刷一眼推荐流：返回卡片（标题/作者/时长/点赞），不点开、不互动。
 * 不登录也能用——这正是「她有自己的生活」里成本最低的一步。
 */
export async function browseFeed({ limit = 10, scrolls = 1, log } = {}) {
  const page = await newPage({ log })
  const t0 = Date.now()
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
    await sleep(rand(3500, 5500))
    for (let i = 0; i < Math.max(0, scrolls); i++) {
      await page.evaluate(() => window.scrollBy(0, rand(600, 1100))).catch(() => {})
      await sleep(rand(1200, 2400))
    }
    const cards = await page.evaluate((max) => {
      const items = [...document.querySelectorAll('.discover-video-card-item, .waterfall-videoCardContainer, [data-e2e="feed-item"]')]
      const out = []
      const seen = new Set()
      for (const el of items) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const img = el.querySelector('img.discover-video-card-img') || el.querySelector('img')
        const alt = img ? String(img.getAttribute('alt') || '') : ''
        if (!alt && /广告|直播加载中/.test(text)) continue
        const dur = (text.match(/\b\d{1,2}:\d{2}\b/) || [])[0] || ''
        const like = (text.match(/^[\d.]+\s*万?\b/) || [])[0] || ''
        const author = (text.match(/@([^\s·]+)/) || [])[1] || ''
        const title = (alt || text).replace(/\s*#\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (!title || seen.has(title)) continue
        seen.add(title)
        out.push({ title, author, dur, like, text: text.slice(0, 180) })
        if (out.length >= max) break
      }
      return out
    }, Math.max(1, Math.min(20, limit)))
    saveState({ lastBrowseAt: new Date().toISOString() })
    appendEvent({ kind: 'browse', count: cards.length, ms: Date.now() - t0 })
    return { ok: true, cards, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), cards: [] }
  } finally { await page.close().catch(() => {}) }
}

/** 把刷到的东西沉淀成记忆（scope=douyin），别的平台（QQ/空间/B站）都读得到 */
export function rememberFeed(cards, { config = {} } = {}, now = Date.now()) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && c.title) : []
  if (!list.length) return { ok: true, written: 0 }
  const picked = list.slice(0, 3)
  const clean = (s) => String(s || '').replace(/^《+/, '').replace(/》+$/, '').replace(/\s+/g, ' ').trim().slice(0, 42)
  const parts = picked.map((c) => `《${clean(c.title)}》${c.author ? '（@' + c.author + '）' : ''}`)
  const text = '她在抖音刷到：' + parts.join('；') + '。'
  try {
    addMemory(text, { importance: 64, scope: 'douyin', config }, now)
    return { ok: true, written: 1, text }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), written: 0 }
  }
}

/** 创作者中心是否可用（发作品/看评论都要它） */
export async function creatorStatus({ log } = {}) {
  const page = await newPage({ log })
  try {
    await page.goto(CREATOR_URL, { waitUntil: 'domcontentloaded' })
    await sleep(3000)
    const url = page.url()
    return { ok: true, url, loggedIn: !/login|passport/.test(url) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally { await page.close().catch(() => {}) }
}

export async function status({ log } = {}) {
  const st = loadState()
  const paths = douyinPaths()
  return {
    ok: true,
    dir: paths.dir,
    chrome: findChrome(),
    hasProfile: existsSync(paths.profile),
    loggedIn: st.loggedIn === true,
    loginAt: st.loginAt || '',
    lastBrowseAt: st.lastBrowseAt || '',
    lastQr: st.lastQr || '',
    browserUp: !!(BROWSER && BROWSER.connected),
    features: {
      browse: true,            // 不登录也能刷推荐流
      post: st.loggedIn === true,
      comments: st.loggedIn === true,
    },
  }
}

/**
 * 发一条图文（需要已登录；未登录直接拒绝，不浪费一次浏览器启动）。
 * images: 本地图片绝对路径数组（0~9 张）。没有图就走「纯文字 + 一张占位」不合适，
 *         所以没有图时明确报错，让上层改用 qzone/qq。
 * 注意：creator 的 DOM 会改版，这里每一步都容错并在失败时把当时的 URL/标题带回来，
 *       方便面板里一眼看出卡在哪一步。
 */
export async function publishImageText({ text = '', images = [], title = '', log } = {}) {
  const st = loadState()
  if (st.loggedIn !== true) return { ok: false, reason: 'not-logged-in' }
  const files = (Array.isArray(images) ? images : []).filter((f) => typeof f === 'string' && existsSync(f)).slice(0, 9)
  if (!files.length) return { ok: false, reason: 'no-images' }

  const page = await newPage({ log })
  const steps = []
  try {
    await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'domcontentloaded' })
    await sleep(3500)
    steps.push('open:' + page.url().slice(0, 80))
    if (/login|passport/.test(page.url())) {
      saveState({ loggedIn: false })
      return { ok: false, reason: 'session-expired', steps }
    }

    // 有的版本默认是「上传视频」，点「发布图文」切过去
    try {
      const tabs = await page.$$('div,span,button')
      for (const t of tabs) {
        const s = await page.evaluate((el) => (el.textContent || '').trim(), t).catch(() => '')
        if (s === '发布图文' || s === '图文') { await t.click().catch(() => {}); await sleep(1500); break }
      }
    } catch {}

    const input = await page.$('input[type=file]')
    if (!input) return { ok: false, reason: 'no-file-input', steps, url: page.url() }
    await input.uploadFile(...files)
    steps.push('uploaded:' + files.length)
    await sleep(5000 + files.length * 1200)

    // 标题（可选）
    if (title) {
      try {
        const t = await page.$('input[placeholder*="标题"], input[placeholder*="作品标题"]')
        if (t) { await t.click(); await t.type(String(title).slice(0, 30), { delay: 40 }) }
      } catch {}
    }

    // 正文
    let filled = false
    try {
      const box = await page.$('div[contenteditable="true"], textarea[placeholder*="描述"], textarea[placeholder*="正文"]')
      if (box) {
        await box.click()
        await page.keyboard.type(String(text || '').slice(0, 1000), { delay: 25 })
        filled = true
      }
    } catch (e) { steps.push('fill-err:' + String((e && e.message) || e).slice(0, 60)) }
    if (!filled) return { ok: false, reason: 'no-editor', steps, url: page.url() }
    steps.push('filled')

    await sleep(1500)
    // 发布按钮
    let clicked = false
    const nodes = await page.$$('button, div[role="button"]')
    for (const n of nodes) {
      const s = await page.evaluate((el) => (el.textContent || '').trim(), n).catch(() => '')
      if (s === '发布' || s === '发布作品' || s === '立即发布') {
        await n.click().catch(() => {})
        clicked = true
        break
      }
    }
    if (!clicked) return { ok: false, reason: 'no-publish-button', steps, url: page.url() }
    steps.push('clicked')

    // 等跳转/提示
    let ok = false
    for (let i = 0; i < 20; i++) {
      await sleep(1500)
      const u = page.url()
      if (/content\/manage|content\/upload-success|success/.test(u)) { ok = true; break }
      const body = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '')
      if (/发布成功|已发布/.test(body)) { ok = true; break }
      if (/失败|违规|不能发布/.test(body)) return { ok: false, reason: 'rejected', detail: body.slice(0, 160), steps }
    }
    if (ok) {
      saveState({ lastPostAt: new Date().toISOString(), lastPostText: String(text || '').slice(0, 120) })
      appendEvent({ kind: 'post', images: files.length, chars: String(text || '').length })
      try { addMemory('她在抖音发了一条图文：' + String(text || '').replace(/\s+/g, ' ').slice(0, 200), { importance: 72, scope: 'douyin' }) } catch {}
      return { ok: true, steps, note: '已发布（未复核是否过审）' }
    }
    return { ok: false, reason: 'no-confirmation', steps, url: page.url() }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), steps }
  } finally {
    await page.close().catch(() => {})
  }
}

/** 读最近收到的评论（互动管理 → 评论），回流成记忆 */
export async function readComments({ limit = 10, remember = false, config = {}, log } = {}) {
  const st = loadState()
  if (st.loggedIn !== true) return { ok: false, reason: 'not-logged-in', items: [] }
  const page = await newPage({ log })
  try {
    await page.goto('https://creator.douyin.com/creator-micro/interaction/comment', { waitUntil: 'domcontentloaded' })
    await sleep(4000)
    if (/login|passport/.test(page.url())) { saveState({ loggedIn: false }); return { ok: false, reason: 'session-expired', items: [] } }
    const items = await page.evaluate((max) => {
      const out = []
      const seen = new Set()
      const nodes = Array.from(document.querySelectorAll('div,li,article')).filter((el) => {
        const t = (el.innerText || '').trim()
        return t.length > 8 && t.length < 400 && !el.querySelector('div')
      })
      for (const el of nodes) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
        if (seen.has(t)) continue
        seen.add(t)
        out.push({ text: t.slice(0, 200) })
        if (out.length >= max) break
      }
      return out
    }, Math.max(1, Math.min(30, limit)))
    saveState({ lastCommentsAt: new Date().toISOString() })
    appendEvent({ kind: 'comments', count: items.length })
    let wrote = 0
    if (remember && items.length) {
      try {
        addMemory('她抖音作品下的评论：' + items.slice(0, 5).map((x) => x.text).join('；').slice(0, 240), { importance: 66, scope: 'douyin', config })
        wrote = 1
      } catch {}
    }
    return { ok: true, items, wrote }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), items: [] }
  } finally { await page.close().catch(() => {}) }
}
