/**
 * lib/llm.mjs — 用 DSH 自己的 LLM 统一抽象层（ctx.llm）生成一句话（归属：xingzhu）
 * ============================================================================
 * 说明：
 *   - 不自己发 HTTP、不自己管 Key：provider/model/凭据全部交给 DSH 的 llm 服务，
 *     因此和用户在对话页里用的模型完全同源（token 也记在同一套口径上）。
 *   - 模型选择优先级：config.modelRouting[feature] → config.modelProvider/model →
 *     「当前对话的模型」（ctx.agentDefaultModel.currentSelection()）。
 *   - 只取纯文本 + usage；失败返回结构化原因，绝不伪造回复。
 *   - 用量在这里集中记一次（plugins 里不要再各记一遍）：按功能/模型/花费统计。
 * ============================================================================
 */
import { loadLlmKit } from './hostdeps.mjs'
import { estimateTokens, recordUsage } from './usage.mjs'

const CALL_IDENTITY = 'dsh-dafeiyu-home'

function serviceOf(ctx, name) {
  try {
    return ctx.get ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前要用的 provider/model。
 * feature：调用方声明的用途（reply/proactive/diary…），用于「按功能选模型」。
 */
/** 把 "provider/model" 拆开（供 modelChain 用），容忍名字里有空格 */
function splitTarget(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const i = t.lastIndexOf('/')
  if (i <= 0) return null
  return { provider: t.slice(0, i).trim(), model: t.slice(i + 1).trim() }
}

/**
 * 这次调用按顺序该试哪些模型。
 * 顺序：按功能的 modelRouting[feature] -> modelChain（逗号分隔）-> modelProvider/model
 *      -> 都不配时跟随对话里的默认模型。
 */
export function resolveChain(ctx, config, feature) {
  const out = []
  const seen = new Set()
  const push = (provider, model) => {
    const p = String(provider || '').trim()
    const m = String(model || '').trim()
    if (!p || !m) return
    const key = p + '/' + m
    if (seen.has(key)) return
    seen.add(key)
    out.push({ provider: p, model: m })
  }

  const routing = (config && config.modelRouting) || {}
  const pick = feature ? routing[feature] : null
  if (pick && pick.provider && pick.model) push(pick.provider, pick.model)

  for (const part of String((config && config.modelChain) || '').split(/[,，;；\n]+/)) {
    const t = splitTarget(part)
    if (t) push(t.provider, t.model)
  }

  if (config && config.modelProvider && config.model) push(config.modelProvider, config.model)

  if (!out.length) {
    const agent = serviceOf(ctx, 'agentDefaultModel')
    try {
      const sel = agent && agent.currentSelection && agent.currentSelection()
      if (sel && sel.provider && sel.model) push(sel.provider, sel.model)
    } catch {}
  }
  return out
}

export function resolveModel(ctx, config, feature) {
  const chain = resolveChain(ctx, config, feature)
  return chain[0] || null
}

/**
 * 「自动选模型」：provider 支持列模型时（火山方舟的 auto），挑一个能聊的。
 * 排除画图/视频/3D/embedding/翻译/路由这类不能对话的模型。
 */
async function pickAutoModel(llm, provider) {
  try {
    const list = (await llm.listModels(provider)) || []
    const bad = /(image|video|3d|embedding|router|translat|tts|asr|seedream|seedance|hitem3d|hyper3d|vision-embed)/i
    const usable = list
      .map((m) => String((m && m.id) || ''))
      .filter((id) => id && id !== 'auto' && !bad.test(id))
    if (!usable.length) return ''
    // auto 的取向：先要「能聊且够聪明」。pro > character > flash > turbo > 其它；
    // lite / economy 是兜底档，只在没有更好的时候用
    const rank = (id) => {
      if (/seed-2-1-pro|seed-2-0-pro|v4-pro/i.test(id)) return 0
      if (/character/i.test(id)) return 1
      if (/flash/i.test(id)) return 2
      if (/turbo/i.test(id)) return 3
      if (/lite|economy|mini/i.test(id)) return 8
      return 5
    }
    return usable.slice().sort((a, b) => rank(a) - rank(b))[0]
  } catch {
    return ''
  }
}

/** 列出宿主可用的 provider / model，供面板下拉框用（拿不到就返回空表，不报错） */
export async function listHostModels(ctx) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return { ok: false, providers: [] }
  const providers = []
  try {
    for (const p of llm.listProviders() || []) {
      const id = String((p && p.id) || '')
      if (!id) continue
      const models = []
      try {
        const list = await llm.listModels(id)
        for (const m of list || []) {
          const mid = String((m && m.id) || '')
          if (!mid) continue
          models.push({ id: mid, name: String((m && m.name) || mid) })
        }
      } catch {}
      providers.push({ id, name: String((p && p.name) || id), models })
    }
  } catch {}
  return { ok: true, providers }
}

/**
 * 生成一段文本。
 * @param {object} ctx cordis 上下文
 * @param {object} options { system, messages:[{role:'user'|'assistant',text}], config, feature, timeoutMs, log }
 * @returns {Promise<{ok:true,text:string,usage:object|null,model:{provider,model}}|{ok:false,reason:string,message:string}>}
 */
/**
 * provider 兼容：配置/面板里可能存的是**中文显示名**（「火山方舟」「4SToken 中转」），
 * 而 DSH 的 llm 服务只认 **provider id**（volc-ark / fourstoken）。传中文名会得到
 * `no adapter registered for provider "火山方舟"` → 生成一律 empty → 她完全不回话。
 * 这里先查已知别名，再把 id 原样放过；认不出来就返回原值，让上层照旧报错，不吞信息。
 */
const PROVIDER_ALIAS = {
  火山方舟: 'volc-ark',
  方舟: 'volc-ark',
  volc: 'volc-ark',
  ark: 'volc-ark',
  DeepSeek: 'deepseek-official',
  'DeepSeek 官方': 'deepseek',
  'DeepSeek Account': 'deepseek-account',
  '4SToken 中转': 'fourstoken',
  '4S Token': 'fourstoken',
  fourstoken: 'fourstoken',
  CodeArts: 'codearts',
  codearts: 'codearts',
  WorkBuddy: 'workbuddy',
  'WorkBuddy Global': 'workbuddy-global',
}

function providerIdOf(name) {
  const raw = String(name || '').trim()
  if (!raw) return raw
  return PROVIDER_ALIAS[raw] || raw
}

async function generateOnce(ctx, options) {
  const log = options.log || (() => {})
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'llm-missing', message: 'DSH 的 llm 服务不可用（请确认 DSH 已配置可用的模型）' }
  }
  let model = options.modelOverride && options.modelOverride.provider ? { ...options.modelOverride } : resolveModel(ctx, options.config, options.feature)
  if (model && model.model === 'auto') {
    const auto = await pickAutoModel(llm, model.provider)
    if (auto) {
      model = { provider: model.provider, model: auto }
      try { log(`[llm] 自动选模型：${auto}`) } catch {}
    } else {
      return { ok: false, reason: 'model-missing', message: `provider ${model.provider} 没有可选模型` }
    }
  }
  if (!model) {
    return { ok: false, reason: 'model-missing', message: '没有可用的模型：请在对话页选择模型，或在小肥鱼面板里指定' }
  }
  const kit = await loadLlmKit(log)
  if (!kit) {
    return { ok: false, reason: 'llm-kit-missing', message: '取不到 DSH 的 LLM 运行时（dsh-llm），插件可能装在了不兼容的版本上' }
  }

  const { BlockAssembler, createAssistantMessage, createUserMessage } = kit
  const messages = []
  for (const item of options.messages || []) {
    // 图片块（识图）：item.images = [{ attachment: ImageAttachmentRef }]，由 engine 先用
    // ctx.attachments.saveImage() 存成本机附件引用再传进来；拿不到附件就只发文本。
    const parts = [{ type: 'text', text: String(item.text || '') }]
    for (const img of Array.isArray(item.images) ? item.images : []) {
      if (img && img.attachment) parts.push({ type: 'image', attachment: img.attachment })
    }
    if (item.role === 'assistant') {
      messages.push(
        createAssistantMessage({
          content: parts,
          source: { provider: model.provider, model: model.model },
        }),
      )
    } else {
      messages.push(
        createUserMessage({
          content: parts,
          source: { kind: 'user' },
        }),
      )
    }
  }

  const assembler = new BlockAssembler()
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 60_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const stream = llm.stream({
      provider: providerIdOf(model.provider),
      model: model.model,
      sessionId: CALL_IDENTITY,
      messages,
      system: String(options.system || ''),
      temperature: typeof options.temperature === 'number' ? options.temperature : 1,
      ...(typeof options.maxTokens === 'number' && options.maxTokens > 0 ? { maxTokens: Math.trunc(options.maxTokens) } : {}),
      signal: controller.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)
  } catch (e) {
    clearTimeout(timer)
    const message = e && e.message ? String(e.message) : String(e)
    log(`生成失败：${message.slice(0, 300)}`)
    return { ok: false, reason: 'generate-error', message }
  }
  clearTimeout(timer)

  const text = assembler
    .blocks()
    .filter((b) => b && b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
    .trim()
  if (!text) {
    const finish = assembler.finish || {}
    const detail =
      finish.kind === 'aborted'
        ? '生成被取消'
        : finish.kind === 'max-tokens'
          ? '输出达到上限'
          : finish.kind === 'error'
            ? String((finish.failure && finish.failure.message) || '模型调用失败')
            : '模型没有返回文本'
    return { ok: false, reason: 'empty', message: detail, usage: assembler.usage || null, model }
  }
  return { ok: true, text, usage: assembler.usage || null, model }
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
  const output = num(usage.outputTokens) + num(usage.reasoningTokens)
  if (input === 0 && output === 0) return null
  return { input, output, total: input + output }
}

/** 估算这次请求的 prompt 字符数（拿不到 usage 时兜底算 token） */
function promptCharsOf(options) {
  let chars = String((options && options.system) || '').length
  for (const item of (options && options.messages) || []) {
    chars += String((item && item.text) || '').length
    if (Array.isArray(item && item.images) && item.images.length) chars += 800 * item.images.length
  }
  return chars
}

/** 汇总多次尝试的 usage（第一次失败重试也算调用次数） */
function mergeUsage(attempts) {
  let input = 0
  let output = 0
  let any = false
  for (const attempt of attempts) {
    const u = normalizeUsage(attempt && attempt.usage)
    if (!u) continue
    any = true
    input += u.input
    output += u.output
  }
  return any ? { input, output, total: input + output } : null
}

/**
 * 对外入口：失败自动重试一次（老手机走 Tailscale，流式偶发断流很常见）。
 * reason=empty / generate-error 才重试；配置类错误（没模型、没服务）直接返回。
 * 每次调用（含重试）都记一次用量，按 feature 聚合。
 */
export async function generateText(ctx, options) {
  const opts = options || {}
  const feature = String(opts.feature || 'other')
  const chain = resolveChain(ctx, opts.config, feature)
  const attempts = []
  let result = null

  if (!chain.length) {
    result = await generateOnce(ctx, opts)
    attempts.push(result)
  } else {
    for (let i = 0; i < chain.length; i++) {
      const target = chain[i]
      const one = { ...opts, modelOverride: target }
      let r = await generateOnce(ctx, one)
      attempts.push(r)

      const reason = String((r && r.reason) || '')
      const msg = String((r && r.message) || '')
      // 思考型模型会把 token 全花在 reasoning 上：小 maxTokens 直接「输出达到上限」。
      // 这种不是网络问题，原地重试没用，抬预算再来一次。
      const truncated = !(r && r.ok) && /输出达到上限|max_tokens|maximum.*token|length limit/i.test(msg)
      if (truncated) {
        const bigger = Math.max((Number(opts.maxTokens) || 0) * 6, 1200)
        try { if (opts.log) opts.log(`[llm] ${target.provider}/${target.model} 撞到输出上限，抬到 ${bigger} tokens 再来一次`) } catch {}
        r = await generateOnce(ctx, { ...one, maxTokens: bigger })
        attempts.push(r)
      } else if (!(r && r.ok) && (reason === 'empty' || reason === 'generate-error')) {
        // 同一个模型：流断/空回复 再试一次（老手机走 Tailscale 很常见）
        try { if (opts.log) opts.log(`[llm] ${target.provider}/${target.model} 失败（${reason}），1 秒后重试`) } catch {}
        await new Promise((res) => setTimeout(res, 1000))
        r = await generateOnce(ctx, one)
        attempts.push(r)
      }

      result = r
      if (r && r.ok) {
        if (i > 0) {
          try { if (opts.log) opts.log(`[llm] 换成 ${target.provider}/${target.model} 成功`) } catch {}
        }
        break
      }
      // 运行时都取不到，换模型也没用
      if (reason === 'llm-missing' || reason === 'llm-kit-missing') break
      if (i + 1 < chain.length) {
        const next = chain[i + 1]
        try {
          if (opts.log) opts.log(`[llm] ${target.provider}/${target.model} 不可用（${reason || '未知'}），换 ${next.provider}/${next.model}`)
        } catch {}
      }
    }
  }

  if (result && typeof result === 'object') {
    result = { ...result, chain: attempts.map((a) => ({ ok: !!(a && a.ok), reason: (a && a.reason) || '', message: String((a && a.message) || '').slice(0, 160), model: (a && a.model) || null })) }
  }

  try {
    const model = (result && result.model) || {}
    recordUsage(mergeUsage(attempts), {
      kind: feature,
      feature,
      provider: model.provider || '',
      model: model.model || '',
      promptChars: promptCharsOf(opts),
      outputChars: result && result.ok ? String(result.text || '').length : 0,
      calls: attempts.length,
      estimated: !mergeUsage(attempts),
    })
  } catch {
    // 统计失败绝不影响回复
  }

  return result
}
