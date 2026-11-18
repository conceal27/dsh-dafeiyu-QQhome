/**
 * lib/bili/daily.mjs — B站日报（归属：xingzhu）
 * ============================================================================
 * 让她有自己的「外部生活」：每天去 B 站逛一圈，按主人口味挑几个视频，
 * 用自己的语气写一份日报——不是冷冰冰的列表，是她「今天看到了什么、为什么想给你看」。
 *
 * 数据来源（都已验证在当前服务器可用，无需登录）：
 *   · 热门：/x/web-interface/ranking/v2
 *   · 搜索：/x/web-interface/search/type
 *   · 分区新视频：/x/web-interface/newlist
 *
 * 字幕拿不到（需要 wbi 签名 + 登录），所以用「标题 + 简介 + 分区 + 播放量」做摘要。
 *
 * 存储：$DSH_HOME/qq-fish/bili-daily.json
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateText } from '../llm.mjs'

export const BILI_DAILY_VERSION = 1
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export function biliDailyPath(stateHome) {
  return path.join(stateHome, 'bili-daily.json')
}

export function createEmptyBiliDaily() {
  return { version: BILI_DAILY_VERSION, reports: [] }
}

export function loadBiliDaily(diskPath) {
  try {
    if (!fs.existsSync(diskPath)) return createEmptyBiliDaily()
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    return { version: BILI_DAILY_VERSION, reports: Array.isArray(raw && raw.reports) ? raw.reports : [] }
  } catch {
    return createEmptyBiliDaily()
  }
}

export function saveBiliDaily(diskPath, data) {
  try {
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const tmp = diskPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, diskPath)
  } catch {}
}

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const j = await res.json()
    if (!j || j.code !== 0) return null
    return j.data
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function normalizeVideo(v) {
  if (!v) return null
  const bv = String(v.bvid || v.bv_id || '').trim()
  const title = String(v.title || '').replace(/<[^>]+>/g, '').trim()
  if (!title) return null
  return {
    bv,
    title: title.slice(0, 120),
    up: String((v.owner && v.owner.name) || v.author || v.up_name || '').slice(0, 40),
    desc: String(v.desc || '').replace(/<[^>]+>/g, '').slice(0, 300),
    tname: String(v.tname || '').slice(0, 20),
    play: Number(v.stat && v.stat.view) || Number(v.play) || 0,
    like: Number(v.stat && v.stat.like) || 0,
    url: bv ? 'https://www.bilibili.com/video/' + bv : '',
  }
}

/** 热门榜 */
export async function fetchRanking(limit = 20) {
  const data = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all')
  const list = (data && data.list) || []
  return list.map(normalizeVideo).filter(Boolean).slice(0, limit)
}

/** 搜索（默认按播放量排序） */
export async function searchVideos(keyword, limit = 20) {
  const kw = encodeURIComponent(String(keyword || '').trim())
  if (!kw) return []
  const data = await getJson('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + kw + '&order=click&page=1')
  const list = (data && data.result) || []
  return list.map(normalizeVideo).filter(Boolean).slice(0, limit)
}

/**
 * 按口味挑视频。
 * @param {object} opts { keywords: string[], exclude: string[], limit }
 */
export async function pickVideos(opts = {}) {
  const keywords = (Array.isArray(opts.keywords) ? opts.keywords : []).map((s) => String(s).trim()).filter(Boolean)
  const exclude = (Array.isArray(opts.exclude) ? opts.exclude : []).map((s) => String(s).trim()).filter(Boolean)
  const limit = Math.max(1, Math.min(12, Number(opts.limit) || 6))

  const seen = new Set()
  const picked = []
  const push = (v) => {
    if (!v || !v.title) return
    const key = v.bv || v.title
    if (seen.has(key)) return
    if (exclude.some((x) => v.title.includes(x))) return
    seen.add(key)
    picked.push(v)
  }

  // 有口味关键词就搜，没有就用热门
  if (keywords.length) {
    for (const kw of keywords.slice(0, 4)) {
      const list = await searchVideos(kw, 12)
      for (const v of list) {
        if (picked.length >= limit) break
        push(v)
      }
      if (picked.length >= limit) break
    }
  }
  if (picked.length < limit) {
    const hot = await fetchRanking(20)
    for (const v of hot) {
      if (picked.length >= limit) break
      push(v)
    }
  }
  return picked.slice(0, limit)
}

function formatPlay(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}

/**
 * 生成日报正文（用她的语气）。
 */
export async function generateReport(ctx, opts) {
  const { config, log } = opts
  const videos = Array.isArray(opts.videos) ? opts.videos : []
  if (!videos.length) return { ok: false, text: '', error: '今天没挑到视频' }

  const list = videos
    .map((v, i) => {
      const lines = [i + 1 + ". 《" + v.title + "》 UP：" + (v.up || "未知") + " 播放：" + formatPlay(v.play)]
      // 【关键】有字幕就把视频里真正说的话给她看，这样她写的是真感想而不是猜标题
      if (v.subtitle && String(v.subtitle).trim()) {
        lines.push("  视频内容（字幕节选）：" + String(v.subtitle).slice(0, 600))
      } else if (v.desc) {
        lines.push("  简介：" + String(v.desc).slice(0, 200))
      }
      if (Array.isArray(v.comments) && v.comments.length) {
        lines.push("  热评：" + v.comments.slice(0, 2).map((c) => String(c.text || "").slice(0, 60)).join(" / "))
      }
      return lines.join("\n")
    })
    .join('\n')

  const persona = String(opts.personaName || '小肥鱼')
  const system = [
    '你是' + persona + '，今天去 B 站逛了一圈，要跟主人汇报你看到的东西。',
    '用你自己的语气写，像朋友安利，不是新闻播报。可以吐槽、可以兴奋、可以嫌弃某个视频太水。',
    '下面是视频里真正说过的内容（字幕节选）。基于这些内容写，别提你没看到的东西。',
    '挑 3～5 个最想给主人看的，每个用一两句话说说「里面讲了什么、你为什么想让他看」。最后可以有一句总结。',
    '不要罗列全部，不要写「以下是我今天看的视频」这种格式话。150～300 字。只输出正文。',
  ].join('\n')

  try {
    const result = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '今天刷到的视频：\n' + list + '\n\n写今天的 B 站日报。' }],
      config,
      temperature: 1.1,
      timeoutMs: 60_000,
      log: (line) => log && log.warn && log.warn(line),
    })
    const text = String((result && result.text) || '').trim()
    if (!text) return { ok: false, text: '', error: '模型没写出东西' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e) }
  }
}

export function appendReport(data, report) {
  const item = {
    id: 'b-' + Date.now().toString(36),
    date: String(report.date || ''),
    text: String(report.text || '').slice(0, 4000),
    videos: Array.isArray(report.videos) ? report.videos : [],
    createdAt: Date.now(),
  }
  const next = { ...data, reports: [...(data.reports || []), item] }
  next.reports = next.reports.slice(-60)
  return next
}

export function latestReport(data) {
  const list = (data.reports || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return list[0] || null
}

export function needsDailyReport(data, now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  return !(data.reports || []).some((r) => r.date === today)
}
