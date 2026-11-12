// 把一条回复拆成多个 QQ 气泡。
// 规则：她自己换行 = 想分几条说；一句一个气泡，最多 5 条，超出的并到最后一条。
// 短句（12 字以内且没有换行）不拆，免得「嗯」也发两条。
// URL 先换占位符再还原，避免长链接被切成两半。
export function splitIntoBubbles(text, config) {
  const raw = String(text || '').trim()
  if (!raw) return []
  let max = Math.max(1, Math.min(5, Number(config && config.splitMaxBubbles) || 3))
  const hasLine = raw.indexOf('\n') >= 0
  // 她自己换行 = 她想分几条说。状态再差也至少分开两条，别把两句话并成一条
  if (hasLine && max < 2) max = 2
  if (max <= 1 || (!hasLine && raw.length <= 12)) return [raw]
  const urls = []
  const masked = raw.replace(/https?:\/\/[^\s，。；、！？!?）)】<>]+/g, (m) => {
    urls.push(m)
    return '\u0000U' + (urls.length - 1) + '\u0000'
  })
  const parts = masked
    .split(/(?<=[。！？!?…~])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [raw]
  const cap = Math.max(2, Math.min(5, Math.max(max, Math.min(parts.length, 5))))
  const out = parts.slice(0, cap).map((s) => s.replace(/\s*\n+\s*/g, ' ').trim()).filter(Boolean)
  const restParts = parts.slice(cap)
  if (restParts.length && out.length) {
    out[out.length - 1] = (out[out.length - 1] + ' ' + restParts.join(' ')).replace(/\s+/g, ' ').trim()
  }
  // 纯省略号/标点的碎片不发（「…」「……」「。」这种单独一条看着像手滑）
  const noise = /^[\s…⋯\-—~～、，。！？!?.,;:：；'"]+$/
  const cleaned = out.length > 1 ? out.filter((s) => !noise.test(s)) : out
  if (!cleaned.length) return [raw]
  // 还原 URL（占位符可能跨段，所以每条单独还原）
  return cleaned.map((s) => s.replace(/\u0000U(\d+)\u0000/g, (_, i) => urls[Number(i)] || ''))
}
