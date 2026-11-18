/**
 * lib/draw.mjs — 生图（火山方舟 ARK · doubao-seedream）
 * ============================================================================
 * 为什么要独立成模块：她以前在 AstrBot 里靠 llm_draw_plus / dfy_volc_gen 两个插件画图，
 * 迁过来以后没有对等能力，被问「画一个」就只能嘴上答应。
 *
 * 配置：$DSH_HOME/qq-fish/draw.json（独立文件，不走 config.json 的白名单，
 *       免得像 ttsProvider 那样被 saveConfig 静默丢掉）
 *   { enabled, provider:'ark', apiKey, model, size, watermark, timeoutMs }
 *
 * 返回 base64 而不是落盘：skill 结果直接交给 bridge.sendImage('base64://…')，
 * 不用依赖公网可访问的图床。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { stylePrompt, styleRefFiles, selfRefFiles, LOOK_LOCK, OUTFIT_RULE } from './imagegen.mjs'

const DEFAULT = {
  enabled: true,
  provider: 'ark',
  apiKey: '',
  model: 'doubao-seedream-4-0-20260415',
  size: '1024x1024',
  watermark: false,
  timeoutMs: 120_000,
  selfPrompt: '',
}

export function drawProfilePath(home = os.homedir()) {
  // skill 传进来的 home 可能是三种之一：用户家目录 / DSH_HOME / qq-fish 目录本身
  const h = String(home || '').replace(/\/+$/, '')
  if (h.endsWith('qq-fish')) return path.join(h, 'draw.json')
  if (h.endsWith('.dsh')) return path.join(h, 'qq-fish', 'draw.json')
  return path.join(h || os.homedir(), '.dsh', 'qq-fish', 'draw.json')
}

export function loadDrawProfile(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(drawProfilePath(home), 'utf8')) || {}
    const out = { ...DEFAULT }
    for (const k of Object.keys(DEFAULT)) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') out[k] = raw[k]
    }
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    return out
  } catch {
    return { ...DEFAULT }
  }
}

/**
 * 生成一张图。
 * @param {string} prompt 画面描述
 * @param {{home?:string,size?:string,model?:string,signal?:AbortSignal}} [opts]
 * @returns {Promise<{ok:boolean,b64?:string,mime?:string,model?:string,size?:string,ms?:number,error?:string,code?:number}>}
 */
export async function generateImage(prompt, opts = {}) {
  const t0 = Date.now()
  const text = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  if (!text) return { ok: false, error: '没说要画什么' }
  const prof = loadDrawProfile(opts.home)
  if (!prof.enabled) return { ok: false, error: '生图没开（draw.json 里 enabled=false）' }
  const key = String(prof.apiKey || '').trim()
  if (!key) return { ok: false, error: '还没配生图密钥（draw.json 里没有 apiKey）' }

  // 【画风】2026-11-16 补：这里原来把 prompt 原样透传，既没拼 style.json 的画风段，
  // 也不带画风样张 → 出来的图是模型默认的插画感，跟「真人 cos 自拍」完全是两回事。
  // 现在：① 提示词末尾补 stylePrompt()（读 ~/.dsh/qq-fish/style.json）；
  //       ② 参考图带上她的形象图 + 画风样张（三级降级：全带 → 只画风 → 纯文生图）。
  let promptText = text
  // 【统一提示词结构·2026-11-17 下午】
  // 问题：以前「固定形象」只在 skills.mjs 命中「自拍/鲸鱼娘/大肥鱼」等关键词时才注入，
  // 用户说「画个你在窗台啃吐司」这种不含关键词的话，形象描述整段丢失（实测只剩 360 字），
  // 跟空间配图（905 字、内容齐全）完全两套。现在无论说什么，都按空间那条链路的结构拼。
  try {
    if (!promptText.includes('【衣服·优先于一切参考图】')) {
      const { buildImagePrompt } = await import('./imagegen.mjs')
      let stateBit = ''
      try {
        const { selfStateLine } = await import('./selfstate.mjs')
        stateBit = selfStateLine(opts.home)
      } catch {}
      promptText = buildImagePrompt({
        look: herLook(opts.home), stateLine: stateBit, scene: text,
      })
    }
  } catch {}
  try {
    const sp = String(stylePrompt(opts.home) || '').trim()
    if (sp && !promptText.includes(sp)) promptText = promptText + '。' + sp
  } catch {}

  const toDataUrl = (f) => {
    try {
      const b = fs.readFileSync(f)
      const ext = String(f).toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
      return 'data:image/' + ext + ';base64,' + b.toString('base64')
    } catch { return '' }
  }
  const selfRefs = (() => {
    try { return (selfRefFiles(opts.home) || []).slice(0, 1).map(toDataUrl).filter(Boolean) } catch { return [] }
  })()
  const styleRefs = (() => {
    try { return (styleRefFiles(opts.home) || []).slice(0, 1).map(toDataUrl).filter(Boolean) } catch { return [] }
  })()
  // 【参考图顺序】2026-11-16 实测：只带「画风样张」出的图最像真人 cos 自拍；
  // 一旦把她那张 AI 生成的「形象图」也塞进去，脸会被拉回娃娃/CG 感（两版对比过）。
  // 所以顺序改成：先只带画风样张 → 再试样张+形象图 → 都不行纯文生图。
  // 想反过来（更像她本人、但更 CG）就把 draw.json 的 useSelfRefFirst 设成 true。
  let selfFirst = false
  try { selfFirst = prof.useSelfRefFirst === true } catch {}
  const refSets = []
  const both = (selfRefs.length && styleRefs.length) ? [...selfRefs, ...styleRefs] : []
  const styleOnly = styleRefs.length ? [...styleRefs] : []
  const selfOnly = selfRefs.length ? [...selfRefs] : []
  if (selfFirst) {
    if (both.length) refSets.push(both)
    if (styleOnly.length) refSets.push(styleOnly)
  } else {
    if (styleOnly.length) refSets.push(styleOnly)
    if (both.length) refSets.push(both)
  }
  if (!refSets.length && selfOnly.length) refSets.push(selfOnly)

  const baseBody = {
    model: String(opts.model || prof.model || DEFAULT.model),
    prompt: promptText,
    size: String(opts.size || prof.size || DEFAULT.size),
    response_format: 'b64_json',
    watermark: prof.watermark === true,
  }
  const body = { ...baseBody }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(20_000, Number(prof.timeoutMs) || 120_000))
  try {
    const ARK = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    const attempt = async (payload) => {
      const res = await fetch(ARK, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(payload),
        signal: opts.signal || ac.signal,
      })
      const j = await res.json().catch(() => null)
      const item = (j && j.data && j.data[0]) || {}
      const b64 = String(item.b64_json || '').trim()
      if (res.ok && b64) return { ok: true, j, item, b64 }
      const msg = (j && (j.error && (j.error.message || j.error.code) || j.message)) || ('HTTP ' + res.status)
      return { ok: false, j, error: String(msg).slice(0, 200) }
    }
    let lastErr = ''
    let hit = null
    for (const refs of refSets) {
      const r = await attempt({ ...baseBody, image: refs })
      if (r.ok) { hit = { ...r, usedRefs: refs.length }; break }
      lastErr = r.error
    }
    if (!hit) {
      const r = await attempt({ ...baseBody })
      if (!r.ok) return { ok: false, code: r.j && r.j.error && r.j.error.code, error: r.error || lastErr || '生图失败' }
      hit = r
    }
    const j = hit.j || {}
    const item = hit.item || {}
    const b64 = hit.b64
    return {
      ok: true, b64, mime: 'image/jpeg',
      model: j.model || baseBody.model, size: item.size || baseBody.size,
      usedRefs: hit && hit.usedRefs ? hit.usedRefs : 0,
      ms: Date.now() - t0,
    }
  } catch (e) {
    const aborted = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))))
    return { ok: false, error: aborted ? '画太久超时了' : String((e && e.message) || e).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}
