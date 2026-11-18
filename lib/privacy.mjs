/**
 * lib/privacy.mjs — 公开场合的隐私边界
 * ============================================================================
 * 她可以在心里记着主人的一切，但「说出去」的东西（群聊、QQ 空间说说、B 站动态/
 * 评论、个性签名）不能带出可识别的私人信息：QQ 号、手机号、生日、学校/专业、
 * 工作单位、住址，以及私聊里的具体细节。
 * ============================================================================
 */

/** 需要遮蔽的数字身份（主人 QQ、机器人 QQ 等） */
export function privateNumbers(config = {}) {
  const out = new Set()
  for (const v of [config.ownerQq, config.accessAdminId, config.ownerBiliMid]) {
    const s = String(v || '').replace(/\D/g, '')
    if (s.length >= 5) out.add(s)
  }
  // 【2026-11-18】原来在这里硬编码了一个真实小号 QQ，会随插件发布出去。
  // 改成从配置里读（留空就只遮主人自己的号）。
  for (const extra of (Array.isArray(config.privateNumbers) ? config.privateNumbers : [])) {
    const t = String(extra || '').replace(/\D/g, '')
    if (t.length >= 5) out.add(t)
  }
  return [...out]
}

const BIRTH = /((?:生日|出生日期|生日是|生日在)[^，。！？\n]{0,12}?)(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|4\s*[./-]\s*27|四月二十七)/g
const IDENTITY = /(工科生|工科大学生|在读大学生|大学生|研究生|博士生|宿舍|实验室|身份证号?|手机号|家庭住址|住址|学校|学校是[^，。！？\n]{0,10}|专业是[^，。！？\n]{0,10}|工作单位|公司是[^，。！？\n]{0,10})/g

/**
 * 整句都是括号旁白吗：（点进去看了眼照片）(自动点了个赞)【情景】这类
 * 2026-11-16 修：她把这种内心动作当评论发到别人空间去了，一晚上三条。
 */
export function isNarrationOnly(text) {
  const t = String(text || '').trim()
  if (!t) return true
  const m = /^[（(【\[][\s\S]*[）)】\]]$/.exec(t)
  if (!m) return false
  // 里面还有引号包着的人话，就不算纯旁白（（笑）"你好啊"）
  return !/["“「][^"”」]{2,}["”」]/.test(t)
}

/**
 * 把旁白从句子里剥掉，只留真正说出口的话。
 * 开头/结尾/句中独立的（…）都去掉；剥不干净由调用方再判空。
 */
export function stripNarration(text) {
  let t = String(text || '')
  t = t.replace(/^\s*[（(【\[][^（()）【】\[\]]{0,80}[）)】\]]\s*/g, '')
  t = t.replace(/\s*[（(【\[][^（()）【】\[\]]{0,80}[）)】\]]\s*$/g, '')
  t = t.replace(/(^|[，。！？、；：\s])[（(][^（()）]{1,60}[）)]/g, '$1')
  return t.replace(/\s{2,}/g, ' ').trim()
}

/** 这段话作为公开评论还成立吗（有实质内容、不是旁白、不是纯符号）
 *  单字也放行 —— 「啧」「嗯」在评论区是正常反应，别误杀。
 */
export function isSayable(text) {
  const t = String(text || '').trim()
  if (!t || isNarrationOnly(t)) return false
  return /[\u4e00-\u9fa5A-Za-z0-9]/.test(t)
}

/** 把一段要公开发出去的文案过一遍隐私过滤 */
export function scrubPublic(text, config = {}) {
  let s = String(text || '')
  if (!s) return s
  for (const n of privateNumbers(config)) s = s.split(n).join('他')
  s = s.replace(/\b1[3-9]\d{9}\b/g, '他')
  s = s.replace(BIRTH, '$1')
  s = s.replace(IDENTITY, '')
  s = s.replace(/[，、]{2,}/g, '，').replace(/^[，、。；\s]+/, '').replace(/。{2,}/g, '。')
  s = s.replace(/(他){2,}/g, '他')
  return s.trim()
}

/** 检查一段文案里还残留哪些隐私点（给日志用，返回命中的词） */
export function leakHits(text, config = {}) {
  const s = String(text || '')
  const hits = []
  for (const n of privateNumbers(config)) if (s.includes(n)) hits.push(n)
  const phone = s.match(/\b1[3-9]\d{9}\b/)
  if (phone) hits.push(phone[0])
  const birth = s.match(BIRTH)
  if (birth) hits.push(birth[2])
  for (const m of s.matchAll(IDENTITY)) hits.push(m[1])
  return hits
}
