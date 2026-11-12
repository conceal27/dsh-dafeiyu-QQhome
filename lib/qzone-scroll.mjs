/**
 * lib/qzone-scroll.mjs — 「她自己刷 QQ 空间」（v3）
 * ============================================================================
 * 每 1~2 小时她自己翻一遍：自己空间的旧说说（含别人留的评论）、主人的空间、
 * 好友的空间。逐条看，有兴趣的点赞 / 留句话，没兴趣划过去。
 *
 * v3 改动：不再要求模型输出结构化动作行（它不照做）。
 *   改成「一条一条给她看」，每条只问一句：想点赞？想说话？还是划过去。
 *   模型回 [赞] → 点赞；回一句话 → 点赞 + 评论；回 [跳过] → 换下一条。
 *
 * 状态：~/.dsh/qq-fish/qzone/scroll.json
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from './llm.mjs'
import { systemPrompt, cleanReply } from './persona.mjs'
import { stateHome } from './store.mjs'
import { readMood } from './vitals.mjs'
import { renderMoodPrompt } from './sc/mood.mjs'
import { likeFeed, commentFeed, replyFeed, extractQzoneDirectives } from './qzone.mjs'

const VERSION = 1
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function stamp(ms) {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function ago(ms, now) {
  if (!ms) return '时间不明'
  const m = Math.round((now - ms) / 60000)
  if (m < 60) return m + ' 分钟前'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.round(h / 24) + ' 天前'
}
function dir(home) {
  return join(home, 'qzone')
}
function pathOf(home) {
  return join(dir(home), 'scroll.json')
}
export function loadScrollState(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    return {
      version: VERSION,
      items: Array.isArray(j.items) ? j.items : [],
      lastAt: Number(j.lastAt) || 0,
      nextAt: Number(j.nextAt) || 0,
      lastSkipAt: Number(j.lastSkipAt) || 0,
    }
  } catch {
    return { version: VERSION, items: [], lastAt: 0, nextAt: 0, lastSkipAt: 0 }
  }
}
function save(home, st) {
  try {
    mkdirSync(dir(home), { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ ...st, items: st.items.slice(-300) }, null, 2))
  } catch {}
}

async function friendList(bridge) {
  try {
    const r = await bridge.call('get_friend_list', {})
    const arr = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : [])
    return arr
      .map((x) => ({ uin: String(x.user_id || x.uin || '').replace(/\D/g, ''), name: String(x.nickname || x.remark || x.card || '') }))
      .filter((x) => x.uin)
  } catch {
    return []
  }
}

/** 从她的一句话里判断意图 */
function readIntent(text) {
  const t = String(text || '').trim()
  if (!t) return { kind: 'skip' }
  if (/^\[?\s*(跳过|skip|划走|没兴趣)\s*\]?[。.!！]?$/i.test(t)) return { kind: 'skip' }
  const likeOnly = /^\[?\s*(赞|点赞|like|点了个赞|已赞)\s*\]?[。.!！]?$/i.test(t)
  if (likeOnly) return { kind: 'like' }
  // 带 [赞] 但还有话：点赞 + 评论
  const m = t.match(/[\s\S]*/)
  const body = cleanReply(t.replace(/[\[【]\s*(赞|点赞|like)\s*[\]】]/gi, '').trim(), 120)
  if (!body) return { kind: 'like' }
  return { kind: 'comment', text: body.replace(/^[：:，,。\s]+/, '').slice(0, 60) }
}

let RUNNING = false

export async function tickQzoneScroll(ctx, options = {}) {
  if (RUNNING) return { ok: true, skipped: 'busy' }
  RUNNING = true
  try {
    const config = (ctx && ctx.config) || {}
    const bridge = ctx && typeof ctx.getBridge === 'function' ? ctx.getBridge() : null
    const log = (ctx && ctx.log) || console
    const force = options.force === true
    if (!force && config.qzoneScroll === false) return { ok: true, skipped: 'off' }
    if (!bridge || bridge.state !== 'online') return { ok: true, skipped: 'bridge-offline' }

    const now = Date.now()
    const home = stateHome()
    const st = loadScrollState(home)
    const startH = Math.min(23, Math.max(0, num(config.qzoneScrollStart, 8)))
    const endH = Math.min(24, Math.max(startH + 1, num(config.qzoneScrollEnd, 24)))
    const hour = new Date(now).getHours()
    if (!force && (hour < startH || hour >= endH)) return { ok: true, skipped: 'quiet-hours' }

    const gapMs = Math.max(0.5, num(config.qzoneScrollMinGapHours, 2)) * HOUR
    if (!force && st.nextAt && now < st.nextAt) return { ok: true, skipped: 'not-yet', nextAt: st.nextAt }

    const day = dayKey(now)
    const cap = Math.max(0, Math.round(num(config.qzoneScrollMaxActions, 6)))
    const todayItems = st.items.filter((it) => it && it.day === day)
    if (!force && todayItems.length >= cap) return { ok: true, skipped: 'daily-cap' }

    const selfUin = String((bridge && bridge.selfId) || '').replace(/\D/g, '')
    const ownerQq = String(config.ownerQq || config.accessAdminId || '').replace(/\D/g, '')
    const friends = await friendList(bridge)

    const picked = []
    if (selfUin) picked.push({ uin: selfUin, name: '我自己的空间', self: true, page: Math.floor(Math.random() * 3) * 5 })
    if (ownerQq) picked.push({ uin: ownerQq, name: '主人' })
    const pool = friends.filter((f) => f.uin !== selfUin && f.uin !== ownerQq)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    for (const f of pool.slice(0, 3)) picked.push(f)

    const { qzoneFeeds } = await import('./qzone-http.mjs')
    const acted = new Set(
      st.items.filter((it) => it && it.tid && now - (it.at || 0) < 3 * DAY).map((it) => it.uin + '/' + it.tid),
    )
    const cands = []
    for (const p of picked) {
      const rows = []
      for (const pos of [p.page || 0, (p.page || 0) + 4]) {
        try {
          const r = await qzoneFeeds(bridge, { uin: p.uin, num: 4, pos })
          if (r.ok) for (const f of r.list || []) rows.push(f)
        } catch (e) {
          log.warn && log.warn('[空间·自己刷] 读 ' + (p.name || p.uin) + ' 失败：' + ((e && e.message) || e))
        }
      }
      for (const f of rows) {
        if (!f || !f.tid) continue
        const text = String(f.text || '').trim()
        const imgs = (f.images || []).length
        if (!text && !imgs) continue
        if (f.at && now - f.at > 10 * DAY) continue
        if (acted.has((f.uin || p.uin) + '/' + f.tid)) continue
        cands.push({
          uin: String(f.uin || p.uin),
          name: p.self ? '我自己' : f.name || p.name || p.uin,
          tid: f.tid,
          text: text.slice(0, 110),
          images: imgs,
          at: f.at,
          comments: Array.isArray(f.comments) ? f.comments.slice(0, 3) : [],
          self: !!p.self,
          key: String(f.uin || p.uin) + '/' + f.tid,
        })
      }
    }
    if (!cands.length) {
      st.lastSkipAt = now
      st.nextAt = Math.round(now + 45 * 60000)
      save(home, st)
      return { ok: true, skipped: 'no-posts' }
    }
    // 近的优先，但打散一点，别每次都看同一批
    cands.sort((a, b) => (b.at || 0) - (a.at || 0))
    const shortlist = cands.slice(0, 6)
    log.info && log.info('[空间·自己刷] 候选 ' + shortlist.length + ' 条：' + shortlist.map((c) => (c.text || '图').slice(0, 12)).join(' ｜ '))

    let moodLine = ''
    try { moodLine = (renderMoodPrompt(readMood(home, now)) || '').replace(/^你现在的心情状态：/m, '').trim() } catch {}

    const base = systemPrompt(config, { channel: 'qzone' }) +
      '\n\n【现在是你在自己刷 QQ 空间，不是在回主人消息】你随手翻到一条，自己在心里判断要不要理它。'

    const done = []
    const saidParts = []
    let lastModel = null
    let likes = 0
    let talks = 0
    let skips = 0
    for (const c of shortlist) {
      if (likes >= 2 && talks >= 1) break
      if (skips >= 3 && !done.length) break
      const cm = c.comments.length
        ? '\n评论：\n' + c.comments.map((x) => `· ${x.name || x.uin}：${String(x.text || '').slice(0, 40)}`).join('\n')
        : ''
      const ask = [
        `现在是 ${stamp(now)}，你在刷空间。${moodLine ? '\n你此刻的心情：' + moodLine : ''}`,
        '',
        `【${c.name} · ${ago(c.at || now, now)}${c.images ? ' · 配图 ' + c.images + ' 张' : ''}】`,
        c.text || '（只有图，没写字）',
        cm,
        '',
        '要理这条吗？只回一样：',
        '- 想点赞：回 [赞]',
        '- 想说句话：直接说你那句话（4~30 字，用你自己的口气，别带引号）',
        '- 没兴趣：回 [跳过]',
      ].join('\n')

      const out = await generateText(ctx.ctx, {
        system: base,
        messages: [{ role: 'user', content: ask }],
        config,
        timeoutMs: 45_000,
        log,
      })
      if (out && out.model) lastModel = out.model
      if (!out || out.ok !== true || !out.text) {
        log.warn && log.warn('[空间·自己刷] 生成失败：' + String((out && (out.reason || out.error)) || 'empty').slice(0, 120))
        break
      }
      const raw = cleanReply(out.text).trim()
      log.info && log.info('[空间·自己刷] 看「' + (c.text || '图').slice(0, 16) + '」→ ' + raw.replace(/\s+/g, ' ').slice(0, 80))
      const intent = readIntent(raw)

      if (intent.kind === 'skip') {
        skips++
        continue
      }
      // 先点赞（她理了这条就默认点个赞）
      if (likes < 2) {
        const r = await likeFeed(bridge, c.tid, c.uin)
        likes++
        if (r.ok) {
          done.push({ uin: c.uin, tid: c.tid, action: 'like', said: c.text.slice(0, 40) })
          log.info && log.info(`[空间·自己刷] 点赞 ${c.uin}/${c.tid} → 成功`)
        } else {
          log.warn && log.warn(`[空间·自己刷] 点赞 ${c.uin}/${c.tid} → ${r.error || r.code}`)
        }
      }
      if (intent.kind === 'comment' && talks < 1) {
        const r = await commentFeed(bridge, c.tid, intent.text, c.uin)
        talks++
        if (r.ok) {
          done.push({ uin: c.uin, tid: c.tid, action: 'comment', content: intent.text })
          saidParts.push(intent.text)
          log.info && log.info(`[空间·自己刷] 评论 ${c.uin}/${c.tid} → ${intent.text}`)
        } else {
          log.warn && log.warn(`[空间·自己刷] 评论失败 ${c.uin}/${c.tid} → ${r.error || r.code}`)
        }
      } else if (intent.kind === 'comment' || intent.kind === 'like') {
        saidParts.push(raw)
      }
    }

    // 自己空间里如果有人给她留了评论，顺手回一条
    if (!talks) {
      for (const c of shortlist.filter((x) => x.self && x.comments.length).slice(0, 2)) {
        const cmt = c.comments[c.comments.length - 1]
        if (!cmt || !cmt.tid) continue
        const ask = [
          `${cmt.name || cmt.uin} 在你自己的说说下面留言：${String(cmt.text || '').slice(0, 60)}`,
          '',
          '要回一句吗？想回就直接说那句话（4~30 字，你自己的口气）；不想理就回 [跳过]。',
        ].join('\n')
        const out = await generateText(ctx.ctx, {
          system: base,
          messages: [{ role: 'user', content: ask }],
          config,
          timeoutMs: 45_000,
          log,
        })
        const raw = out && out.ok ? cleanReply(out.text).trim() : ''
        if (!raw || readIntent(raw).kind === 'skip') continue
        const text = readIntent(raw).kind === 'comment' ? readIntent(raw).text : raw.slice(0, 60)
        const r = await replyFeed(bridge, {
          uin: c.uin,
          tid: c.tid,
          commentTid: cmt.tid,
          commentUin: cmt.uin,
          content: text,
        })
        talks++
        if (r.ok) {
          done.push({ uin: c.uin, tid: c.tid, action: 'reply', content: text })
          saidParts.push(text)
          log.info && log.info(`[空间·自己刷] 回评论 ${c.uin}/${c.tid} → ${text}`)
        } else {
          log.warn && log.warn(`[空间·自己刷] 回评论失败 → ${r.error || r.code}`)
        }
        break
      }
    }

    st.lastAt = now
    st.nextAt = Math.round(now + gapMs * (0.7 + Math.random() * 0.6))
    for (const d of done) st.items.push({ day, at: now, ...d })
    if (!done.length) st.lastSkipAt = now
    save(home, st)
    if (!done.length) return { ok: true, skipped: 'bored' }
    return { ok: true, done, said: saidParts.join(' / ').slice(0, 200), counted: done.length, model: lastModel }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    RUNNING = false
  }
}

export function scrollStatus(home, limit = 10) {
  const st = loadScrollState(home)
  return { lastAt: st.lastAt, nextAt: st.nextAt, lastSkipAt: st.lastSkipAt, items: st.items.slice(-limit).reverse() }
}
