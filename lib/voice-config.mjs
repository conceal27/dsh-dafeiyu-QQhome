/**
 * lib/voice-config.mjs — 语音配置的唯一真相
 * ============================================================================
 * DSH 面板（index.js）和 8082 控制台（console.mjs）都只调这里，
 * 保证「界面上显示的」和「实际合成用的」永远是同一份数据。
 *
 * 数据源：
 *   config.json      → ttsVoice / ttsStyle / voiceReply / voiceEagerness（Edge 与开关）
 *   tts-breeze.json  → enabled / apiKey / voiceId / model（Breeze 引擎）
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, saveConfig, stateHome } from './store.mjs'
import { synthesizeBase64, TTS_VOICES, TTS_STYLES, BREEZE_VOICES } from './tts.mjs'

export { TTS_VOICES, TTS_STYLES, BREEZE_VOICES }

export function breezePath() {
  return join(stateHome(), 'tts-breeze.json')
}

export function readBreezeFile() {
  try {
    return JSON.parse(readFileSync(breezePath(), 'utf8'))
  } catch {
    return null
  }
}

export function writeBreezeFile(obj) {
  try {
    writeFileSync(breezePath(), JSON.stringify(obj, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 当前真实生效的语音状态（所有前端都只读这个） */
export function voiceState() {
  const cfg = loadConfig()
  const br = readBreezeFile()
  const breezeOn = !!(br && br.enabled !== false && br.apiKey && br.voiceId)
  const vname = br ? (BREEZE_VOICES.find((v) => v.id === br.voiceId) || {}).name || br.voiceId : ''
  return {
    provider: breezeOn ? 'breeze' : 'edge',
    enabled: cfg.voiceReply !== false,
    edgeVoice: cfg.ttsVoice || 'zh-CN-XiaoxiaoNeural',
    style: cfg.ttsStyle || 'cute',
    eagerness: cfg.voiceEagerness || 'normal',
    // which：给界面直接展示的一行摘要
    summary: breezeOn ? 'BreezeBlue · ' + vname : 'Edge · ' + (cfg.ttsVoice || 'zh-CN-XiaoxiaoNeural'),
    breeze: br
      ? { enabled: br.enabled !== false, voiceId: br.voiceId, voiceName: vname, hasKey: !!br.apiKey }
      : null,
    options: { breeze: BREEZE_VOICES, edge: TTS_VOICES, styles: TTS_STYLES },
  }
}

/**
 * voiceState 的异步版：面板打开语音页时调用。
 *
 * 【2026-11-12 补】index.js:55 一直在 `import { voiceStateAsync }`，
 * 但这个导出从来不存在 —— 于是整个插件在启动时
 * `failed to import`（SyntaxError），QQ 机器人直接挂掉。
 * index.js 的调用点本来就有 try/catch 兜底到同步的 voiceState()，
 * 所以这里只要给出一个可用的异步实现即可：默认直接复用同步结果，
 * force=true 时再尝试刷新一次 Breeze 音色清单。
 *
 * @param {{force?:boolean}} [options] force=true 表示「这次要拿最新的」
 */
export async function voiceStateAsync(options = {}) {
  const base = voiceState()
  if (!options || !options.force) return base
  // force：重新读一遍 Breeze 配置（可能刚在别处改了 key / voiceId），
  // 顺带把「有没有可用音色清单」标出来，方便面板提示。
  try {
    const br = readBreezeFile()
    const breezeOn = !!(br && br.enabled !== false && br.apiKey && br.voiceId)
    const vname = br ? (BREEZE_VOICES.find((v) => v.id === br.voiceId) || {}).name || br.voiceId : ''
    return {
      ...base,
      provider: breezeOn ? 'breeze' : base.provider,
      summary: breezeOn ? 'BreezeBlue · ' + vname : base.summary,
      breeze: br
        ? { enabled: br.enabled !== false, voiceId: br.voiceId, voiceName: vname, hasKey: !!br.apiKey }
        : null,
      refreshed: true,
      refreshedAt: Date.now(),
    }
  } catch {
    return { ...base, refreshed: false }
  }
}

/** 写语音配置（provider / voiceId / edgeVoice / style / eagerness / enabled） */
export function applyVoiceConfig(body) {  const b = body || {}
  const br = readBreezeFile()
  const provider = b.provider === 'breeze' ? 'breeze' : b.provider === 'edge' ? 'edge' : ''
  if (provider === 'breeze') {
    if (!br || !br.apiKey) return { ok: false, error: 'BreezeBlue 还没配密钥（tts-breeze.json 里没有 apiKey）' }
    const next = { ...br, enabled: true }
    if (b.breezeVoiceId && BREEZE_VOICES.some((v) => v.id === b.breezeVoiceId)) next.voiceId = b.breezeVoiceId
    if (!writeBreezeFile(next)) return { ok: false, error: '写 tts-breeze.json 失败' }
  } else if (provider === 'edge') {
    if (br) {
      br.enabled = false
      if (!writeBreezeFile(br)) return { ok: false, error: '写 tts-breeze.json 失败' }
    }
  }
  const patch = {}
  if (b.edgeVoice) patch.ttsVoice = String(b.edgeVoice).slice(0, 60)
  if (b.style) patch.ttsStyle = String(b.style).slice(0, 20)
  if (b.eagerness) patch.voiceEagerness = String(b.eagerness).slice(0, 20)
  if (typeof b.enabled === 'boolean') patch.voiceReply = b.enabled
  if (Object.keys(patch).length) saveConfig(patch)
  return { ok: true, ...voiceState() }
}

/**
 * 试听：按当前（或指定的）配置合成一条，返回 base64（不含前缀）。
 * 不落盘、不发 QQ，就是给前端 <audio> 播的。
 */
export async function previewVoice({ text, provider, breezeVoiceId, edgeVoice, style } = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '文字不能为空' }
  const st = voiceState()
  const br = readBreezeFile()
  const wantBreeze = provider ? provider === 'breeze' : st.provider === 'breeze'
  const r = await synthesizeBase64(t.slice(0, 300), {
    voice: edgeVoice || st.edgeVoice,
    style: style || st.style,
    jitter: false,
    provider: wantBreeze ? 'breeze' : 'edge',
    breezeVoiceId: breezeVoiceId || (br && br.voiceId) || '',
    breezeApiKey: (br && br.apiKey) || '',
    breezeModel: (br && br.model) || '',
    timeoutMs: 45000,
  })
  if (!r.ok) return r
  return {
    ok: true,
    provider: r.provider,
    bytes: r.bytes,
    base64: String(r.file || '').replace(/^base64:\/\//, ''),
  }
}
