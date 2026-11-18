/**
 * lib/sticker-classify.mjs — 表情包 AI 识别分类（多模态看图 → 情绪 + 内容标签）
 * ============================================================================
 * 干什么：
 *   把 $DSH_HOME/qq-fish/stickers/ 里的表情包逐张交给**能看图的多模态模型**
 *   （优先火山方舟 volc-ark/doubao-seed-2-1-pro-260915），让它说出
 *   这张图是什么情绪、画面上有什么，然后写回 index.json 的
 *   tags（情绪打头 + 3~6 个中文短词）、desc、mood。
 *
 * 为什么这么写：
 *   - 模型选择不走 config.modelChain（现网链首是纯文本模型，看图会白跑），
 *     而是在这里临时覆盖 modelRouting['sticker-classify']，主模型失败退 volc-ark/auto。
 *   - 图片先缩到 448px 的 JPEG 再存成 DSH 附件（GIF 取第一帧）：省 token，
 *     也避开多模态接口对 GIF/WebP 支持不一致的坑。
 *   - tags 合并时保留原有非情绪标签（包名、"本尊"这类人设标记绝不能被覆盖）。
 * ============================================================================
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { stickerDir, loadIndex } from './stickers.mjs'
import { STICKER_MOODS } from './sc/sticker-mood.mjs'
import { generateText } from './llm.mjs'

/** 首选识图模型：火山方舟 doubao-seed-2-1-pro（支持看图） */
const PRIMARY = { provider: 'volc-ark', model: 'doubao-seed-2-1-pro-260915' }
/** 主模型不可用时的兜底链（只留火山方舟，避免落到纯文本模型） */
const FALLBACK_CHAIN = 'volc-ark/auto'
/** 每张之间的间隔（限速） */
const SLEEP_MS = 800
/** 单张超时 */
const TIMEOUT_MS = 60_000
/** 失败重试次数 */
const RETRY = 1

const SYSTEM = [
  '你是表情包分类员，看图给这张表情包打标签。',
  '只输出一个 JSON，不要任何解释、不要 markdown 代码块：',
  '{"mood":"情绪","tags":["内容短词"],"desc":"画面说明"}',
  'mood 必须从这 12 个里选一个（原样照抄）：' + STICKER_MOODS.join('/'),
  'tags 给 3~6 个中文短词：写画面里真有的东西、动作或表情（如：狗头、捂脸、竖大拇指、流泪、熊猫、比耶），不要"表情包""搞笑""可爱"这类空话。',
  'desc 是一句话画面说明，20 字以内。',
].join('\n')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function indexPath() {
  return join(stickerDir(), 'index.json')
}

function saveIndexAtomic(idx) {
  const p = indexPath()
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2))
  fs.renameSync(tmp, p)
}

/** 这张图现在算不算「已打标」：mood 字段或 tags 里出现过 12 情绪之一 */
function moodOf(s) {
  const m = String((s && s.mood) || '')
  if (STICKER_MOODS.includes(m)) return m
  for (const t of Array.isArray(s && s.tags) ? s.tags : []) {
    const v = String(t)
    if (STICKER_MOODS.includes(v)) return v
  }
  return ''
}

/** 从模型输出里抠 JSON（容忍 ```json 包裹和前后废话） */
function pickJson(text) {
  const s = String(text || '')
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {}
  try {
    return JSON.parse(m[0].replace(/[‘’“”]/g, '"'))
  } catch {}
  // 兜底：只抠 mood / desc 两个字段
  const mood = (s.match(/"mood"\s*[:：]\s*"?([^"，,\n}]+)/) || [])[1]
  const desc = (s.match(/"desc"\s*[:：]\s*"?([^"\n}]+)/) || [])[1]
  return mood || desc ? { mood, desc } : null
}

function normalizeMood(raw) {
  const s = String(raw || '').replace(/\s+/g, '')
  if (!s) return ''
  if (STICKER_MOODS.includes(s)) return s
  for (const m of STICKER_MOODS) if (s.includes(m)) return m
  for (const m of STICKER_MOODS) if (s.length >= 2 && m.includes(s)) return m
  return ''
}

/** 内容标签清洗：去空白/标点、去重、不带情绪词；最终 mood + 2~5 个 = 3~6 个 */
function sanitizeTags(raw, mood) {
  const out = []
  const push = (t) => {
    const s = String(t == null ? '' : t)
      .replace(/[\s"'`，,。.、；;：:！!？?（）()\[\]【】]+/g, '')
      .trim()
    if (!s || s.length > 12) return
    if (STICKER_MOODS.includes(s)) return
    if (out.includes(s)) return
    if (out.length >= 5) return
    out.push(s)
  }
  for (const t of Array.isArray(raw) ? raw : []) push(t)
  while (out.length < 2) out.push('表情包')
  return [mood, ...out]
}

function mediaTypeOf(buf) {
  if (!buf || !buf.length) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return 'image/png'
}

/** 图片压到 448px JPEG：sharp 优先（能读 webp/gif 首帧），失败退 ffmpeg，再失败用原图 */
async function shrinkForVision(abs) {
  const buf = fs.readFileSync(abs)
  try {
    const mod = await import('sharp')
    const sharp = mod.default || mod
    const out = await sharp(buf, { animated: false })
      .rotate()
      .resize({ width: 448, height: 448, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    if (out && out.length) return { data: out, mediaType: 'image/jpeg', how: 'sharp' }
  } catch {}
  try {
    const dst = join(tmpdir(), 'sticker-cls-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.jpg')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', abs, '-vf', "scale='min(448,iw)':-2", '-frames:v', '1', '-q:v', '4', dst], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
      const d = fs.readFileSync(dst)
      try { fs.unlinkSync(dst) } catch {}
      return { data: d, mediaType: 'image/jpeg', how: 'ffmpeg' }
    }
  } catch {}
  return { data: buf, mediaType: mediaTypeOf(buf), how: 'raw' }
}

function attachmentStore(ctx) {
  let store = null
  try { store = ctx && ctx.attachments } catch {}
  if (!store && ctx && typeof ctx.get === 'function') {
    try { store = ctx.get('attachments') } catch {}
  }
  return store && typeof store.saveImage === 'function' ? store : null
}

/** 强制识图模型：覆盖本次调用的模型链（只改内存里的副本，不落盘） */
function visionConfig(config) {
  const c = { ...(config || {}) }
  c.modelRouting = { ...(c.modelRouting || {}), 'sticker-classify': { provider: PRIMARY.provider, model: PRIMARY.model } }
  c.modelChain = FALLBACK_CHAIN
  c.modelProvider = ''
  c.model = ''
  return c
}

// ══════════════════════════════════════════════════════════════════════
// 对外三个入口
// ══════════════════════════════════════════════════════════════════════

/**
 * 只识别一张（不写盘）。
 * @param {{file:string, config?:object, ctx:object, log?:Function}} o
 * @returns {Promise<{ok:boolean, file:string, mood?:string, tags?:string[], desc?:string, model?:string, raw?:string, error?:string}>}
 */
export async function classifyOne(o) {
  const { file, config, ctx, log } = o || {}
  const name = String(file || '').trim()
  if (!name) return { ok: false, file: name, error: 'file-missing' }
  const abs = join(stickerDir(), name)
  if (!fs.existsSync(abs)) return { ok: false, file: name, error: 'not-found' }

  const store = attachmentStore(ctx)
  if (!store) return { ok: false, file: name, error: 'no-attachments-service' }

  let shot = null
  try { shot = await shrinkForVision(abs) } catch (e) {
    return { ok: false, file: name, error: 'image-read-failed: ' + String((e && e.message) || e).slice(0, 120) }
  }
  if (!shot || !shot.data || !shot.data.length) return { ok: false, file: name, error: 'image-empty' }

  let ref = null
  try {
    ref = await store.saveImage({ data: new Uint8Array(shot.data), mediaType: shot.mediaType, name: 'sticker-classify' })
  } catch (e) {
    return { ok: false, file: name, error: 'save-image-failed: ' + String((e && e.message) || e).slice(0, 120) }
  }
  if (!ref) return { ok: false, file: name, error: 'save-image-empty' }

  const cfg = visionConfig(config)
  const emit = (m) => { try { log && log(m) } catch {} }
  let last = null
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    let r = null
    try {
      r = await generateText(ctx, {
        feature: 'sticker-classify',
        system: SYSTEM,
        messages: [{ role: 'user', text: '这张表情包的文件名：' + name + '\n看图后按格式输出 JSON。', images: [{ attachment: ref }] }],
        config: cfg,
        temperature: 0,
        maxTokens: 400,
        timeoutMs: TIMEOUT_MS,
        log: emit,
      })
    } catch (e) {
      r = { ok: false, reason: 'throw', message: String((e && e.message) || e) }
    }
    if (r && r.ok) {
      const j = pickJson(r.text)
      const mood = normalizeMood(j && j.mood)
      if (mood) {
        const tags = sanitizeTags(j && j.tags, mood)
        const desc = String((j && j.desc) || '').replace(/\s+/g, ' ').trim().slice(0, 60)
        const model = (r.model && (String(r.model.provider) + '/' + String(r.model.model))) || ''
        return { ok: true, file: name, mood, tags, desc, model, how: shot.how, attempt, raw: String(r.text || '').slice(0, 400) }
      }
      last = { ok: false, reason: 'mood-invalid', message: '模型没给出 12 情绪里的一个：' + String(r.text || '').slice(0, 160) }
    } else {
      last = r || { ok: false, reason: 'unknown', message: 'unknown' }
    }
    emit('[sticker-classify] ' + name + ' 第 ' + (attempt + 1) + ' 次失败：' + String((last && (last.message || last.reason)) || '未知').slice(0, 160))
    if (attempt < RETRY) await sleep(1000)
  }
  return { ok: false, file: name, error: String((last && (last.message || last.reason)) || 'failed').slice(0, 200) }
}

/**
 * 批量识别：逐张跑、每张之间 800ms，ok 的写回 index.json。
 * @param {object} ctx cordis 上下文（要有 attachments 服务）
 * @param {{limit?:number, onlyUntagged?:boolean, dry?:boolean, config?:object, log?:Function, onProgress?:Function}} opts
 */
export async function classifyBatch(ctx, opts) {
  const o = opts || {}
  const config = o.config || {}
  const dry = o.dry === true
  const onlyUntagged = o.onlyUntagged !== false
  const raw = Number(o.limit)
  const limit = Math.max(1, Math.min(200, Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : (Number(config.stickerClassifyLimit) || 20)))

  const idx = loadIndex()
  const all = Array.isArray(idx.stickers) ? idx.stickers : []
  const pool = onlyUntagged ? all.filter((s) => !moodOf(s)) : all
  const targets = pool.slice(0, limit)

  const t0 = Date.now()
  const stats = {
    total: all.length,
    candidates: pool.length,
    requested: limit,
    picked: targets.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    dry,
    onlyUntagged,
    samples: [],
    errors: [],
    ms: 0,
  }
  const emit = (m) => { try { o.log && o.log(m) } catch {} }

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i]
    let r = null
    try {
      r = await classifyOne({ file: s.file, config, ctx, log: o.log })
    } catch (e) {
      r = { ok: false, file: s.file, error: String((e && e.message) || e) }
    }
    stats.done++
    if (r && r.ok) {
      stats.succeeded++
      if (stats.samples.length < 5) {
        stats.samples.push({ file: r.file, mood: r.mood, tags: r.tags, desc: r.desc, model: r.model, raw: r.raw })
      }
      if (!dry) {
        try { writeBack(r) } catch (e) { emit('[sticker-classify] 写回失败 ' + r.file + '：' + ((e && e.message) || e)) }
      }
    } else {
      stats.failed++
      if (stats.errors.length < 5) stats.errors.push({ file: s.file, error: String((r && r.error) || 'unknown').slice(0, 160) })
    }
    try {
      o.onProgress && o.onProgress({ index: i + 1, total: targets.length, file: s.file, ok: !!(r && r.ok), mood: (r && r.mood) || '' })
    } catch {}
    if (i < targets.length - 1) await sleep(SLEEP_MS)
  }

  stats.ms = Date.now() - t0
  const st = classifyStatus(config)
  stats.tagged = st.tagged
  stats.untagged = st.untagged
  stats.counts = st.counts
  return stats
}

/** 把一条识别结果写回 index.json（保留原有非情绪标签，比如包名和「本尊」） */
function writeBack(r) {
  const idx = loadIndex()
  const list = Array.isArray(idx.stickers) ? idx.stickers : []
  const hit = list.find((s) => s.file === r.file)
  if (!hit) return false
  const keep = (Array.isArray(hit.tags) ? hit.tags : [])
    .map((t) => String(t))
    .filter((t) => !STICKER_MOODS.includes(t) && !r.tags.includes(t))
  hit.tags = [...r.tags, ...keep].slice(0, 8)
  if (r.desc) hit.desc = r.desc
  hit.mood = r.mood
  hit.classifiedAt = Date.now()
  hit.classifiedBy = String(r.model || '').slice(0, 60)
  saveIndexAtomic(idx)
  return true
}

/** 分类进度：{total, tagged, untagged, moods[], counts{}} */
export function classifyStatus(config) {
  const all = loadIndex().stickers || []
  const counts = {}
  let tagged = 0
  for (const s of all) {
    const m = moodOf(s)
    if (!m) continue
    tagged++
    counts[m] = (counts[m] || 0) + 1
  }
  return {
    total: all.length,
    tagged,
    untagged: all.length - tagged,
    moods: STICKER_MOODS,
    counts,
    enabled: !(config && config.stickerClassifyEnabled === false),
    limit: Number((config && config.stickerClassifyLimit) || 20),
    model: PRIMARY.provider + '/' + PRIMARY.model,
  }
}
