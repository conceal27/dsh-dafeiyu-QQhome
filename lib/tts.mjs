/**
 * lib/tts.mjs — 语音合成（双引擎：edge-tts / BreezeBlue 云端）
 * ============================================================================
 * 默认 edge-tts（免费、无需 key）；配置 ttsProvider=breeze + breezeApiKey 后
 * 走 BreezeBlue 的大肥鱼专用音色，失败自动回退 edge-tts，保证不会因为
 * 云端服务抽风而让整句话没有声音。
 *
 * BreezeBlue：POST /v1/text-to-speech/{voice_id}，Bearer 鉴权，返回 mp3。
 * 说明：中文按 2 计费单位/字，10 单位 = 1 credit；50 字回复约 10 credits。
 * ============================================================================
 */
import { pathOf } from './store.mjs'
import { execFile } from 'node:child_process'
import { readFile, unlink, mkdtemp, writeFile } from 'node:fs/promises'
import { renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
// 常用音色（面板可扩展）
export const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温暖女声（默认）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 活泼女声' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 东北女声' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西女声' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 阳光男声' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 · 可爱男声' },
]
// 双声线（借鉴 feiyu_voice 的 cute / gentle）
// 注意：风格只调语速/音量/音调，**不碰音色**——音色由 ttsVoice 决定，
// 否则「音色」下拉会被风格偷偷覆盖（以前的坑：选 sassy 就用不到你选的音色）。
export const TTS_STYLES = [
  {
    id: 'cute',
    name: '可爱（默认）',
    rate: '+12%',
    volume: '+0%',
    pitch: '+2Hz',
    desc: '偏可爱、活泼，日常聊天用',
  },
  {
    id: 'sassy',
    name: '俏皮（雌小鬼）',
    rate: '+22%',
    volume: '+3%',
    pitch: '+15Hz',
    desc: '语速更快、音调更高，带点尖锐的傲娇感',
  },
  {
    id: 'gentle',
    name: '温柔',
    rate: '-6%',
    volume: '+0%',
    pitch: '+0Hz',
    desc: '偏温柔，轻声陪伴用',
  },
  {
    id: 'sleepy',
    name: '困困的',
    rate: '-15%',
    volume: '-10%',
    pitch: '-8Hz',
    desc: '深夜/犯困时用，语速慢、声音轻',
  },
]

// ---------------- BreezeBlue ----------------
const BREEZE_BASE = 'https://api.breezeblue.ai'
// 官方为这个角色做好的两版音色（试听页见 breezeblue.ai/zh/voice-library）
export const BREEZE_VOICES = [
  { id: 'voc_u3nxkd5578wc', name: '大肥鱼 · 机灵版（清亮甜软、反应轻快）' },
  { id: 'voc_8yud7hz7c9q2', name: '大肥鱼 · 迷糊版（柔软带奶气、慢半拍）' },
]
export const TTS_PROVIDERS = [
  { id: 'edge', name: 'edge-tts（微软，免费）' },
  { id: 'breeze', name: 'BreezeBlue（云端，按字计费）' },
]

// 插件启动时会用白名单重写 config.json（自定义字段会被清掉），
// 所以 BreezeBlue 的凭据单独放在这个文件里；文件存在即启用。
const BREEZE_PROFILE = pathOf('tts-breeze.json')

async function loadBreezeProfile() {
  try {
    const raw = await readFile(BREEZE_PROFILE, 'utf8')
    const p = JSON.parse(raw)
    if (!p || p.enabled === false) return null
    return p
  } catch {
    return null
  }
}

/**
 * 给语速加一点随机抖动，避免整段声音一个调念到底（这是"机器人味"的主要来源之一）。
 * '+12%' → 在 9%~15% 之间随机。
 */
function jitterRate(rate) {
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*%?\s*$/.exec(String(rate || ''))
  const base = m ? parseFloat(m[1]) : 0
  const delta = Math.random() * 6 - 3
  const next = Math.round(base + delta)
  return (next >= 0 ? '+' : '') + next + '%'
}

function runTts(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('edge-tts', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// 复用 TLS 连接：BreezeBlue 从国内握手要 1.5~2 秒，每条语音都重连太亏
const breezeAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 4 })

function httpRequest(urlStr, { method = 'POST', headers = {}, body = '', timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let u = null
    try { u = new URL(urlStr) } catch { return resolve({ ok: false, error: 'JSON 地址不合法: ' + String(urlStr).slice(0, 80) }) }
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers,
      agent: breezeAgent,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }))
      res.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }))
    if (body) req.write(body)
    req.end()
  })
}

/**
 * BreezeBlue 合成。返回 { ok, path, bytes, dir } 或 { ok:false, error }。
 * 拿到的可能是 audio/* 二进制，也可能是 { url } JSON（两种都兼容）。
 */
/**
 * 给合成的 mp3 前后补一点静音。
 * 原因：mp3 有编码器延迟（LAME delay/padding 约 20~50ms），QQ 转 silk 再播放时
 * 常把这段「听不见」的开头和结尾裁掉——用户听到的就是「首尾各丢一个字」。
 * 补 150ms 头 + 300ms 尾后，裁掉的是静音，不是字。
 */
function padSilence(file) {
  try {
    const tmp = file + '.pad.mp3'
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', file,
      '-af', 'adelay=150|150,apad=pad_dur=0.30',
      '-c:a', 'libmp3lame', '-b:a', '96k', tmp,
    ], { timeout: 20000 })
    renameSync(tmp, file)
    return true
  } catch {
    try { unlinkSync(file + '.pad.mp3') } catch {}
    return false
  }
}

export async function synthesizeBreeze(text, { apiKey = '', voiceId = '', base = '', model = '', language = 'zh', timeoutMs = 30000 } = {}) {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '文字为空' }
  if (!apiKey) return { ok: false, error: '缺少 BreezeBlue API Key' }
  if (!voiceId) return { ok: false, error: '缺少 BreezeBlue Voice ID' }
  let dir = ''
  try {
    dir = await mkdtemp(join(tmpdir(), 'qqfish-breeze-'))
    const out = join(dir, 'voice.mp3')
    const root = String(base || BREEZE_BASE).replace(/\/+$/, '')
    // output_format 是 query 参数（body 里带会被 422 拒绝）；body 只认 text / language_code / model_id / voice_settings
    const url = root + '/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3'
    const body = { text: content }
    if (language) body.language_code = language
    if (model) body.model_id = model
    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg, application/json',
      },
      body: JSON.stringify(body),
      timeoutMs,
    })
    if (!res.ok) return { ok: false, error: 'BreezeBlue 请求失败：' + res.error, dir }
    if (res.status < 200 || res.status >= 300) {
      const detail = res.buffer.toString('utf8').slice(0, 160)
      return { ok: false, error: ('BreezeBlue ' + res.status + ': ' + detail).trim(), dir }
    }
    const ct = String(res.headers['content-type'] || '').toLowerCase()
    if (ct.includes('application/json')) {
      let j = null
      try { j = JSON.parse(res.buffer.toString('utf8')) } catch {}
      const audioUrl =
        (j && (j.url || j.audio_url)) ||
        (j && j.data && (j.data.url || j.data.audio_url)) ||
        ''
      if (!audioUrl) return { ok: false, error: 'BreezeBlue 返回 JSON 但没有音频地址', dir }
      const res2 = await httpRequest(audioUrl, { method: 'GET', timeoutMs })
      if (!res2.ok || res2.status !== 200) return { ok: false, error: 'BreezeBlue 音频下载失败 ' + (res2.status || res2.error), dir }
      const buf2 = res2.buffer
      if (!buf2.length) return { ok: false, error: 'BreezeBlue 音频为空', dir }
      await writeFile(out, buf2)
      padSilence(out)
      return { ok: true, path: out, bytes: buf2.length, dir, provider: 'breeze', padded: true }
    }
    const buf = res.buffer
    if (!buf.length) return { ok: false, error: 'BreezeBlue 返回空音频', dir }
    await writeFile(out, buf)
    padSilence(out)
    return { ok: true, path: out, bytes: buf.length, dir, provider: 'breeze', padded: true }
  } catch (e) {
    const msg = String((e && e.message) || e)
    return { ok: false, error: msg.slice(0, 200), dir }
  }
}

export function resolveStyle(style) {
  const want = String(style || '').trim().toLowerCase()
  if (!want) return null
  return TTS_STYLES.find((x) => x.id === want) || null
}

export async function synthesize(text, {
  voice = DEFAULT_VOICE,
  rate = '+0%',
  volume = '+0%',
  pitch = '+0Hz',
  jitter = false,
  style = '',
  timeoutMs = 30000,
  provider = 'edge',
  breezeApiKey = '',
  breezeVoiceId = '',
  breezeBase = '',
  breezeModel = '',
  breezeLanguage = 'zh',
} = {}) {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '文字为空' }
  if (content.length > 1500) return { ok: false, error: '文字太长（上限 1500 字）' }

  // BreezeBlue 优先；失败自动回退 edge-tts，绝不让一句话因为云端抽风而没声音
  let breezeError = ''
  const prof = await loadBreezeProfile()
  const bApiKey = breezeApiKey || (prof && prof.apiKey) || ''
  const bVoiceId = breezeVoiceId || (prof && prof.voiceId) || ''
  const wantBreeze = !!prof || String(provider).toLowerCase() === 'breeze'
  if (wantBreeze && bApiKey && bVoiceId) {
    const br = await synthesizeBreeze(content, {
      apiKey: bApiKey,
      voiceId: bVoiceId,
      base: breezeBase || (prof && prof.base) || '',
      model: breezeModel || (prof && prof.model) || '',
      language: breezeLanguage || (prof && prof.language) || 'zh',
      timeoutMs,
    })
    if (br.ok) return { ...br, provider: 'breeze', breezeError: '' }
    breezeError = br.error
    try { if (br.path) await unlink(br.path) } catch {}
    // 配了 Breeze（迷糊版）就不要回退 edge 换音色：重试一次，仍失败就让调用方发文字
    const retry = await synthesizeBreeze(content, {
      apiKey: bApiKey,
      voiceId: bVoiceId,
      base: breezeBase || (prof && prof.base) || '',
      model: breezeModel || (prof && prof.model) || '',
      language: breezeLanguage || (prof && prof.language) || 'zh',
      timeoutMs,
    })
    if (retry.ok) return { ...retry, provider: 'breeze', breezeError: '' }
    return { ok: false, error: 'BreezeBlue 失败（已重试，不回退 edge）：' + String(retry.error || breezeError || '') }
  }

  // 风格只覆盖语速/音量/音调，不改音色（音色永远听 ttsVoice 的）
  const st = resolveStyle(style)
  if (st) {
    rate = st.rate
    volume = st.volume
    if (st.pitch) pitch = st.pitch
  }
  // 拟真：语速加随机抖动，减少"同一个调念到底"的机械感
  if (jitter) rate = jitterRate(rate)
  let dir = ''
  try {
    dir = await mkdtemp(join(tmpdir(), 'qqfish-tts-'))
    const out = join(dir, 'voice.mp3')
    // 微软的语音接口偶尔会超时/断连（日志里 2026-10-31 出现过一次），单次失败就整句丢语音太亏，重试三次
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await runTts([
          '--voice=' + String(voice || DEFAULT_VOICE),
          '--rate=' + String(rate || '+0%'),
          '--volume=' + String(volume || '+0%'),
          '--pitch=' + String(pitch || '+0Hz'),
          '--text=' + content,
          '--write-media=' + out,
        ], timeoutMs)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        try { await unlink(out) } catch {}
        if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt))
      }
    }
    if (lastErr) {
      const msg = String((lastErr && lastErr.message) || lastErr)
      const edgeErr = msg.includes('ENOENT') ? 'edge-tts 未安装（apt/pip install edge-tts）' : msg.slice(0, 200)
      return { ok: false, error: breezeError ? ('BreezeBlue 失败：' + breezeError + ' / 回退 edge 也失败：' + edgeErr) : edgeErr }
    }
    const buf = await readFile(out)
    if (!buf.length) return { ok: false, error: '生成的文件为空' }
    return { ok: true, path: out, bytes: buf.length, dir, provider: 'edge' }
  } catch (e) {
    const msg = String((e && e.message) || e)
    return { ok: false, error: msg.includes('ENOENT') ? 'edge-tts 未安装（apt/pip install edge-tts）' : msg.slice(0, 200) }
  }
}

/** 生成并返回 base64:// 字符串（供 record 段用） */
export async function synthesizeBase64(text, options = {}) {
  const r = await synthesize(text, options)
  if (!r.ok) return r
  try {
    const buf = await readFile(r.path)
    return { ok: true, file: 'base64://' + buf.toString('base64'), bytes: r.bytes, provider: r.provider }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
  } finally {
    cleanup(r)
  }
}

/** 清理临时文件 */
export async function cleanup(result) {
  if (!result || !result.path) return
  try { await unlink(result.path) } catch {}
}
