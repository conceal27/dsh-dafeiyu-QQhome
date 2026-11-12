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
  const account = config.account && typeof config.account === 'object' ? config.account.uin : ''
  // accessAdminIds 是逗号/空格分隔的多管理员列表，要拆开逐个处理
  const extra = String(config.accessAdminIds || '').split(/[,，\s]+/).filter(Boolean)
  for (const v of [config.ownerQq, config.accessAdminId, config.ownerBiliMid, config.selfQq, account, ...extra]) {
    // 面板里存的是打码过的号（如 32******01），只取纯数字且够长的
    const raw = String(v || '')
    if (raw.includes('*')) continue
    const s = raw.replace(/\D/g, '')
    if (s.length >= 5) out.add(s)
  }
  return [...out]
}

const BIRTH = /((?:生日|出生日期|生日是|生日在)[^，。！？\n]{0,12}?)(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|4\s*[./-]\s*27|四月二十七)/g
const IDENTITY = /(工科生|工科大学生|在读大学生|大学生|研究生|博士生|宿舍|实验室|身份证号?|手机号|家庭住址|住址|学校|学校是[^，。！？\n]{0,10}|专业是[^，。！？\n]{0,10}|工作单位|公司是[^，。！？\n]{0,10})/g

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
