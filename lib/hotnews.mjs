/**
 * lib/hotnews.mjs — 每日热点（60s 读懂世界 + 微博热搜）
 * ============================================================================
 * 她在 AstrBot 里靠 dailyhub 的 get_daily_news 看新闻，迁过来后没有对等能力。
 * 数据源沿用旧插件配置里的 60s 服务，多主机故障切换（主站被 Cloudflare 拦时用备用）。
 * ============================================================================
 */
const HOSTS = [
  'https://60s.b23.run',
  'https://60s.viki.moe',
  'https://60s-api.114128.xyz',
  'https://60s-api-cf.114128.xyz',
]

async function getJson(pathAndQuery, timeoutMs = 12_000) {
  let lastErr = ''
  for (const host of HOSTS) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(host + pathAndQuery, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: ac.signal,
      })
      if (!res.ok) { lastErr = host + ' HTTP ' + res.status; continue }
      const j = await res.json().catch(() => null)
      if (!j) { lastErr = host + ' 不是 JSON'; continue }
      if (j.code !== undefined && Number(j.code) !== 200) { lastErr = host + ' code ' + j.code; continue }
      return { ok: true, host, data: j.data ?? j }
    } catch (e) {
      lastErr = host + ' ' + String((e && e.message) || e).slice(0, 60)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastErr || '全部数据源都连不上' }
}

/** 每天 60 秒读懂世界 */
export async function dailySixty() {
  const r = await getJson('/v2/60s')
  if (!r.ok) return r
  const d = r.data || {}
  return {
    ok: true,
    date: String(d.date || ''),
    news: Array.isArray(d.news) ? d.news.map((x) => String(x)).slice(0, 15) : [],
    tip: String(d.tip || ''),
    host: r.host,
  }
}

/** 通用榜单（知乎热榜 / 抖音热点 / EPIC 免费游戏） */
async function rankedList(path, n = 10) {
  const r = await getJson(path)
  if (!r.ok) return r
  const list = Array.isArray(r.data) ? r.data : []
  return {
    ok: true,
    items: list.slice(0, Math.max(1, Math.min(20, n))).map((x) => ({
      title: String(x.title || x.word || x.name || x.description || ''),
      hot: Number(x.hot_value || x.hot || x.hot_score || 0) || 0,
      link: String(x.link || x.url || ''),
    })).filter((x) => x.title),
  }
}
export const zhihuHot = (n = 10) => rankedList('/v2/zhihu', n)
export const douyinHot = (n = 10) => rankedList('/v2/douyin', n)
export const epicFree = (n = 5) => rankedList('/v2/epic', n)

/** 单开一个源：微/知/抖/epic */
export async function hotSource(kind = 'weibo', n = 8) {
  const k = String(kind || 'weibo').toLowerCase()
  const map = { weibo: ['微博热搜', weiboHot], zhihu: ['知乎热榜', zhihuHot], douyin: ['抖音热点', douyinHot], epic: ['EPIC 免费游戏', epicFree] }
  const hit = map[k] || map.weibo
  const r = await hit[1](n)
  if (!r.ok) return { ok: false, text: hit[0] + '连不上：' + (r.error || '') }
  if (!r.items.length) return { ok: false, text: hit[0] + '这次是空的' }
  return {
    ok: true,
    text: hit[0] + '：\n' + r.items.map((h) => '· ' + h.title + (h.hot ? '（' + fmtHot(h.hot) + '）' : '')).join('\n'),
  }
}

/** 微博热搜 */
export async function weiboHot(n = 10) {
  const r = await getJson('/v2/weibo')
  if (!r.ok) return r
  const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data && r.data.weibo) ? r.data.weibo : [])
  return {
    ok: true,
    items: list.slice(0, Math.max(1, Math.min(20, n))).map((x) => ({
      title: String(x.title || x.word || ''),
      hot: Number(x.hot_value || x.hot || 0) || 0,
      link: String(x.link || x.url || ''),
    })).filter((x) => x.title),
  }
}

function fmtHot(v) {
  const n = Number(v) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}

/**
 * 拼成一段可以直接说出口的中文（skill 的 text）
 * @param {{weibo?:boolean}} [opts]
 */
export async function dailyHotReport(opts = {}) {
  const src = String(opts.source || 'weibo').toLowerCase()
  const srcFn = { weibo: weiboHot, zhihu: zhihuHot, douyin: douyinHot, epic: epicFree }[src] || weiboHot
  const srcName = { weibo: '微博热搜', zhihu: '知乎热榜', douyin: '抖音热点', epic: 'EPIC 免费游戏' }[src] || '微博热搜'
  const [news, hot] = await Promise.all([
    dailySixty(),
    opts.weibo === false ? Promise.resolve({ ok: false }) : srcFn(6),
  ])
  if (!news.ok && !hot.ok) return { ok: false, text: '热点源都连不上了' }
  const lines = []
  if (news.ok && news.news.length) {
    lines.push(`今天（${news.date}）的六十秒早报：`)
    for (const n of news.news.slice(0, 8)) lines.push('· ' + n)
    if (news.tip) lines.push('小贴士：' + news.tip)
  }
  if (hot.ok && hot.items.length) {
    lines.push(srcName + '：')
    for (const h of hot.items) lines.push(`· ${h.title}（${fmtHot(h.hot)}）`)
  }
  return { ok: true, text: lines.join('\n') }
}
