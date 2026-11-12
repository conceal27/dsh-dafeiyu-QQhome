/**
 * lib/llm.mjs — 用 DSH 自己的 LLM 统一抽象层（ctx.llm）生成一句话（归属：xingzhu）
 * ============================================================================
 * 说明：
 *   - 不自己发 HTTP、不自己管 Key：provider/model/凭据全部交给 DSH 的 llm 服务，
 *     因此和用户在对话页里用的模型完全同源（token 也记在同一套口径上）。
 *   - 模型选择：优先用面板里配置的 provider/model；留空则跟随「当前对话的模型」
 *     （ctx.agentDefaultModel.currentSelection()，与 dsh-pet 同源）。
 *   - 只取纯文本 + usage；失败返回结构化原因，绝不伪造回复。
 * ============================================================================
 */
import { loadLlmKit } from './hostdeps.mjs'

const CALL_IDENTITY = 'dsh-dafeiyu-home'

function serviceOf(ctx, name) {
  try {
    return ctx.get ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 当前要用的 provider/model；配置优先，其次当前对话模型 */
export function resolveModel(ctx, config) {
  const preferred =
    config && config.modelProvider && config.model
      ? { provider: String(config.modelProvider), model: String(config.model) }
      : null
  if (preferred) return preferred
  const agent = serviceOf(ctx, 'agentDefaultModel')
  try {
    const sel = agent && agent.currentSelection && agent.currentSelection()
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch {}
  return null
}

/**
 * 生成一段文本。
 * @param {object} ctx cordis 上下文
 * @param {object} options { system, messages:[{role:'user'|'assistant',text}], config, timeoutMs, log }
 * @returns {Promise<{ok:true,text:string,usage:object|null,model:{provider,model}}|{ok:false,reason:string,message:string}>}
 */
async function generateOnce(ctx, options) {
  const log = options.log || (() => {})
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'llm-missing', message: 'DSH 的 llm 服务不可用（请确认 DSH 已配置可用的模型）' }
  }
  const model = resolveModel(ctx, options.config)
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
      provider: model.provider,
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

/** 把 usage 规整成 {input,output,total}；无 usage 时返回 null */
/**
 * 对外入口：失败自动重试一次（老手机走 Tailscale，流式偶发断流很常见）。
 * reason=empty / generate-error 才重试；配置类错误（没模型、没服务）直接返回。
 */
export async function generateText(ctx, options) {
  const first = await generateOnce(ctx, options)
  if (first && first.ok) return first
  const reason = String((first && first.reason) || '')
  if (reason !== 'empty' && reason !== 'generate-error') return first
  const why = String((first && first.message) || '')
  try { options && options.log && options.log('[llm] 第一次失败（' + reason + (why ? '｜' + why : '') + '），1 秒后重试') } catch {}
  await new Promise((r) => setTimeout(r, 1000))
  const second = await generateOnce(ctx, options)
  if (second && second.ok) {
    try { options && options.log && options.log('[llm] 重试成功') } catch {}
    return second
  }
  return second || first
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
  const output = num(usage.outputTokens) + num(usage.reasoningTokens)
  if (input === 0 && output === 0) return null
  return { input, output, total: input + output }
}
