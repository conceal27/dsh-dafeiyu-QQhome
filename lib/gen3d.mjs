/**
 * lib/gen3d.mjs — 图生 3D（火山方舟三家的 3D 生成）
 * ============================================================================
 * 三家都在方舟上，接口形状统一：POST /contents/generations/tasks → 轮询 → 拿文件 URL
 *   · forget 优先级：豆包 Seed3D（免费额度 200 万 token）> Hyper3D-Gen2 > Hitem3D-2.0
 *   · 输入只吃图片（image_url）；要「文生 3D」就先调生图，再把图喂进来
 *   · 产物是 glb/obj 之类的模型文件（URL，24 小时左右过期），存本地要自己下
 *
 * 3D 生成是慢活：排几十秒到几分钟都正常，别同步等，走任务 + 轮询。
 * ============================================================================
 */
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

/** 按主人给的优先顺序排 */
export const MODELS = [
  { id: 'doubao-seed3d-2-0-260328', name: '豆包 Seed3D 2.0', note: '免费 200 万 tokens' },
  { id: 'hyper3d-gen2-260112', name: 'Hyper3D Gen2（影眸）', note: '免费 15 万 tokens' },
  { id: 'hitem3d-2-0-251223', name: 'Hitem3D 2.0（数美万物）', note: '免费 50 万 tokens' },
]

function apiKey(config = {}) {
  return String(config.gen3dKey || config.imageGenKey || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY || '').trim()
}

async function req(path, { method = 'GET', body, key, timeoutMs = 60_000 } = {}) {
  if (!key) return { ok: false, error: '没有方舟 API key' }
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

/** 提交一个 3D 任务（单模型，不降级） */
export async function create3dTask({ imageUrl, model, config = {}, log } = {}) {
  const key = apiKey(config)
  if (!String(imageUrl || '').trim()) return { ok: false, error: '需要一张图（imageUrl）' }
  const m = String(model || (MODELS[0] && MODELS[0].id))
  const r = await req('/contents/generations/tasks', {
    method: 'POST',
    body: { model: m, content: [{ type: 'image_url', image_url: { url: String(imageUrl) } }] },
    key,
  })
  if (!r.ok) return { ok: false, error: r.error, model: m, stage: 'create' }
  const id = r.data && r.data.id
  if (!id) return { ok: false, error: '没拿到任务 id', raw: r.data, model: m }
  log && log.info && log.info('[3D] ' + m + ' 任务已提交 ' + id)
  return { ok: true, taskId: id, model: m }
}

/** 按优先顺序试，直到有一个接单 */
export async function create3dTaskAuto({ imageUrl, config = {}, log, models } = {}) {
  const list = (models && models.length ? models : MODELS.map((x) => x.id))
  const tried = []
  for (const m of list) {
    const r = await create3dTask({ imageUrl, model: m, config, log })
    tried.push({ model: m, ok: r.ok, error: r.error })
    if (r.ok) return { ...r, tried }
  }
  return { ok: false, error: '三家都没接单', tried }
}

function pickUrl(d = {}) {
  const c = d.content || {}
  const cands = [
    c.file_url, c.model_url, c.model_file_url, c.url, c.video_url,
    d.file_url, d.model_url, d.url, d.result_url,
  ]
  for (const x of cands) if (x && String(x).startsWith('http')) return String(x)
  // 有些返回 [{url}] 形式
  const arr = c.files || c.outputs || d.outputs
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const u = typeof it === 'string' ? it : it && (it.url || it.file_url)
      if (u && String(u).startsWith('http')) return String(u)
    }
  }
  return ''
}

export async function query3dTask(taskId, { config = {} } = {}) {
  const r = await req('/contents/generations/tasks/' + encodeURIComponent(String(taskId)), { key: apiKey(config), timeoutMs: 30_000 })
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.data || {}
  return {
    ok: true,
    taskId: String(taskId),
    status: String(d.status || ''),
    fileUrl: pickUrl(d),
    usage: d.usage || null,
    error: d.error ? String(d.error.message || d.error.code || '') : '',
    raw: d,
  }
}

/** 提交 + 轮询到出文件（默认最多 8 分钟） */
export async function generate3d({ imageUrl, config = {}, log, timeoutMs = 8 * 60_000, pollMs = 6000, models, model } = {}) {
  const t0 = Date.now()
  const created = model
    ? await create3dTask({ imageUrl, model, config, log })
    : await create3dTaskAuto({ imageUrl, config, log, models })
  if (!created.ok) return { ok: false, error: created.error, tried: created.tried, ms: Date.now() - t0 }
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs))
    const q = await query3dTask(created.taskId, { config })
    if (!q.ok) { last = q; continue }
    last = q
    if (q.status === 'succeeded') {
      if (!q.fileUrl) return { ok: false, taskId: created.taskId, model: created.model, error: '成功了但没找到文件 URL', raw: q.raw, ms: Date.now() - t0 }
      log && log.info && log.info('[3D] 完成 ' + Math.round((Date.now() - t0) / 1000) + 's')
      return { ok: true, taskId: created.taskId, model: created.model, fileUrl: q.fileUrl, usage: q.usage, ms: Date.now() - t0, tried: created.tried }
    }
    if (q.status === 'failed') {
      return { ok: false, taskId: created.taskId, model: created.model, error: q.error || '任务失败', ms: Date.now() - t0 }
    }
  }
  return { ok: false, taskId: created.taskId, model: created.model, error: '等待超时（任务还在跑，用 taskId 再查）', status: last && last.status, ms: Date.now() - t0 }
}

export function gen3dStatus(config = {}) {
  return {
    ok: true,
    enabled: config.gen3dEnabled !== false,
    hasKey: !!apiKey(config),
    models: MODELS,
    defaultModel: String(config.gen3dModel || (MODELS[0] && MODELS[0].id)),
  }
}

/**
 * 把生成的模型文件存到本地：方舟给的是 zip，里面是 pbr/mesh_textured_pbr.glb
 * 不落盘的话 URL 过期就没了。
 */
export async function save3dResult({ fileUrl, taskId, config = {}, log, home } = {}) {
  const url = String(fileUrl || '').trim()
  if (!url.startsWith('http')) return { ok: false, error: '没有有效的 fileUrl' }
  const { mkdirSync, createWriteStream, readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const base = join(String(home || process.env.HOME + '/.dsh/qq-fish'), '3d')
  const name = String(taskId || ('3d-' + Date.now()))
  const dir = join(base, name)
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const zipPath = join(dir, 'result.zip')

  // 下载
  try {
    const r = await fetch(url)
    if (!r.ok) return { ok: false, error: '下载失败 http ' + r.status }
    const buf = Buffer.from(await r.arrayBuffer())
    const { writeFileSync } = await import('node:fs')
    writeFileSync(zipPath, buf)
  } catch (e) {
    return { ok: false, error: '下载异常：' + String((e && e.message) || e) }
  }

  // 解压（服务器上有 unzip）
  await new Promise((resolve) => {
    execFile('unzip', ['-o', '-q', zipPath, '-d', dir], (err) => resolve(err))
  })

  const walk = (d, out = []) => {
    let items = []
    try { items = readdirSync(d, { withFileTypes: true }) } catch { return out }
    for (const it of items) {
      const p = join(d, it.name)
      if (it.isDirectory()) walk(p, out)
      else if (/\.(glb|gltf|obj|fbx)$/i.test(it.name)) out.push(p)
    }
    return out
  }
  const models = walk(dir)
  const glb = models.find((p) => /\.glb$/i.test(p)) || models[0] || ''
  let bytes = 0
  try { bytes = glb ? statSync(glb).size : 0 } catch {}
  log && log.info && log.info('[3D] 已保存 ' + (glb || zipPath))
  return { ok: !!glb, glbPath: glb, zipPath, dir, bytes, models }
}
