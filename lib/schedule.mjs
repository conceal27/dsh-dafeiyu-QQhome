/**
 * lib/schedule.mjs — 作息（归属：xingzhu）
 * ============================================================================
 * 给她一天的时间感：什么时候醒、什么时候吃饭、困了没。
 * 不是死表：她自己会根据最近几天的聊天微调（熬夜了就晚起、今天没胃口就少吃一顿），
 * 微调结果写在 note / wakeHour / sleepHour 里，并注入提示词。
 *
 * 存储：$DSH_HOME/qq-fish/schedule.json
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from './llm.mjs'
import { recentMessages, stateHome } from './store.mjs'

const FILE = 'schedule.json'

function schedulePath() {
  return join(stateHome(), FILE)
}

/** 默认作息（可按面板/她自己调） */
export function defaultSchedule() {
  return {
    wakeHour: 9,
    sleepHour: 1,
    blocks: [
      { start: 9, end: 10.5, text: '刚醒，还迷糊，赖在床上不想动' },
      { start: 10.5, end: 12, text: '在吃早饭/收拾，手上端着碗' },
      { start: 12, end: 13.5, text: '在吃午饭，碗里还剩半碗白饭' },
      { start: 14, end: 16, text: '下午，有点犯困但没睡，可能在刷手机或者干活' },
      { start: 18, end: 19.5, text: '在吃晚饭' },
      { start: 22, end: 24, text: '有点困了，说话开始懒' },
      { start: 0, end: 1, text: '困得不行，随时会睡过去' },
    ],
    note: '',
    evolvedAt: 0,
    updatedAt: 0,
  }
}

export function loadSchedule() {
  try {
    if (!existsSync(schedulePath())) return defaultSchedule()
    const raw = JSON.parse(readFileSync(schedulePath(), 'utf8'))
    const base = defaultSchedule()
    return {
      wakeHour: Number.isFinite(Number(raw.wakeHour)) ? Number(raw.wakeHour) : base.wakeHour,
      sleepHour: Number.isFinite(Number(raw.sleepHour)) ? Number(raw.sleepHour) : base.sleepHour,
      blocks: Array.isArray(raw.blocks) && raw.blocks.length ? raw.blocks : base.blocks,
      note: String(raw.note || '').slice(0, 200),
      evolvedAt: Number(raw.evolvedAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return defaultSchedule()
  }
}

export function saveSchedule(next) {
  const file = schedulePath()
  try {
    mkdirSync(stateHome(), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(Object.assign(loadSchedule(), next, { updatedAt: Date.now() }), null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function fmtHour(h) {
  const hh = Math.floor(h) % 24
  const mm = Math.round((h - Math.floor(h)) * 60)
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
}

/** 现在是睡着还是在干嘛 */
export function scheduleState(now = Date.now()) {
  const s = loadSchedule()
  const d = new Date(now)
  const h = d.getHours() + d.getMinutes() / 60
  const sleep = Number(s.sleepHour)
  const wake = Number(s.wakeHour)
  const sleeping = sleep > wake ? (h >= sleep || h < wake) : (h >= sleep && h < wake)
  if (sleeping) {
    return { sleeping: true, phase: 'sleep', text: `这个点（${fmtHour(h)}）你已经睡了，被叫醒会迷糊、说话会带起床气` }
  }
  for (const b of s.blocks || []) {
    const st = Number(b.start)
    const en = Number(b.end)
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue
    if (h >= st && h < en) return { sleeping: false, phase: 'block', text: `现在 ${fmtHour(h)}，你${String(b.text || '在忙')}` }
  }
  return { sleeping: false, phase: 'awake', text: `现在 ${fmtHour(h)}，你醒着，没在忙什么特别的事` }
}

/** 注入提示词的一段 */
export function scheduleBlock(now = Date.now()) {
  const s = loadSchedule()
  const st = scheduleState(now)
  const lines = [`【你现在的状态】${st.text}。`]
  // 状态 → 行为：光说"你困了"没用，得说清楚困了会怎样说话
  const h = new Date(now).getHours()
  if (st.sleeping) {
    lines.push('被叫醒的时候，你的话会变得很短、很懒，只想赶紧回到睡里——不会想展开话题，也不会想留人。对方说「晚安」「你睡吧」，你会松一口气，而不是觉得可惜。')
  } else if (h >= 22 || h < 1) {
    lines.push('这个点你已经开始困了：话会变少、变懒，回得慢一点也正常，不会主动抛新话题。')
  } else if (h >= 13 && h < 16) {
    lines.push('下午这个点你容易犯困：说话会有点没劲，但不是没精神，就是懒洋洋的。')
  } else if (h >= 9 && h < 11) {
    lines.push('刚醒不久，人还没完全醒透：反应会慢半拍，说话直来直去，不太绕弯子。')
  }
  if (s.note) lines.push(`（你最近给自己记的：${s.note}）`)
  lines.push('（这是你自己的作息，自然带出来就行，不用每句都报时间；别人问你在干嘛，就按这个说，别编。）')
  return lines.join('\n')
}

/** 到点没？每小时来问一次「作息要不要调」 */
export function shouldEvolve(hours = 24, now = Date.now()) {
  const s = loadSchedule()
  const gap = Math.max(1, Number(hours) || 24) * 3600 * 1000
  return now - Number(s.evolvedAt || 0) >= gap
}

/**
 * 让她自己想想：最近这样聊下来，作息要不要调。
 * 只允许微调（晚起一小时、熬了夜、今天没胃口），不允许改成一天睡 20 小时。
 */
export async function evolveSchedule(options = {}) {
  const { ctx, config, log } = options
  const s = loadSchedule()
  const now = Date.now()
  // 【熬夜联动】昨晚她刷 B 站刷到很晚 → 今天该晚起一点（不然作息和实际对不上）
  let nightOwl = false
  try {
    const raw = JSON.parse(readFileSync(join(stateHome(), 'scheduler.json'), 'utf8'))
    const t = Number((raw && raw.lastNightOwlAt) || 0)
    nightOwl = t > 0 && now - t < 30 * 3600 * 1000
  } catch {}
  const cutoff = now - 24 * 3600 * 1000
  let rows = []
  try {
    rows = recentMessages(400).filter((r) => r && Number(r.ts) >= cutoff && r.text)
  } catch {
    rows = []
  }
  if (rows.length < 6) {
    // 聊得太少就不改，只记一个检查时间，免得反复调
    saveSchedule({ evolvedAt: now })
    return { changed: false, reason: '聊天太少' }
  }
  const body = rows
    .slice(-40)
    .map((r) => {
      const d = new Date(Number(r.ts) || now)
      const t = String(r.text).replace(/\s+/g, ' ').slice(0, 90)
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${r.direction === 'out' ? '你' : String(r.who || '对方').slice(0, 12)}：${t}`
    })
    .join('\n')
  const name = String((config && config.personaName) || '她')
  const system = [
    `你在帮「${name}」调整她自己的作息。看最近一天的聊天，判断她要不要微调。`,
    '只输出 JSON，不要解释：',
    '{"note":"今天的状态，20字内","wakeHour":数字或null,"sleepHour":数字或null}',
    '规则：',
    '- 只有在聊天里真的能看出作息变化时才改（熬夜到很晚、起得早、今天没吃饭、白天很困）。',
    '- wakeHour 只能是 7~12；sleepHour 只能是 22~4（写 22/23/0/1/2/3/4）。',
    '- 没有依据就输出 {"note":"","wakeHour":null,"sleepHour":null}。',
    `- 现在的作息是：${s.wakeHour} 点醒，${s.sleepHour >= 22 ? s.sleepHour : s.sleepHour + 24} 点睡。`,
  ].join('\n')
  let generated
  try {
    generated = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: '最近的聊天：\n' + body + '\n\n只输出 JSON。' }],
      config,
      temperature: 0.2,
      maxTokens: 200,
      timeoutMs: 40_000,
      log: log ? (line) => log.warn(line) : undefined,
    })
  } catch (e) {
    return { changed: false, reason: String((e && e.message) || e) }
  }
  if (!generated || !generated.ok) return { changed: false, reason: (generated && generated.reason) || '生成失败' }
  const text = String(generated.text || '')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) {
    saveSchedule({ evolvedAt: now })
    return { changed: false, reason: '没有 JSON' }
  }
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch {
    saveSchedule({ evolvedAt: now })
    return { changed: false, reason: 'JSON 解析失败' }
  }
  const patch = { evolvedAt: now }
  const note = String(parsed.note || '').trim().slice(0, 200)
  if (note) patch.note = note
  const wake = Number(parsed.wakeHour)
  if (Number.isFinite(wake) && wake >= 7 && wake <= 12 && wake !== s.wakeHour) patch.wakeHour = Math.round(wake)
  let sleep = Number(parsed.sleepHour)
  if (Number.isFinite(sleep)) {
    sleep = Math.round(sleep)
    if (sleep >= 0 && sleep <= 4) sleep = sleep // 凌晨
    const ok = (sleep >= 22 && sleep <= 24) || (sleep >= 0 && sleep <= 4)
    if (ok && sleep !== s.sleepHour) patch.sleepHour = sleep
  }
  // 【熬夜联动】有熬夜标记且模型没主动调作息 → 自动晚起一小时
  if (nightOwl && patch.wakeHour === undefined) {
    const nextWake = Math.min(12, Number(s.wakeHour || 9) + 1)
    if (nextWake !== Number(s.wakeHour)) {
      patch.wakeHour = nextWake
      if (!patch.note) patch.note = '昨晚刷视频刷太晚，今天起晚了'
    }
  }
  const changed = Object.keys(patch).length > 1
  saveSchedule(patch)
  if (log && changed) log.info(`[作息] ${note || ''} wake=${patch.wakeHour ?? s.wakeHour} sleep=${patch.sleepHour ?? s.sleepHour}`)
  return { changed, note: patch.note || '', wakeHour: patch.wakeHour ?? s.wakeHour, sleepHour: patch.sleepHour ?? s.sleepHour }
}
