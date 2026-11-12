/**
 * lib/draw.mjs — 生图（火山方舟 ARK · doubao-seedream）
 * ============================================================================
 * 为什么要独立成模块：她以前在 AstrBot 里靠 llm_draw_plus / dfy_volc_gen 两个插件画图，
 * 迁过来以后没有对等能力，被问「画一个」就只能嘴上答应。
 *
 * 配置：$DSH_HOME/qq-fish/draw.json（独立文件，不走 config.json 的白名单，
 *       免得像 ttsProvider 那样被 saveConfig 静默丢掉）
 *   { enabled, provider:'ark', apiKey, model, size, watermark, timeoutMs, useRef }
 *
 * 形象参考图（2026-11-12）：默认带上 $DSH_HOME/qq-fish/self/ref-1.jpg 作为角色参考，
 * 保证画出来和官方形象是同一张脸。draw.json 里 "useRef": false 可以关掉。
 * 实测方舟 /images/generations 的 image 字段：data URL / http URL / 数组都行，
 * 裸 base64 会 400 InvalidParameter。
 *
 * 返回 base64 而不是落盘：skill 结果直接交给 bridge.sendImage('base64://…')，
 * 不用依赖公网可访问的图床。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { selfRefDataUrl, selfRefFiles } from './imagegen.mjs'

const DEFAULT = {
  enabled: true,
  provider: 'ark',
  apiKey: '',
  model: 'doubao-seedream-4-0-20260415',
  size: '1024x1024',
  watermark: false,
  timeoutMs: 120_000,
  selfPrompt: '',
  useRef: true,
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
      // 注意 watermark/useRef 是布尔：false 也是有效值，不能被 '' 那条筛掉
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') out[k] = raw[k]
    }
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (typeof raw.watermark === 'boolean') out.watermark = raw.watermark
    if (typeof raw.useRef === 'boolean') out.useRef = raw.useRef
    return out
  } catch {
    return { ...DEFAULT }
  }
}

/**
 * 生成一张图。
 * @param {string} prompt 画面描述
 * @param {{home?:string,size?:string,model?:string,signal?:AbortSignal,useRef?:boolean}} [opts]
 * @returns {Promise<{ok:boolean,b64?:string,mime?:string,model?:string,size?:string,ms?:number,usedRef?:boolean,error?:string,code?:number}>}
 */
export async function generateImage(prompt, opts = {}) {
  const t0 = Date.now()
  const text = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  if (!text) return { ok: false, error: '没说要画什么' }
  const prof = loadDrawProfile(opts.home)
  if (!prof.enabled) return { ok: false, error: '生图没开（draw.json 里 enabled=false）' }
  const key = String(prof.apiKey || '').trim()
  if (!key) return { ok: false, error: '还没配生图密钥（draw.json 里没有 apiKey）' }

  // 角色参考图：优先第 1 张；draw.json 的 useRef:false 或 opts.useRef:false 可关
  const wantRef = opts.useRef === false ? false : prof.useRef !== false
  const ref = wantRef ? selfRefDataUrl(opts.home, 0) : null

  const body = {
    model: String(opts.model || prof.model || DEFAULT.model),
    prompt: text,
    size: String(opts.size || prof.size || DEFAULT.size),
    response_format: 'b64_json',
    // 显式传 false：不传的话方舟默认会加右下角「AI生成」水印
    watermark: false,
  }
  if (ref) body.image = [ref]
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(20_000, Number(prof.timeoutMs) || 120_000))
  const post = async (payload) => {
    const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(payload),
      signal: opts.signal || ac.signal,
    })
    const j = await res.json().catch(() => null)
    return { res, j }
  }
  try {
    let { res, j } = await post(body)
    let usedRef = !!ref
    // 参考图被上游拒（模型不支持 image 等）时退回纯文生图一次，别让「画图」整个挂掉
    if (ref && (!res.ok || !(j && j.data && j.data[0] && j.data[0].b64_json))) {
      const plain = { ...body }
      delete plain.image
      ;({ res, j } = await post(plain))
      usedRef = false
    }
    if (!res.ok || !j) {
      const msg = (j && (j.error && (j.error.message || j.error.code) || j.message)) || ('HTTP ' + res.status)
      return { ok: false, code: j && j.error && j.error.code, error: String(msg).slice(0, 200) }
    }
    const item = (j.data && j.data[0]) || {}
    const b64 = String(item.b64_json || '').trim()
    if (!b64) {
      const err = (j.error && (j.error.message || j.error.code)) || '接口没给图'
      return { ok: false, code: j.error && j.error.code, error: String(err).slice(0, 200) }
    }
    return {
      ok: true, b64, mime: 'image/jpeg',
      model: j.model || body.model, size: item.size || body.size,
      ms: Date.now() - t0, usedRef,
    }
  } catch (e) {
    const aborted = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))))
    return { ok: false, error: aborted ? '画太久超时了' : String((e && e.message) || e).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/** 有没有可用的形象参考图（面板/日志用） */
export function hasSelfRef(home = os.homedir()) {
  return selfRefFiles(home).length > 0
}
