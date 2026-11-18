/**
 * lib/autosign.mjs — 按心情自动改 QQ 个性签名
 * ============================================================================
 * 背景：engine.mjs 里「签名提醒」只是往系统提示里加一句话，实测（2026-11-12）
 * 夸她 / 骂她 / 说生日三种情境下提醒都塞进去了，她三次都没写 [sign:...]。
 * 旧插件 astrbot_plugin_dafeiyu_signature 的 docstring 记的也是同一件事：
 * 「她自己改」光靠人设，模型很少主动调用。
 *
 * 所以这里补一条确定性路径：命中签名情境、今天还有次数、距上次改动够久，
 * 就单独让模型写一句签名（只要签名本身，不要回复正文），写成后真的改上去。
 *
 * 门：
 *   1. 只对主人私聊生效（群里不碰）；
 *   2. canChangeSign(2) 还有次数；
 *   3. 距上次签名改动 ≥ AUTOSIGN_COOLDOWN_MS（6 小时），避免每句夸奖都改；
 *   4. 命中关键词情境，或情绪已经很极端（valence 高/低、energy 极低）。
 * ============================================================================
 */
import { generateText } from './llm.mjs'
import { systemPrompt, cleanReply } from './persona.mjs'
import { stateHome } from './store.mjs'
import { readMood } from './vitals.mjs'
import { signMoodHint, canChangeSign, markSignChanged, loadBody } from './body.mjs'
import { dayStateBlock } from './selfstate.mjs'
import { scrubPublic } from './privacy.mjs'

const COOLDOWN_MS = 6 * 3600 * 1000

/** 这次该不该改签名。返回 { hit, reason } */
export async function signTrigger(msg, config) {
  if (!msg || msg.channel !== 'private') return { hit: false }
  const text = String(msg.text || '')
  if (!text) return { hit: false }
  // 主人明确叫她改签名的，走正常 [sign:...] 通路，这里不抢
  if (/签名|個性簽名|个性签名/.test(text)) return { hit: false, reason: 'owner-asked' }

  const gate = await canChangeSign(2)
  if (!gate.ok) return { hit: false, reason: 'daily-limit' }

  let body = {}
  try { body = (await loadBody()) || {} } catch {}
  const lastAt = Number(body.lastSignAt || 0)
  if (lastAt && Date.now() - lastAt < COOLDOWN_MS) return { hit: false, reason: 'cooldown' }

  const hit = signMoodHint(text)
  if (hit) return { hit: true, reason: hit }

  try {
    const m = readMood(stateHome(), Date.now())
    const v = Number(m && m.valence)
    const e = Number(m && m.energy)
    if (Number.isFinite(v) && v >= 0.78) return { hit: true, reason: '心情特别好' }
    if (Number.isFinite(v) && v <= 0.22) return { hit: true, reason: '心里堵得慌' }
    if (Number.isFinite(e) && e <= 0.18) return { hit: true, reason: '累到不行' }
  } catch {}
  return { hit: false }
}

/**
 * 真的去改一条签名。
 * @returns {Promise<{ok:boolean, sign?:string, reason?:string, error?:string}>}
 */
export async function autoChangeSign(ctx, config, bridge, reason, log) {
  const lg = log || console
  const home = stateHome()
  let body = {}
  try { body = (await loadBody()) || {} } catch {}
  const prev = String(body.lastSign || '').trim()

  const system = systemPrompt(config, { channel: 'private' }) +
    '\n\n【现在只做一件事：写一句 QQ 个性签名】不回复任何人，不要解释，不要引号，不要 emoji 堆砌。'

  const ask = [
    `你刚刚遇到的情况：${reason}。`,
    '',
    dayStateBlock(home, new Date(), { compact: true, maxEvents: 3 }),
    '',
    prev ? `你现在的签名是「${prev}」，要换掉。` : '',
    '写一句新的 QQ 个性签名，要求：',
    '- 只输出签名本身，一行，8~20 个字；',
    '- 用你自己的口吻，像随手记下这一刻的心情；',
    '- 不要引号、不要句号结尾、不要解释、不要写「签名：」这种前缀；',
    '- 不写主人的隐私（QQ 号、生日、学校、专业、单位、住址）。',
  ].filter(Boolean).join('\n')

  const r = await generateText(ctx, {
    feature: 'sign',
    system,
    messages: [{ role: 'user', text: ask }],
    config,
    timeoutMs: 45_000,
    log: (line) => lg.warn && lg.warn(line),
  })
  if (!r || !r.ok) return { ok: false, error: (r && r.reason) || 'llm' }

  let sign = cleanReply(r.text, 60)
    .replace(/\[[^\]\n]{1,40}\]/g, '')
    .replace(/^["“「『'']+|["”」』'']+$/g, '')
    .replace(/^签名\s*[:：]\s*/, '')
    .replace(/[\s。，,、；;]+$/g, '')
    .split('\n')[0]
    .trim()
  sign = scrubPublic(sign, config).slice(0, 30)
  if (!sign) return { ok: false, error: 'empty' }
  if (sign === prev) return { ok: false, error: 'same-as-before' }

  const gate = await canChangeSign(2)
  if (!gate.ok) return { ok: false, error: 'daily-limit' }

  try {
    await bridge.call('set_self_longnick', { longNick: sign })
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  await markSignChanged(sign)
  lg.info && lg.info(`[签名] 按心情自动改成：${sign}（${reason}）`)
  return { ok: true, sign, reason }
}
