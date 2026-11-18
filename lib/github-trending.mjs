/**
 * lib/github-trending.mjs — GitHub 今日趋势
 * ============================================================================
 * 她以前在 AstrBot 里靠 github_trending 插件看这个，迁过来后没有对等能力。
 * 直接抓 https://github.com/trending，按 Box-row 切块解析仓库名 / 描述 / star。
 * ============================================================================
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
}

/**
 * @param {{since?:'daily'|'weekly'|'monthly', language?:string, n?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean,items?:Array<{repo:string,desc:string,lang:string,stars:string,today:string,url:string}>,error?:string,since?:string}>}
 */
export async function githubTrending(opts = {}) {
  const since = ['daily', 'weekly', 'monthly'].includes(opts.since) ? opts.since : 'daily'
  const n = Math.max(1, Math.min(15, Number(opts.n) || 8))
  const qs = new URLSearchParams({ since })
  if (opts.language) qs.set('language', String(opts.language))
  const url = 'https://github.com/trending?' + qs.toString()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(5000, Number(opts.timeoutMs) || 15_000))
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: ac.signal })
    if (!res.ok) return { ok: false, error: 'GitHub 返回 HTTP ' + res.status }
    const html = await res.text()
    const items = []
    for (const block of html.split('Box-row').slice(1)) {
      if (items.length >= n) break
      const repoM = /href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/stargazers"/.exec(block)
      if (!repoM) continue
      const repo = repoM[1] + '/' + repoM[2]
      if (items.some((x) => x.repo === repo)) continue
      const descM = /<p class="col-9 color-fg-muted my-1[^"]*">([\s\S]*?)<\/p>/.exec(block)
      const langM = /itemprop="programmingLanguage">([^<]+)</.exec(block)
      const starM = /aria-label="star"[\s\S]*?>\s*([\d,]+)\s*<\/a>/.exec(block)
      const todayM = /([\d,]+)\s*stars?\s+today/i.exec(block)
      items.push({
        repo,
        desc: decodeEntities(String(descM ? descM[1] : '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160),
        lang: langM ? String(langM[1]).trim() : '',
        stars: starM ? String(starM[1]) : '',
        today: todayM ? String(todayM[1]) : '',
        url: 'https://github.com/' + repo,
      })
    }
    if (!items.length) return { ok: false, error: '页面结构变了，一个仓库都没解析出来' }
    return { ok: true, items, since }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/** 拼成一段能直接说出口的中文 */
export function formatTrending(r, n = 6) {
  if (!r || !r.ok) return null
  const label = r.since === 'weekly' ? '这周' : r.since === 'monthly' ? '这个月' : '今天'
  const lines = [`GitHub ${label}涨得最凶的：`]
  for (const it of r.items.slice(0, n)) {
    lines.push(`· ${it.repo}${it.lang ? '（' + it.lang + '）' : ''}${it.stars ? ' ★' + it.stars : ''}${it.today ? ' 今日+' + it.today : ''}`)
    if (it.desc) lines.push('  ' + it.desc)
  }
  return lines.join('\n')
}
