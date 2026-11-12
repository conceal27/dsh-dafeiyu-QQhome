/**
 * lib/member-impressions.mjs — 群友印象标签
 * ============================================================================
 * 她「认得这群人」：从群消息里统计每个人的行为（话多/爱发图/爱语音/爱逗她/夜猫子），
 * 生成标签，群聊时注入提示词。纯统计，不调模型，零额外成本。
 * 存储：$DSH_HOME/qq-fish/member-impressions.json
 * ============================================================================
 */
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stateHome } from './store.mjs'

const MAX_PER_GROUP = 200
const NIGHT_START = 0
const NIGHT_END = 6

function filePath() {
  return join(stateHome(), 'member-impressions.json')
}

export function loadImpressions() {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (raw && typeof raw === 'object' && raw.groups) return raw
  } catch {}
  return { version: 1, groups: {} }
}

function saveImpressions(data) {
  try {
    mkdirSync(stateHome(), { recursive: true })
    writeFileSync(filePath(), JSON.stringify(data), 'utf8')
  } catch {}
}

export function recordMemberMessage(groupId, msg, text) {
  const gid = String(groupId || '')
  const qq = String((msg && msg.senderId) || '').replace(/\D/g, '')
  if (!gid || !qq) return
  const data = loadImpressions()
  const group = data.groups[gid] || {}
  const stat = group[qq] || { qq, name: '', count: 0, images: 0, voices: 0, ats: 0, night: 0, lastAt: 0 }
  const t = String(text || '')
  stat.name = String((msg && msg.who) || stat.name || '').slice(0, 24)
  stat.count += 1
  if (/\[图片\]/.test(t)) stat.images += 1
  if (/\[语音\]/.test(t)) stat.voices += 1
  const selfId = String((msg && msg.selfId) || '').replace(/\D/g, '')
  if (selfId && t.includes('@' + selfId)) stat.ats += 1
  if (msg && msg.atMe) stat.ats += 1
  const hour = new Date().getHours()
  if (hour >= NIGHT_START && hour < NIGHT_END) stat.night += 1
  stat.lastAt = Date.now()
  group[qq] = stat
  const arr = Object.values(group).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, MAX_PER_GROUP)
  data.groups[gid] = Object.fromEntries(arr.map((s) => [s.qq, s]))
  saveImpressions(data)
}

export function tagsOf(stat) {
  const tags = []
  if (Number(stat.count) >= 30) tags.push('话痨')
  if (Number(stat.images) >= 5) tags.push('爱发图')
  if (Number(stat.voices) >= 3) tags.push('爱语音')
  if (Number(stat.ats) >= 3) tags.push('爱逗她')
  if (Number(stat.night) >= 5) tags.push('夜猫子')
  if (!tags.length && Number(stat.count) >= 5) tags.push('常客')
  return tags
}

export function memberNotesFor(groupId, limit = 8) {
  const gid = String(groupId || '')
  const data = loadImpressions()
  const group = data.groups[gid] || {}
  const rows = Object.values(group)
    .filter((s) => s && s.count >= 3)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, limit)
    .map((s) => {
      const tags = tagsOf(s)
      if (!tags.length) return null
      return `${s.name || '某人'}（${s.qq}）：${tags.join('、')}`
    })
    .filter(Boolean)
  return rows.length ? rows.join('\n') : ''
}

export function impressionsSnapshot() {
  return loadImpressions()
}
