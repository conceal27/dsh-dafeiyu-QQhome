/**
 * lib/panel-data.mjs — 面板数据层（DSH 面板和 8082 控制台共用）
 * ============================================================================
 * 这里的每一项都只读 config.json / body.json，写只走 store.saveConfig / body.saveBody，
 * 保证两个前端看到的、改的都是同一份数据。
 * ============================================================================
 */
import { loadConfig, DEFAULT_CONFIG } from './store.mjs'
import { loadBody, saveBody, cycleDay, phaseOf, bodyPromptBlock, cycleForecast, SYMPTOM_GROUPS, ALL_SYMPTOMS, rerollToday, phaseOnDate, hormoneLevels } from './body.mjs'
import { curiositySnapshot, addCuriosity, clearCuriosity } from './curiosity.mjs'
import { intentSnapshot, addIntent, clearIntents, finishIntent, dropIntent } from './intent.mjs'
import { lifeSnapshot, addMilestone, scanMilestones } from './life.mjs'
import { reinterpretSnapshot, clearReinterpret } from './reinterpret.mjs'
import { tuneSnapshot, approveProposal, rejectProposal } from './selftune.mjs'
import { watchSnapshot } from './biliwatch.mjs'
import { organicSnapshot, forceFullTension } from './organic.mjs'
import { readMood, writeMood, moodSnapshot } from './vitals.mjs'
import { stateHome } from './store.mjs'

/** 她的「内心」：好奇 / 意图 / 人生 / 重解（面板和 8082 共用） */
export async function innerSnapshot() {
  const [curiosity, intent, life, reinterpret] = await Promise.all([
    curiositySnapshot().catch(() => ({})),
    intentSnapshot().catch(() => ({})),
    lifeSnapshot().catch(() => ({})),
    reinterpretSnapshot().catch(() => ({})),
  ])
  return { curiosity, intent, life, reinterpret }
}

/** 她在 B 站看了什么、想了什么 */
export function biliSnapshot(limit = 30) {
  return watchSnapshot(limit)
}

/** 她自己调设置的档案：能改什么、改过什么、提了什么案 */
export function tuneState() {
  return tuneSnapshot()
}

export function tuneAction(action, payload = {}) {
  if (action === 'approve') return approveProposal(payload.id)
  if (action === 'reject') return rejectProposal(payload.id)
  return { ok: false, error: 'unknown action: ' + action }
}

export async function innerAction(action, payload = {}) {
  const a = String(action || '')
  if (a === 'curiosity-add') { await addCuriosity(payload.word, { why: payload.why || '手动加的', source: 'manual' }); return innerSnapshot() }
  if (a === 'curiosity-clear') { await clearCuriosity(payload.id); return innerSnapshot() }
  if (a === 'intent-add') { await addIntent(payload.text, { kind: 'want', reason: '手动加的' }); return innerSnapshot() }
  if (a === 'intent-done') { await finishIntent(payload.id); return innerSnapshot() }
  if (a === 'intent-drop') { await dropIntent(payload.id); return innerSnapshot() }
  if (a === 'intent-clear') { await clearIntents(); return innerSnapshot() }
  if (a === 'milestone-add') { await addMilestone(payload.title, payload.detail || ''); return innerSnapshot() }
  if (a === 'milestone-scan') { await scanMilestones(); return innerSnapshot() }
  if (a === 'reinterpret-clear') { await clearReinterpret(); return innerSnapshot() }
  return { error: 'unknown action: ' + a }
}

export const PHASE_LABEL = { period: '经期', follicular: '卵泡期', ovulation: '排卵期', luteal: '黄体期', pms: '经前期' }

/** 本地日期（千万别用 toISOString：那是 UTC，凌晨 0-8 点会显示成前一天） */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** DSH 面板没有入口、但后端确实支持的可调项（按用途分组） */
export const ADVANCED_GROUPS = [
  {
    title: '生活',
    keys: [
      ['moodEnabled', '心情系统', '被哄/被骂/被撩之后情绪会真的变'],
      ['diaryEnabled', '写日记', '每天写一篇'],
      ['diaryHour', '日记时间（点）', '0-23'],
      ['reviewEnabled', '复盘', '日/周/月总结'],
      ['reviewWeeklyDay', '周复盘（周几）', '1=周一'],
      ['reviewMonthlyDay', '月复盘（几号）', '1-28'],
      ['promiseEnabled', '承诺', '答应你的事会记着'],
    ],
  },
  {
    title: '群聊',
    keys: [
      ['groupReplyMode', '接话方式', 'mention=只接@ / smart=模型判断 / all=都接'],
      ['atEnforce', '@ 必回', '被 @ 时一定回'],
      ['repetitionGuard', '防复读', '和最近说的太像会自动重写'],
      ['autoLearn', '自动学习', '从聊天里自己学人事'],
    ],
  },
  {
    title: '拟真细节',
    keys: [
      ['typingMaxMs', '打字延迟上限（毫秒）', '越大越像真人，也越慢'],
      ['bubbleGapMinMs', '气泡间隔下限（毫秒）', ''],
      ['bubbleGapMaxMs', '气泡间隔上限（毫秒）', ''],
      ['splitMaxBubbles', '最多分几条', '2-8'],
    ],
  },
  {
    title: '表情包',
    keys: [
      ['stickerMaxPerDay', '每日上限', ''],
      ['stickerCooldownSec', '冷却（秒）', ''],
      ['stickerMinScore', '相似度阈值', '0-1'],
      ['stickerJudge', '模型挑图', '让她自己判断哪张合适'],
      ['stickerReview', '审图', ''],
      ['imageReplyInGroup', '群里也发图', '关掉只在私聊发'],
    ],
  },
  {
    title: '视听',
    keys: [
      ['videoMaxMb', '视频体积上限（MB）', ''],
      ['videoMaxSeconds', '视频时长上限（秒）', ''],
      ['asrLanguage', '语音识别语言', 'zh / en / auto'],
      ['asrBiliMaxSeconds', 'B站视频转写上限（秒）', ''],
    ],
  },
  {
    title: 'B站',
    keys: [
      ['biliAutoLike', '看完自动点赞', '会留痕迹，默认关'],
      ['biliAutoFav', '看完自动收藏', ''],
      ['biliTasteKeywords', '口味关键词', '逗号分隔'],
      ['biliExcludeKeywords', '排除关键词', '逗号分隔'],
    ],
  },
  {
    title: '权限与演化',
    keys: [
      ['accessAdminIds', '管理员 QQ', '逗号分隔，多个'],
      ['evolveMaxTraits', '最多保留几条性格变化', ''],
    ],
  },
]

/** 高级项快照：每项带类型，前端据此渲染控件 */
export function advancedSnapshot() {
  const cfg = loadConfig()
  return ADVANCED_GROUPS.map((g) => ({
    title: g.title,
    items: g.keys.map(([key, label, hint]) => {
      const v = cfg[key]
      let type = 'text'
      if (typeof v === 'boolean') type = 'bool'
      else if (typeof v === 'number') type = 'number'
      return { key, label, hint, type, value: v, known: key in DEFAULT_CONFIG }
    }),
  }))
}

/** 写高级项：只允许白名单内的键，值交给 saveConfig 的 clamp 兜底 */
export function applyAdvanced(patch) {
  const allowed = new Set(ADVANCED_GROUPS.flatMap((g) => g.keys.map((k) => k[0])))
  const clean = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (allowed.has(k)) clean[k] = v
  }
  saveConfig(clean)
  return { ok: true, groups: advancedSnapshot() }
}

/** 让她重新感觉一次（主人唯一能做的干预） */
export async function rerollBody() {
  await rerollToday()
  return { ok: true, ...(await bodySnapshot()) }
}

/** 月历：当月每一天的阶段（未来日期标 predicted） */
function buildCalendar(b, now = new Date()) {
  const y = now.getFullYear()
  const m = now.getMonth()
  const p = (n) => String(n).padStart(2, '0')
  const startPad = new Date(y, m, 1).getDay() // 0 = 周日
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${p(m + 1)}-${p(d)}`
    const info = phaseOnDate(b, ds) || {}
    cells.push({ d, ds, day: info.day || 0, phase: info.phase || '', predicted: !!info.predicted })
  }
  return { year: y, month: m + 1, cells }
}

/** 她此刻的身体状态 + 会注入的提示词 */
export async function bodySnapshot() {
  const b = await loadBody()
  const day = cycleDay(b)
  const phase = phaseOf(day, b)
  return {
    body: b,
    day,
    phase,
    phaseLabel: PHASE_LABEL[phase] || phase,
    preview: bodyPromptBlock(b),
    today: localDate(),
    forecast: cycleForecast(b),
    hormones: hormoneLevels(b),
    phases: PHASE_LABEL,
    symptomGroups: SYMPTOM_GROUPS,
    calendar: buildCalendar(b),
  }
}

/** 写身体状态（带范围保护） */
/** 主人手动调欲望四维（0-100 传进来，内部 0-1 存）。不传的键不动。 */
export function applyDesire(patch = {}) {
  const m = readMood(stateHome())
  const keys = ['lust', 'lewd', 'possess', 'shame']
  let changed = 0
  for (const k of keys) {
    if (!patch || !(k in patch)) continue
    const v = Number(patch[k])
    if (!Number.isFinite(v)) continue
    m[k] = Math.min(1, Math.max(0, v / 100))
    changed++
  }
  if (changed) {
    m.updatedAt = Date.now()
    writeMood(stateHome(), m, { force: true })
  }
  return { ok: true, changed, ...moodSnapshot(m) }
}

export async function applyBody(patch) {
  const clean = {}
  // 身体感受（flow / pain / symptoms）不开放给主人写——那是她自己长出来的
  for (const k of ['cycleStart', 'cycleDays', 'periodDays', 'intimacy', 'note', 'enabled', 'extraPrompt', 'alwaysPrompt']) {
    if (patch && k in patch) clean[k] = patch[k]
  }
  if (clean.cycleStart && !/^\d{4}-\d{2}-\d{2}$/.test(clean.cycleStart)) delete clean.cycleStart
  if ('cycleDays' in clean) clean.cycleDays = Math.min(45, Math.max(20, Number(clean.cycleDays) || 28))
  if ('periodDays' in clean) clean.periodDays = Math.min(10, Math.max(1, Number(clean.periodDays) || 5))
  if ('intimacy' in clean) clean.intimacy = Math.min(400, Math.max(0, Number(clean.intimacy) || 0))
  if ('note' in clean) clean.note = String(clean.note || '').slice(0, 120)
  if ('extraPrompt' in clean) clean.extraPrompt = String(clean.extraPrompt || '').slice(0, 500)
  if ('alwaysPrompt' in clean) {
    const next = String(clean.alwaysPrompt || '').trim()
    let prev = ''
    try { prev = String((await loadBody()).alwaysPrompt || '').trim() } catch {}
    if (!next && prev) {
      // 显式清空才清（前端要清空得传 __CLEAR__），否则忽略这次空值
      if (clean.alwaysPrompt === '__CLEAR__') clean.alwaysPrompt = ''
      else delete clean.alwaysPrompt
    } else {
      clean.alwaysPrompt = next.slice(0, 1500)
    }
  }
  if ('enabled' in clean) clean.enabled = !!clean.enabled
  await saveBody(clean)
  return { ok: true, ...(await bodySnapshot()) }
}


/** 神经-体液：当前张力 + 可调参数 */
export function organicState() {
  const cfg = loadConfig()
  const snap = organicSnapshot()
  return {
    ...snap,
    thresholdCfg: Number(cfg.organicThreshold) || 85,
    rateCfg: Number(cfg.organicRate) || 0.75,
  }
}

/** 面板动作：现在就想让她找你 */
export function organicAction(action) {
  if (action === 'force') {
    forceFullTension()
    return { ok: true, ...organicState() }
  }
  if (action === 'state') return { ok: true, ...organicState() }
  return { ok: false, error: 'unknown action: ' + action }
}
