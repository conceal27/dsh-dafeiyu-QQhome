/**
 * lib/videogen.mjs — 生视频（火山方舟 Seedance，异步任务）
 * ============================================================================
 * 和生图最大的区别：这是「提交任务 → 轮询 → 拿 URL」，几十秒到几分钟，不能同步等。
 *
 * 接口（方舟 v3）：
 *   POST /contents/generations/tasks   { model, content:[{type:'text',text:'... --ratio 16:9 --dur 5'}] }
 *   GET  /contents/generations/tasks/{id}  → { status, content:{ video_url } }
 *
 * 价格按秒算，别拿它刷着玩；默认 5 秒 720p。
 * ============================================================================
 */
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seedance-1-0-pro-250528'

function apiKey(config = {}) {
  return String(config.videoGenKey || config.imageGenKey || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY || '').trim()
}

async function req(path, { method = 'GET', body, key, timeoutMs = 60_000 } = {}) {
  if (!key) return { ok: false, error: '没有方舟 API key（config.videoGenKey / ARK_API_KEY / VOLC_ARK_API_KEY 都空）' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(ARK_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch {}
    if (!r.ok) {
      const msg = (j && (j.error && (j.error.message || j.error.code))) || text.slice(0, 300)
      return { ok: false, status: r.status, error: String(msg) }
    }
    return { ok: true, data: j }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 提交一个视频任务 */
export async function createVideoTask({ prompt, model, ratio = '16:9', duration = 5, resolution = '720p', imageUrl, config = {}, log } = {}) {
  const key = apiKey(config)
  const text = String(prompt || '').trim()
  if (!text) return { ok: false, error: '没有提示词' }
  const flags = []
  if (ratio) flags.push('--ratio ' + ratio)
  if (duration) flags.push('--dur ' + Math.max(2, Math.min(12, Number(duration) || 5)))
  if (resolution) flags.push('--resolution ' + resolution)
  if (!/--wm/.test(text)) flags.push('--wm false')
  const content = [{ type: 'text', text: text + ' ' + flags.join(' ') }]
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: String(imageUrl) } })
  const r = await req('/contents/generations/tasks', {
    method: 'POST',
    body: { model: String(model || config.videoGenModel || DEFAULT_MODEL), content },
    key,
  })
  if (!r.ok) return { ok: false, error: r.error, stage: 'create' }
  const id = r.data && r.data.id
  if (!id) return { ok: false, error: '没拿到任务 id', raw: r.data }
  log && log.info && log.info('[生视频] 任务已提交 ' + id)
  return { ok: true, taskId: id, model: String(model || config.videoGenModel || DEFAULT_MODEL) }
}

/** 查一个任务 */
export async function queryVideoTask(taskId, { config = {} } = {}) {
  const r = await req('/contents/generations/tasks/' + encodeURIComponent(String(taskId)), { key: apiKey(config), timeoutMs: 30_000 })
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.data || {}
  const url = (d.content && (d.content.video_url || d.content.url)) || (d.video_url || '')
  return {
    ok: true,
    status: String(d.status || ''),
    videoUrl: url,
    error: d.error ? String((d.error.message || d.error.code || '') ) : '',
    raw: d,
  }
}

/** 提交并等结果（默认最多 6 分钟） */
export async function generateVideo({ prompt, config = {}, log, timeoutMs = 6 * 60_000, pollMs = 5_000, ...opts } = {}) {
  const t0 = Date.now()
  const created = await createVideoTask({ prompt, config, log, ...opts })
  if (!created.ok) return { ok: false, error: created.error, stage: created.stage || 'create', ms: Date.now() - t0 }
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs))
    const q = await queryVideoTask(created.taskId, { config })
    if (!q.ok) { last = q; continue }
    last = q
    if (q.status === 'succeeded' && q.videoUrl) {
      log && log.info && log.info('[生视频] 完成 ' + Math.round((Date.now() - t0) / 1000) + 's')
      return { ok: true, taskId: created.taskId, videoUrl: q.videoUrl, model: created.model, ms: Date.now() - t0 }
    }
    if (q.status === 'failed') {
      return { ok: false, taskId: created.taskId, error: q.error || '任务失败', stage: 'run', ms: Date.now() - t0 }
    }
  }
  return { ok: false, taskId: created.taskId, error: '等待超时（任务可能还在跑，用 taskId 再查）', stage: 'timeout', status: last && last.status, ms: Date.now() - t0 }
}

export function videoStatus(config = {}) {
  return {
    ok: true,
    enabled: config.videoGenEnabled !== false,
    model: String(config.videoGenModel || DEFAULT_MODEL),
    hasKey: !!apiKey(config),
    defaultDuration: Number(config.videoGenDuration || 5),
    defaultRatio: String(config.videoGenRatio || '16:9'),
  }
}
