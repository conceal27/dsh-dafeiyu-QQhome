/**
 * lib/search.mjs — 联网搜索（免 key）
 * ============================================================================
 * 之前只有 DuckDuckGo HTML 版一个源：中文结果差、经常被限流返回验证页，
 * 而且只能拿到标题和摘要——等于只给她看目录，看不到内容。
 *
 * 现在：
 *   1. DuckDuckGo 主搜
 *   2. 空了或者报错 → Bing 中文兜底
 *   3. 新增 fetchPage()：真把网页正文抓下来，她才能"看过"而不只是"搜到"
 * ============================================================================
 */
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

/** 判断一条消息是不是"需要查资料" */
export function looksLikeSearch(text) {
  const t = String(text || '')
  if (t.length < 3 || t.length > 200) return null
  if (/搜一下|查一下|搜搜|帮我查|百度一下|谷歌一下|网上查/.test(t)) {
    return t.replace(/搜一下|查一下|搜搜|帮我查|百度一下|谷歌一下|网上查|一下/g, '').trim().slice(0, 60) || t.slice(0, 60)
  }
  if (/是什么|是谁|多少钱|几年|哪年|什么时候|怎么用|为什么|是不是真的/.test(t) && t.length <= 60) {
    return t.replace(/[？?。！!]/g, '').trim().slice(0, 60)
  }
  return null
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
}

async function timedFetch(url, timeoutMs, headers = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function duck(query, limit, timeoutMs) {
  const res = await timedFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), timeoutMs)
  if (!res.ok) return []
  const html = await res.text()
  const results = []
  const blocks = html.split(/class="result__body"/).slice(1)
  for (const b of blocks) {
    if (results.length >= limit) break
    const href = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/.exec(b)
    const title = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    if (!href) continue
    let u = decodeHtml(href[1])
    const m = /uddg=([^&]+)/.exec(u)
    if (m) { try { u = decodeURIComponent(m[1]) } catch {} }
    if (!/^https?:/i.test(u)) continue
    const t = decodeHtml(title ? title[1] : '')
    if (!t) continue
    results.push({ title: t.slice(0, 100), url: u, snippet: decodeHtml(snippet ? snippet[1] : '').slice(0, 200) })
  }
  return results
}

async function bing(query, limit, timeoutMs) {
  const res = await timedFetch('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&mkt=zh-CN&setlang=zh-CN&ensearch=0', timeoutMs)
  if (!res.ok) return []
  const html = await res.text()
  const results = []
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const b of blocks) {
    if (results.length >= limit) break
    // Bing 的结构是 <a href=...><h2>标题</h2></a>：链接在 h2 **前面**，
    // 从 h2 往前找最近的 <a>，别再往 h2 里面找（会一个都匹配不到）。
    const h2i = b.indexOf('<h2')
    const t = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(b)
    if (h2i < 0 || !t) continue
    const aIdx = b.lastIndexOf('<a ', h2i)
    if (aIdx < 0) continue
    const hm = /href="(https?:\/\/[^"]+)"/.exec(b.slice(aIdx, aIdx + 400))
    if (!hm) continue
    const u = decodeHtml(hm[1])
    if (!/^https?:/i.test(u)) continue
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b.slice(h2i))
    const title = decodeHtml(t[1])
    if (!title) continue
    results.push({
      title: title.slice(0, 100),
      url: u,
      snippet: decodeHtml(snip ? snip[1] : '').slice(0, 200),
    })
  }
  return results
}

/** 搜索。返回 { ok, results, provider } */
export async function webSearch(query, { limit = 4, timeoutMs = 10000 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'empty query', results: [] }

  let lastErr = ''
  for (const [name, fn] of [['bing', bing], ['duckduckgo', duck]]) {
    try {
      const results = await fn(q, limit, timeoutMs)
      if (results.length) return { ok: true, results, provider: name }
      lastErr = lastErr || (name + ' 没结果')
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? (name + ' 超时') : (name + '：' + String((e && e.message) || e))
    }
  }
  return { ok: false, error: lastErr || 'no results', results: [] }
}

/**
 * 抓网页正文。她"搜到"和"看过"是两回事——只给标题摘要，她只能复述目录。
 * 限制长度，避免把整站塞进 prompt。
 */
export async function fetchPage(url, { maxChars = 1500, timeoutMs = 9000 } = {}) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'bad url', text: '' }
  try {
    const res = await timedFetch(u, timeoutMs)
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, text: '' }
    const ct = String(res.headers.get('content-type') || '')
    if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { ok: false, error: 'not html', text: '' }
    const html = await res.text()
    // 去掉导航/页脚这类噪声：优先取 article/main，取不到再退回全文
    let body = html
    const art = /<article[\s\S]*?<\/article>/i.exec(html) || /<main[\s\S]*?<\/main>/i.exec(html)
    if (art) body = art[0]
    // 段落化：把 <p> / <br> 换成换行，再剥标签
    const text = decodeHtml(
      body.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'),
    )
    // 【反爬检测】百度/知乎等会返回"安全校验中"的空壳页，抓到这种等于没抓到
    if (text.length < 80 || /安全校验|人机验证|访问验证|请稍后|验证码|Checking your browser|Just a moment|Access denied/i.test(text.slice(0, 300))) {
      return { ok: false, error: 'blocked or empty', text: '' }
    }
    return { ok: true, text: text.slice(0, maxChars), url: u }
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e), text: '' }
  }
}

/** 把结果格式化成给模型看的片段（控制长度） */
export function formatResults(r, maxChars = 700) {
  if (!r || !r.ok || !r.results || !r.results.length) return ''
  const lines = r.results.slice(0, 3).map((x, i) => `${i + 1}. ${x.title}${x.snippet ? '：' + x.snippet : ''}`)
  return lines.join('\n').slice(0, maxChars)
}
