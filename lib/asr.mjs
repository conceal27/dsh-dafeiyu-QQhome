/**
 * lib/asr.mjs — 语音识别（归属：xingzhu）
 * ============================================================================
 * 让她能听懂声音：QQ 里别人发的语音、B站没字幕的视频，都能转成文字喂给模型。
 *
 * 为什么不用本地模型：
 *   这台服务器 2 核 2G，whisper 的 small/medium 跑不动，tiny 的中文准确率太低。
 *   所以统一走云 API，全部是 OpenAI 兼容的 /v1/audio/transcriptions 接口。
 *
 * 支持的 provider（面板里选，key 也从面板填）：
 *   · siliconflow  硅基流动 SenseVoiceSmall，中文强、有免费额度
 *   · groq         whisper-large-v3-turbo，快到离谱、有免费额度
 *   · openai       whisper-1
 *   · custom       任何 OpenAI 兼容端点
 *
 * 调用方负责把音频转成 mp3/wav（amr/silk 这类浏览器与 API 都不认）。
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

/** 本地 SenseVoice 模型目录（默认 ~/Napcat/asr-models，可用 FISH_ASR_MODEL_DIR 覆盖） */
const LOCAL_MODEL_DIR = process.env.FISH_ASR_MODEL_DIR || path.join(os.homedir(), 'Napcat', 'asr-models')
const LOCAL_FFMPEG = process.env.FISH_ASR_FFMPEG || 'ffmpeg'
/** 插件自己的 node_modules（本地推理依赖装在这里） */
const LOCAL_REQUIRE_BASE = process.env.FISH_ASR_REQUIRE_BASE || path.join(os.homedir(), 'qqfish-custom', 'index.js')

let sherpaCache = null
let recognizerCache = null
let sherpaLoadError = ''

/** 懒加载 sherpa-onnx-node；失败时缓存错误，避免每次都重试拖慢主流程 */
function getSherpa() {
  if (sherpaCache) return sherpaCache
  if (sherpaLoadError) throw new Error(sherpaLoadError)
  try {
    const req = createRequire(LOCAL_REQUIRE_BASE)
    sherpaCache = req('sherpa-onnx-node')
    return sherpaCache
  } catch (e) {
    sherpaLoadError = 'sherpa-onnx-node 加载失败：' + ((e && e.message) || e)
    throw new Error(sherpaLoadError)
  }
}

/** 识别器单例：模型加载约 4-5 秒，绝不能每次识别都重建 */
function getRecognizer() {
  if (recognizerCache) return recognizerCache
  const sherpa = getSherpa()
  const modelDir = path.join(LOCAL_MODEL_DIR, 'sensevoice-onnx')
  const model = path.join(modelDir, 'model.int8.onnx')
  const tokens = path.join(modelDir, 'tokens.txt')
  if (!fs.existsSync(model)) throw new Error('找不到本地模型：' + model)
  if (!fs.existsSync(tokens)) throw new Error('找不到 tokens.txt：' + tokens)
  recognizerCache = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  })
  return recognizerCache
}

/**
 * 本地 SenseVoice 识别。
 * 输入任意音频字节（mp3/wav/m4a，NapCat 的 get_record 会给 mp3），
 * 内部用 ffmpeg 转成 16k 单声道 wav 再喂给 sherpa-onnx。
 */
async function transcribeLocal(bytes, opts = {}) {
  const started = Date.now()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-asr-'))
  const src = path.join(dir, 'in' + (opts.filename ? path.extname(String(opts.filename)) || '.mp3' : '.mp3'))
  const wav = path.join(dir, 'out.wav')
  try {
    fs.writeFileSync(src, Buffer.from(bytes))
    await execFileAsync(
      LOCAL_FFMPEG,
      ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      { timeout: 60000 },
    )
    const sherpa = getSherpa()
    const recognizer = getRecognizer()
    const wave = sherpa.readWave(wav)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    const text = String((result && result.text) || '').trim()
    if (!text) {
      return { ok: false, text: '', error: '识别结果为空（可能没声音）', provider: 'local', ms: Date.now() - started }
    }
    return { ok: true, text, provider: 'local', ms: Date.now() - started }
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e), provider: 'local', ms: Date.now() - started }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 预热本地识别器：后台把 ONNX 模型加载进内存。
 * 模型加载约 4-5 秒，若不预热，第一条语音要多等这么久。
 * 由插件启动时异步调用，失败只记日志、不影响主流程。
 */
export async function warmupLocal() {
  const started = Date.now()
  try {
    getRecognizer()
    return { ok: true, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - started }
  }
}

export const ASR_PROVIDERS = [
  {
    id: 'siliconflow',
    label: '硅基流动（中文强，有免费额度）',
    endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    defaultModel: 'FunAudioLLM/SenseVoiceSmall',
    signup: 'https://cloud.siliconflow.cn',
  },
  {
    id: 'groq',
    label: 'Groq（whisper-large-v3，速度极快，有免费额度）',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    defaultModel: 'whisper-large-v3-turbo',
    signup: 'https://console.groq.com/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI（whisper-1）',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    defaultModel: 'whisper-1',
    signup: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容端点）',
    endpoint: '',
    defaultModel: '',
    signup: '',
  },
  {
    id: 'local',
    label: '本地 SenseVoice（免费、离线、不需要 Key）',
    endpoint: '',
    defaultModel: 'sensevoice',
    signup: '',
  },
]

export function findProvider(id) {
  return ASR_PROVIDERS.find((p) => p.id === id) || ASR_PROVIDERS[0]
}

/**
 * 转写一段音频。
 * @param {Buffer|Uint8Array} audio 音频二进制（mp3/wav/m4a 都行，别传 amr/silk）
 * @param {object} opts { provider, apiKey, endpoint, model, language, filename, timeoutMs }
 * @returns {Promise<{ok:boolean, text:string, error?:string, provider?:string, ms?:number}>}
 */
export async function transcribe(audio, opts = {}) {
  const started = Date.now()
  const provider = findProvider(String(opts.provider || 'siliconflow'))

  // 本地 SenseVoice：完全离线，不需要 API Key / 端点 / 模型名
  if (provider.id === 'local') {
    const localBytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio || [])
    if (!localBytes.length) return { ok: false, text: '', error: '音频是空的', provider: 'local' }
    return transcribeLocal(localBytes, { filename: String(opts.filename || 'audio.mp3') })
  }

  const apiKey = String(opts.apiKey || '').trim()
  const endpoint = String(opts.endpoint || provider.endpoint || '').trim()
  const model = String(opts.model || provider.defaultModel || '').trim()
  const language = String(opts.language || 'zh').trim()
  const filename = String(opts.filename || 'audio.mp3')

  if (!apiKey) return { ok: false, text: '', error: '没填 API Key', provider: provider.id }
  if (!endpoint) return { ok: false, text: '', error: '没填接口地址', provider: provider.id }
  if (!model) return { ok: false, text: '', error: '没填模型名', provider: provider.id }

  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio || [])
  if (!bytes.length) return { ok: false, text: '', error: '音频是空的', provider: provider.id }

  try {
    const form = new FormData()
    const type = filename.endsWith('.wav') ? 'audio/wav' : filename.endsWith('.m4a') ? 'audio/m4a' : 'audio/mpeg'
    form.append('file', new Blob([bytes], { type }), filename)
    form.append('model', model)
    // Groq / OpenAI 支持 language；SenseVoice 不认但多传一般会被忽略
    if (language) form.append('language', language)
    form.append('response_format', 'json')

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(5000, Number(opts.timeoutMs) || 120000))
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + apiKey },
        body: form,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const txt = await res.text()
    if (!res.ok) {
      return { ok: false, text: '', error: 'HTTP ' + res.status + '：' + txt.slice(0, 200), provider: provider.id, ms: Date.now() - started }
    }
    let data = null
    try {
      data = JSON.parse(txt)
    } catch {
      return { ok: false, text: '', error: '返回不是 JSON：' + txt.slice(0, 150), provider: provider.id, ms: Date.now() - started }
    }
    // OpenAI 兼容返回 { text }；也兼容 { data: { text } } 之类
    const text = String((data && (data.text || (data.data && data.data.text) || (data.result && data.result.text))) || '').trim()
    if (!text) return { ok: false, text: '', error: '识别结果为空（可能是没声音或格式不支持）', provider: provider.id, ms: Date.now() - started }
    return { ok: true, text, provider: provider.id, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e), provider: provider.id, ms: Date.now() - started }
  }
}

/**
 * 面板「测试」用：用一段极短静音探接口通不通。
 * 注意：静音可能返回空文本，这里把「HTTP 200 但空文本」也算通。
 */
export async function testConnection(opts = {}) {
  // 200ms 静音 wav（44 字节头 + 少量采样）
  const sampleRate = 16000
  const samples = 3200
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  const r = await transcribe(buf, { ...opts, filename: 'test.wav', timeoutMs: 30000 })
  // 空文本也算连通（静音本来就没内容）
  if (r.ok) return { ok: true, message: '连通，识别耗时 ' + r.ms + 'ms', text: r.text }
  if (/识别结果为空/.test(String(r.error))) return { ok: true, message: '连通（静音无内容，属正常）', text: '' }
  return { ok: false, message: String(r.error || '失败') }
}
