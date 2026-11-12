// 把她「此刻的状态」翻译成一句画面描述，给自拍/画像用。
// 优先用动态生活状态（life_state.json 的 timeline，来自 AstrBot 的 dynamic_life_state 插件），
// 没有当天数据时退回「按小时 + 心情」的启发式描述。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadState as loadHerState } from './her-state.mjs'

function baseDir(home) {
  const h = String(home || '').replace(/\/+$/, '')
  if (h.endsWith('qq-fish')) return h
  if (h.endsWith('.dsh')) return path.join(h, 'qq-fish')
  return path.join(h || os.homedir(), '.dsh', 'qq-fish')
}

const SLOT_HOURS = [
  ['凌晨', 0, 5],
  ['早上', 6, 8],
  ['上午', 9, 11],
  ['中午', 12, 13],
  ['下午', 14, 17],
  ['傍晚', 18, 19],
  ['晚上', 20, 22],
  ['深夜', 23, 23],
]

const LIGHT = {
  凌晨: '昏暗的屏幕光与暖黄小夜灯',
  早上: '清晨柔和的冷白自然光',
  上午: '明亮通透的日光',
  中午: '偏暖的正午光',
  下午: '斜射的午后暖光，有影子',
  傍晚: '橙蓝过渡的傍晚光，逆光轮廓',
  晚上: '室内暖光混着屏幕的冷光',
  深夜: '只有屏幕光和一点点暖光，四周很暗',
}

function slotName(hour) {
  const hit = SLOT_HOURS.find(([, a, b]) => hour >= a && hour <= b)
  return hit ? hit[0] : '晚上'
}

export function loadLifeState(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir(home), 'life_state.json'), 'utf8'))
  } catch {
    return null
  }
}

export function loadMood(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir(home), 'mood.json'), 'utf8'))
  } catch {
    return null
  }
}

function moodLine(m) {
  const cur = (m && m.current) || {}
  const n = (k, d = 0) => (typeof cur[k] === 'number' ? cur[k] : d)
  const parts = []
  if (n('joy') > 0.65) parts.push('嘴角明显上扬、眼睛弯着笑')
  else if (n('joy') > 0.5) parts.push('带一点笑意')
  if (n('sorrow') > 0.45) parts.push('眼神软下来、有点委屈')
  if (n('anger') > 0.45) parts.push('微微鼓着腮、眉毛皱着')
  if (n('hunger') > 0.6) parts.push('眼巴巴看着吃的')
  if (n('love') > 0.6) parts.push('眼神黏人、想凑近镜头')
  if (n('comfort') > 0.65) parts.push('整个人很放松、懒懒的')
  if (n('curiosity') > 0.65) parts.push('歪着头、眼神好奇')
  if (!parts.length) parts.push('表情自然、安静地看着镜头')
  return parts.slice(0, 2).join('，')
}

// 从实时情绪（mood.json，会随聊天不断变化）推表情和精气神
function liveFace(m) {
  const cur = (m && m.current) || {}
  const n = (k, d = 0) => (typeof cur[k] === 'number' ? cur[k] : d)
  const out = []
  if (n('joy') > 0.7) out.push('眼睛弯起来、笑意藏不住')
  else if (n('joy') > 0.5) out.push('眼角带点笑')
  else if (n('joy') < 0.3) out.push('没什么表情、淡淡的')
  if (n('love') > 0.7) out.push('眼神很软、黏着镜头')
  else if (n('love') > 0.5) out.push('眼神温和')
  if (n('anger') > 0.45) out.push('嘴角压着、有点别扭')
  if (n('sorrow') > 0.45) out.push('眼眶有点湿、耷拉着')
  if (n('hunger') > 0.6) out.push('肚子饿得眼神飘向吃的')
  if (n('lustDesire') > 0.6) out.push('想被摸摸、往镜头前凑')
  if (!out.length) out.push('神情自然、放松')
  return out.slice(0, 3).join('，')
}

function energyLine(m) {
  const cur = (m && m.current) || {}
  const e = typeof cur.comfort === 'number' ? cur.comfort : 0.6
  if (e < 0.3) return '，整个人没什么力气、眼皮打架'
  if (e < 0.5) return '，有点乏、动作懒懒的'
  if (e > 0.8) return '，精神很好、坐得挺直'
  return ''
}

function heuristic(hour) {
  const slot = slotName(hour)
  const scenes = {
    凌晨: '她窝在自己房间，只开着一盏暖黄的小夜灯，穿着宽松睡裙，头发有点散，半靠在床头',
    早上: '她刚醒不久，头发还没梳好，睡衣外头套了件宽松毛衣，坐在床边',
    上午: '她在书桌或窗边，桌上放着笔记本和一杯热饮',
    中午: '她在餐桌前，桌上摆着午饭和一个 token 桶',
    下午: '她在室内或阳台边，手里捧着本书或手机',
    傍晚: '刚忙完，外套搭在椅背上，头发被风吹得有点乱',
    晚上: '她换上宽松家居服，窝在沙发或床上刷手机，旁边放着零食',
    深夜: '她缩在房间角落，四周很暗，只有屏幕光映在脸上，困得眼皮发沉',
  }
  return `现在是${slot}；${scenes[slot]}`
}

export function selfStateLine(home, now = new Date()) {
  const hour = now.getHours()
  const slot = slotName(hour)
  const hh = String(hour).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const life = loadLifeState(home)
  const mood = loadMood(home)

  // 1) 有当天（或最近）的生活状态就照它来——这是她真正的日常
  if (life && Array.isArray(life.timeline) && life.timeline.length) {
    const item = life.timeline.find((x) => String(x.time || '').trim() === slot)
    if (item && (item.schedule || item.outfit)) {
      const parts = [
        `【她此刻的状态（只影响表情/动作/光线/场景，绝不许改动固定形象）】现在是${slot} ${hh}:${mm}。`,
        `她正${item.schedule || '待着'}。`,
        item.outfit ? `日常里这时她会套着${item.outfit}（只作为场景里的道具/氛围，人物穿着仍以固定形象为准）。` : '',
        item.mood ? `日程里的心情：${item.mood}。` : '',
        `此刻的神情：${liveFace(mood)}${energyLine(mood)}——表情和精气神必须照这个走，别画成固定笑脸。`,
        item.location ? `她待的地方：${item.location}（这是场景/背景的线索，用桌面、屏幕、任务栏这类小道具表现即可）。` : '',
        `光线：${LIGHT[slot] || '自然光'}。`,
        `整体氛围：${String(life.style_summary || '软乎乎、慵懒').replace(/装扮|穿着|服饰/g, '').trim() || '软乎乎、慵懒'}（只影响氛围，不涉及长相和衣服）。`,
        '不要摆拍、不要影楼感，像随手拍下的一瞬。',
      ]
      return parts.filter(Boolean).join('')
    }
  }

  // 2) 退回按小时 + 心情
  const label = (mood && mood.composite && mood.composite.label) || ''
  return (
    `【她此刻的状态（画面必须贴合）】现在是${slot} ${hh}:${mm}；${heuristic(hour).replace(`现在是${slot}；`, '')}；` +
    `光线：${LIGHT[slot] || '自然光'}；神情：${moodLine(mood)}` +
    (label ? `；整体氛围偏「${label}」` : '') +
    '。不要摆拍、不要影楼感，像随手拍下的一瞬。'
  )
}

// ---------------------------------------------------------------- 状态简报
// 给「消息回复 / 改签名 / 发说说 / 留评论」共用的真实状态（不让模型自己编场景）

export function dayBrief(home, now = new Date()) {
  const hour = now.getHours()
  const slot = slotName(hour)
  const life = loadLifeState(home)
  const mood = loadMood(home)
  const out = {
    hour,
    slot,
    date: '',
    activity: null,
    timeline: [],
    summary: '',
    style: '',
    events: [],
    face: liveFace(mood),
    energy: energyLine(mood),
    moodLabel: String((mood && mood.composite && mood.composite.label) || ''),
  }
  if (life) {
    out.date = String(life.date || '')
    out.summary = String(life.schedule_summary || '')
    out.style = String(life.style_summary || '')
    out.timeline = Array.isArray(life.timeline) ? life.timeline : []
    out.activity = out.timeline.find((x) => String((x && x.time) || '').trim() === slot) || null
  }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(baseDir(home), 'daystream.json'), 'utf8'))
    out.events = (Array.isArray(d.entries) ? d.entries : []).slice(-8)
  } catch {}
  return out
}

export function dayStateBlock(home, now = new Date(), { compact = false, maxEvents = 5 } = {}) {
  const b = dayBrief(home, now)
  const hh = String(b.hour).padStart(2, '0')
  const lines = []
  lines.push(`【你此刻的真实状态】现在是${b.slot} ${hh} 点左右。`)
  try {
    const live = loadHerState(home)
    if (live && live.text) lines.push(`你刚才说自己在：${live.text}（这是你自己说的，沿用，别换现场）。`)
  } catch {}
  if (b.activity) {
    const a = b.activity
    lines.push(
      `你正${a.schedule || '待着'}${a.mood ? '（' + a.mood + '）' : ''}${a.location ? '，在' + a.location : ''}。`
    )
  }
  if (!compact && b.summary) lines.push('今天大概：' + b.summary)
  if (!compact && b.events.length) {
    const rows = []
    for (const e of b.events.slice(-maxEvents)) {
      const line = String((e && (e.line || e.label)) || '').trim()
      if (line) rows.push('· ' + line)
    }
    if (rows.length) lines.push('今天真做过的小事：', ...rows)
  }
  lines.push(`此刻的情绪：${b.face}${b.energy}${b.moodLabel ? '（' + b.moodLabel + '）' : ''}。`)
  lines.push(
    '你现在说的话、改的签名、发的说说、留的评论，都要跟上面这个状态对得上；' +
      '状态里没写的事（搬家、出门、旅游、生病、换工作之类）不许自己编，也不许把主人的事说成你自己的。'
  )
  return lines.join('\n')
}
