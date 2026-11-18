/**
 * lib/global-state.mjs — 全局状态总线（唯一一份「她此刻是什么状态」）
 * ============================================================================
 * 背景（2026-11-13，主人原话）：「不要每个功能都是独立的，比如日程心情这种都是全局的」。
 *
 * 以前每个功能各拼各的：回复拼 scheduleBlock + bodyPromptBlock + streamPromptLine +
 * dayStateBlock，发说说只拼 dayStateBlock，生活分享自己读 mood，自动签名又拼一遍……
 * 同一时刻她在空间里心情 A、在 QQ 里心情 B，自相矛盾。
 *
 * 现在只有一个出口：globalStateBlock()，里面按顺序拼
 *   作息（schedule.mjs）→ 身体（body.mjs）→ 她的一天（daystream.mjs）→ 此刻状态（selfstate.mjs）→ 最近几天趋势（trend.mjs）
 * 回复、发说说、刷空间、改签名、生活分享、自动评论、自我进化全部调它。
 * 只复用现有模块，不重写任何一份状态。
 * ============================================================================
 */
import { dayStateBlock } from './selfstate.mjs'
import { scheduleBlock } from './schedule.mjs'
import { streamPromptLine } from './daystream.mjs'
import { trendPromptLine } from './trend.mjs'
import { bodyPromptBlock, loadBody } from './body.mjs'

/**
 * @param {string} home 家目录（$DSH_HOME/qq-fish）
 * @param {Date|number} now
 * @param {{channel?:string, compact?:boolean, maxEvents?:number, schedule?:boolean, body?:boolean, stream?:boolean, trend?:boolean}} opts
 * @returns {Promise<string>} 一段可直接塞进 system 的文字（可能为空字符串）
 */
export async function globalStateBlock(home, now = new Date(), opts = {}) {
  const {
    channel = '',
    compact = false,
    maxEvents = 5,
    schedule = true,
    body = true,
    stream = true,
    trend = channel !== 'group',
  } = opts
  const t = now instanceof Date ? now : new Date(Number(now) || Date.now())
  const parts = []
  if (schedule) {
    try { const s = scheduleBlock(t.getTime()); if (s) parts.push(s) } catch {}
  }
  if (body) {
    try {
      const b = await loadBody()
      const s = bodyPromptBlock(b, { channel })
      if (s) parts.push(s)
    } catch {}
  }
  if (stream) {
    try { const s = streamPromptLine(home, t.getTime()); if (s) parts.push(s) } catch {}
  }
  try {
    const s = dayStateBlock(home, t, { compact, maxEvents })
    if (s) parts.push(s)
  } catch {}
  if (trend) {
    try { const s = trendPromptLine(home, t); if (s) parts.push(s) } catch {}
  }
  return parts.join('\n\n')
}

/** 只要一段短的（签名、评论这种容不下长文的场景） */
export async function globalStateLine(home, now = new Date(), opts = {}) {
  const block = await globalStateBlock(home, now, { compact: true, maxEvents: 3, body: false, ...opts })
  return block
}

export default { globalStateBlock, globalStateLine }
