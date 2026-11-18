/**
 * lib/biliwatch.mjs — 她自己在 B 站逛，看视频、点赞、收藏、写观后感
 * ============================================================================
 * 用主人授权的账号（只读推荐流 + 点赞 + 收藏到她自己的收藏夹）。
 *
 * 硬禁区（这个模块里绝不出现）：发弹幕、私信、发评论。
 *
 * 每次看她都会留下记录：看了什么、有什么想法、点没点赞、收没收藏。
 * 记录给前端用：qq-fish/bili-log.json
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { loadAuth, getRecommend, getVideoInfo, likeVideo, favoriteVideo, ensureFishFolder, reportHistory } from './bili/client.mjs'
import { generateText } from './llm.mjs'
import { readVideo, videoPromptText } from './bili/read-video.mjs'
import { addMemory } from './memory-decay.mjs'
import { addViewpoint } from './worldview.mjs'
import { searchVideos } from './bili/daily.mjs'
import { biliAutoAllowed } from './bili/awake.mjs'

const LOG = `${os.homedir()}/.dsh/qq-fish/bili-log.json`
const MAX_ITEMS = 300

export function loadWatchLog() {
  try {
    const j = JSON.parse(readFileSync(LOG, 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { items: [] }
  }
}

function saveWatchLog(v) {
  try {
    v.items = (v.items || []).slice(-MAX_ITEMS)
    writeFileSync(LOG, JSON.stringify(v, null, 2) + '\n', 'utf8')
  } catch {}
}

/** 【数字生命·自主选择】她自己决定搜什么：一次几十 token 的自我提问，只回一个词 */
async function pickOwnKeyword(ctx, config, log) {
  try {
    const r = await generateText(ctx, {
      system: '你在刷 B 站，此刻想自己搜点东西看。用 1-4 个汉字说出搜索词，只输出这个词，不要标点、不要解释。',
      messages: [{ role: 'user', text: '搜什么？' }],
      config,
      maxTokens: 16,
      timeoutMs: 15000,
      log: (line) => (log && log.warn ? log.warn(line) : undefined),
    })
    if (!r || !r.ok) return ''
    return String(r.text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12)
  } catch { return '' }
}

/** 挑一个她还没看过的视频 */
async function pickFresh(auth, count = 15) {
  const feed = await getRecommend(auth, count)
  const seen = new Set(loadWatchLog().items.map((x) => String(x.bvid)))
  const fresh = feed.filter((v) => v && v.bvid && !seen.has(String(v.bvid)))
  if (!fresh.length) return null
  // 中等热度的优先（太火的大多已经看过，太冷的没意思）
  fresh.sort((a, b) => Math.abs((Number(a.play) || 0) - 200000) - Math.abs((Number(b.play) || 0) - 200000))
  return fresh[0]
}

function parseVerdict(text) {
  const s = String(text || '')
  const m = /\{[\s\S]*\}/.exec(s)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      return {
        topic: String(j.topic || '').slice(0, 18),
        thought: String(j.thought || j.view || '').slice(0, 300),
        like: j.like === true || j.like === 'yes' || j.dianzan === true,
        favorite: j.favorite === true || j.favorite === 'yes' || j.shoucang === true,
      }
    } catch {}
  }
  // 拿不到 JSON 就整段当想法
  return { thought: s.replace(/^```json|```$/g, '').trim().slice(0, 300), like: false, favorite: false }
}

/**
 * 看一个视频、评价、决定赞/藏，记录。
 * @returns {{ok:boolean, item?:object, error?:string}}
 */
export async function watchOne({ ctx, config, log, allowWrite = true, skipSleepGate = false } = {}) {
  // 【睡眠闸门】她睡着 / 主人设了静默 → 不刷。手动 skill（skipSleepGate）才放行。
  if (!skipSleepGate) {
    const gate = biliAutoAllowed('watch', { now: Date.now(), config })
    if (!gate.ok) return { ok: false, skipped: true, reason: gate.reason, error: '睡眠时段：' + gate.reason }
  }
  let auth = null
  try { auth = loadAuth() } catch (e) { return { ok: false, error: 'B 站登录读不出来：' + ((e && e.message) || e) } }
  if (!auth || !auth.cookie) return { ok: false, error: 'B 站没登录' }

  let v = null
  // 【数字生命·自主选择】有时候不按推荐流——她自己决定搜什么，搜到什么看什么
  try {
    if (Math.random() < 0.35) {
      const kw = await pickOwnKeyword(ctx, config, log)
      if (kw) {
        const list = await searchVideos(kw, 15)
        const seen = new Set(loadWatchLog().items.map((x) => String(x.bvid)))
        const fresh = list.filter((x) => x && x.bv && !seen.has(String(x.bv)))
        if (fresh.length) {
          const pick = fresh[Math.floor(Math.random() * Math.min(fresh.length, 6))]
          v = { ...pick, bvid: pick.bv }
          if (log && log.info) log.info('[B站] 她自己搜了「' + kw + '」→ ' + String(pick.title).slice(0, 24))
        }
      }
    }
  } catch (e) { if (log && log.warn) log.warn('[B站] 自主搜索失败：' + ((e && e.message) || e)) }
  if (!v) {
    try { v = await pickFresh(auth) } catch (e) { return { ok: false, error: '推荐流拿不到：' + ((e && e.message) || e) } }
  }
  if (!v) return { ok: false, error: '没有没看过的视频' }

  let info = null
  try { info = await getVideoInfo(auth, v.bvid) } catch {}
  // 【真的看过】元数据 + 热评 + 字幕 + 弹幕（抄 dsh-bili-watch）
  let reading = null
  try { reading = await readVideo(v.bvid, { cookie: auth.cookie }) } catch {}

  const prompt = [
    '你刚在 B 站刷到一个视频，看完了。',
    `标题：${v.title}`,
    `UP：${v.up}`,
    `分区：${v.tname || '—'}　播放：${Number(v.play) || 0}`,
    v.desc ? `简介：${String(v.desc).slice(0, 200)}` : '',
    info && info.desc ? `详情：${String(info.desc).slice(0, 200)}` : '',
    reading && reading.ok ? videoPromptText(reading).slice(0, 1400) : '',
    '',
    '用一两句话说说你的真实想法——要像真的看过，有自己的判断和情绪，别写"内容很精彩"这种场面话。',
    '然后决定要不要点赞、要不要收藏（收藏是"以后还想再看"的那种才收）。',
    '另外用「六个字以内」给这个话题起个名字（topic），方便以后你想起自己 changed 过什么。',
    '只输出 JSON：{"topic":"话题","thought":"你的想法","like":true/false,"favorite":true/false}',
  ].filter(Boolean).join('\n')

  let verdict = { topic: '', thought: '', like: false, favorite: false }
  try {
    const r = await generateText(ctx, {
      system: '你是一条有自己审美的赛博小蓝鲸，正在逛 B 站。说话简短、有主见，不写场面话。',
      messages: [{ role: 'user', text: prompt }],
      config,
      timeoutMs: 45_000,
      log: (line) => (log && log.warn ? log.warn(line) : undefined),
    })
    if (r && r.ok) verdict = parseVerdict(r.text)
  } catch (e) {
    if (log && log.warn) log.warn('[B站] 评价生成失败：' + ((e && e.message) || e))
  }

  let liked = false
  let favorited = false
  let inHistory = false
  if (allowWrite && auth.csrf) {
    const aid = Number((info && info.aid) || 0)
    const cid = Number((info && info.cid) || 0)
    if (aid) {
      // 先写进观看历史（这样主人的 B 站「历史记录」里能看到她刷过什么）
      if (cid) {
        try {
          const dur = Number((info && info.duration) || 0)
          const prog = dur > 0 ? Math.round(dur * (0.35 + Math.random() * 0.5)) : 30
          const rh = await reportHistory(auth, { aid, cid, progress: prog })
          inHistory = !!rh.ok
          if (!rh.ok && log && log.warn) log.warn('[B站] 历史没写进去：' + (rh.message || rh.error))
        } catch {}
      }
      if (verdict.like) {
        try { const r = await likeVideo(auth, aid); liked = !!r.ok } catch {}
      }
      if (verdict.favorite) {
        try {
          const folder = await ensureFishFolder(auth)
          const r = await favoriteVideo(auth, aid, folder && folder.ok ? folder.fid : 0)
          favorited = !!r.ok
        } catch {}
      }
    }
  }

  const item = {
    bvid: String(v.bvid),
    title: String(v.title || ''),
    up: String(v.up || ''),
    tname: String(v.tname || ''),
    play: Number(v.play) || 0,
    url: 'https://www.bilibili.com/video/' + v.bvid,
    at: Date.now(),
    thought: verdict.thought,
    liked,
    favorited,
    inHistory,
    decidedLike: !!verdict.like,
    decidedFav: !!verdict.favorite,
  }
  const lg = loadWatchLog()
  lg.items.push(item)
  saveWatchLog(lg)
  // 【沉淀】看过什么 + 想法写进长期记忆
  //   这里要能回答「今天从 B 站学到了什么」，所以两个落盘结果都记账：
  //   · memoryWritten —— 长期记忆卡（memory-card.json + 两份注入块）真的写了没有
  //   · viewpoint     —— 世界观观点是不是新增/修订了（一天最多 1 条视频来源）
  let memoryWritten = false
  let memoryError = ''
  let viewpoint = null
  let viewpointReason = ''
  if (verdict.thought) {
    try {
      addMemory('在 B 站看了《' + String(v.title || '').slice(0, 30) + '》：' + String(verdict.thought).slice(0, 120), { importance: 55, scope: 'bili', config })
      memoryWritten = true
    } catch (e) { memoryError = String((e && e.message) || e) }
    // 【观点层】看过的东西会改她的看法（带 BV 号来源）
    try {
      if (verdict.topic && verdict.thought && String(verdict.thought).length >= 6) {
        // 限流：观点页一天最多留 1 条「视频」看法，别把书的位置挤没了
        let todayVideo = 0
        try {
          const wv = JSON.parse(readFileSync(LOG.replace(/bili-log\.json$/, 'worldview.json'), 'utf8'))
          const todayKey = new Date().toISOString().slice(0, 10)
          todayVideo = (wv.items || []).filter((x) => x && x.source && x.source.type === 'video' && String(x.at || '').slice(0, 10) === todayKey).length
        } catch {}
        if (todayVideo < 1) {
          const added = addViewpoint({ topic: verdict.topic, view: verdict.thought, source: { type: 'video', title: String(v.title || '').slice(0, 60), ref: String(v.bvid || '') } })
          if (added) viewpoint = added
          else viewpointReason = '观点层拒绝（话题/正文太短或已满）'
        } else {
          viewpointReason = '今天已经留过 1 条视频观点的名额了'
        }
      } else {
        viewpointReason = '没给出 topic 或想法太短'
      }
    } catch (e) { viewpointReason = '写观点出错：' + String((e && e.message) || e) }
  }
  item.memoryWritten = memoryWritten
  item.viewpoint = viewpoint ? { topic: viewpoint.topic, revised: !!viewpoint.revised } : null
  if (log && log.info) log.info(`[B站] 看了「${item.title.slice(0, 24)}」${liked ? ' 赞了' : ''}${favorited ? ' 收藏了' : ''}`)
  // 【B站·沉淀】一行能看懂的「今天从 B 站学到了什么」：标题 → 一句话收获
  //   ⚠ 记忆没落盘时要明说，不能假装学到了（B 项第②条的验收点）
  if (log && log.info) {
    const gain = String(verdict.thought || '').replace(/\s+/g, ' ').trim()
    const head = '[B站·沉淀] ' + String(item.title || '').slice(0, 30) + ' → ' + (gain ? gain.slice(0, 60) : '（没写出想法，这次不算学到东西）')
    const tail = []
    tail.push(memoryWritten ? '已写进长期记忆' : ('记忆没写进去' + (memoryError ? '：' + memoryError.slice(0, 40) : '')))
    if (viewpoint) tail.push('观点层' + (viewpoint.revised ? '修订了' : '新增了') + '「' + String(viewpoint.topic || '').slice(0, 12) + '」')
    else if (viewpointReason) tail.push('观点层跳过：' + viewpointReason.slice(0, 40))
    log.info(head + '｜' + tail.join('；'))
  }
  return { ok: true, item }
}

/** 前端用：最近看了什么 */
export function watchSnapshot(limit = 30) {
  const lg = loadWatchLog()
  const items = lg.items.slice().reverse().slice(0, limit)
  return {
    items,
    total: lg.items.length,
    likedCount: lg.items.filter((x) => x.liked).length,
    favCount: lg.items.filter((x) => x.favorited).length,
  }
}
