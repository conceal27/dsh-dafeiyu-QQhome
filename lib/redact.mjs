/**
 * lib/redact.mjs — 脱敏与安全日志（归属：xingzhu）
 * ============================================================================
 * 规则（与实现一致）：
 *   1. 面板 / 日志里 QQ 号/UIN 永远只显示首尾各 2 位（如 12345678 → 12****78）；
 *      本机 messages.jsonl 需要保留真实 id 才能回复/推送，落盘用原文（见 SECURITY.md）；
 *   2. 手机号、身份证号在面板展示文本里打码（bridge.getMessages 按 privacyMode 调用）；
 *   3. access_token / 密钥类字段永不写日志、不回显面板；
 *   4. privacyMode 控制面板展示层是否对消息文本脱敏，不改变本机存储（本地数据属用户自己）。
 * ============================================================================
 */

/** QQ 号脱敏：保留首位与末两位，中间星号；短号也按规则处理 */
export function maskUin(uin) {
  const text = String(uin || '').replace(/\D/g, '')
  if (text === '') return ''
  if (text.length === 1) return text + '*'
  if (text.length === 2) return text[0] + '*'
  if (text.length <= 4) return text[0] + '*'.repeat(Math.max(1, text.length - 2)) + text.slice(-1)
  return text.slice(0, 2) + '*'.repeat(Math.max(2, text.length - 4)) + text.slice(-2)
}

/** 手机号 / 身份证 / 银行卡：只用于展示，不做反向还原 */
export function maskSensitiveText(text) {
  let value = String(text || '')
  value = value.replace(/\b1[3-9]\d{9}\b/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
  value = value.replace(/\b\d{17}[\dXx]\b/g, (m) => m.slice(0, 6) + '********' + m.slice(-4))
  value = value.replace(/\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/g, (m) => m.slice(0, 4) + ' **** **** ' + m.slice(-4))
  return value
}

/** 脱敏一条要写进本地面板日志的消息（privacyMode 开启时更严格） */
export function redactMessage(record, privacyMode) {
  const out = { ...record }
  if (out.uin) out.uin = maskUin(out.uin)
  if (out.groupId) out.groupId = maskUin(out.groupId)
  if (out.text && privacyMode) out.text = maskSensitiveText(String(out.text).slice(0, 2000))
  return out
}

/** 日志里不出现 token / 密钥 / 本地绝对路径以外的敏感串 */
export function scrubLogLine(line) {
  return String(line)
    .replace(/(token|secret|password|appid|appsecret)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\b[0-9a-f]{32,}\b/gi, (m) => m.slice(0, 6) + '***')
}

/** 构造一个安全 logger：默认带 [qq-fish] 前缀，并且过滤敏感串 */
export function createLogger(prefix = '[qq-fish]') {
  const write = (level, args) => {
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : safeJson(arg)))
      .join(' ')
    const safe = scrubLogLine(line)
    if (level === 'error') console.error(`${prefix} ${safe}`)
    else if (level === 'warn') console.warn(`${prefix} ${safe}`)
    else console.log(`${prefix} ${safe}`)
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 面板事件流里展示的时间：ISO + 本地时间戳都用上，方便核对 */
export function stampOf(ms) {
  const date = new Date(Number(ms) || Date.now())
  const iso = date.toISOString()
  const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  return { iso, local, ms: date.getTime() }
}
