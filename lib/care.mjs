/**
 * lib/care.mjs — 他需要什么，她记着，然后真的做点什么
 * ============================================================================
 * 2026-11-16 主人：「关心系统有问题，最近的对话让我不舒服」
 *
 * 查出来的问题不是「她不会关心」，是**关心的方向整个反了**：
 *   近 24 小时她说了 158 句，带关心意味的只有 6 句（4%）；
 *   提「你」74 次，提「我/token」95 次。
 * 问她「你了解我多少」，她背出来的是记忆卡里存着的资料：
 *   「你爱喝冰美式，怕黑，喜欢坦克400，军校的，生日四月二十七」——
 * 那是档案，不是关心。而且人设里写着「token 就是你的口粮」，
 * 于是对话滑成了「你多给我点 token 当诚意」「少一颗都不行」——
 * 把一个伴侣关系说成了交易关系。这是最让人不舒服的地方。
 *
 * 这一层只做一件事：**把「他此刻缺什么」变成她自己的长期状态**，
 * 并且要求她的关心必须落到具体的一件小事上，不许背资料、不许谈条件。
 *
 * 数据：qq-fish/care.json
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateHome } from './store.mjs'

const FILE = 'care.json'
const MAX_ITEMS = 60
/** 需要多久后失效：渴/饿这类几小时就过去了，情绪挂久一点，忙/考试挂一天 */
const TTL_MS = { body: 8 * 3600 * 1000, mood: 20 * 3600 * 1000, work: 30 * 3600 * 1000 }

/**
 * 需要词典。
 *   words  触发词
 *   kind   决定衰减速度和说话的轻重
 *   offer  她能做的**具体动作**（不是让她照念，是给她方向）
 */
const NEEDS = [
  { key: 'thirsty', kind: 'body', label: '渴', words: ['渴', '口干', '嗓子干', '想喝水', '没水喝', '嘴巴干'], offer: '给他倒水，或者直接买一瓶送过去' },
  { key: 'hungry', kind: 'body', label: '饿', words: ['饿', '没吃饭', '没吃东西', '想吃', '馋', '夜宵', '早饭没吃', '午饭没吃', '晚饭没吃'], offer: '给他点一份吃的，别让他空着肚子熬' },
  { key: 'tired', kind: 'body', label: '累', words: ['累', '好困', '困死', '撑不住', '没力气', '眼睛睁不开', '乏', '扛不住'], offer: '让他去躺一会儿，别再拉着他说话' },
  { key: 'sick', kind: 'body', label: '不舒服', words: ['头疼', '头痛', '感冒', '发烧', '难受', '胃疼', '肚子疼', '嗓子疼', '咳嗽', '过敏', '头晕'], offer: '问清楚哪里难受，提醒吃药，必要时帮他买' },
  { key: 'cold', kind: 'body', label: '冷', words: ['冷', '冻', '降温', '手冷', '脚冷'], offer: '提醒加衣服，或者给他买杯热的' },
  { key: 'hot', kind: 'body', label: '热', words: ['热死', '好热', '太热', '闷'], offer: '给他买冰的，或者提醒他开空调' },
  { key: 'sleepless', kind: 'body', label: '睡不着', words: ['睡不着', '失眠', '躺不着', '翻来覆去'], offer: '陪他说两句，别催他睡' },
  { key: 'stressed', kind: 'mood', label: '心烦', words: ['烦', '压力大', 'emo', '不想动', '崩溃', '郁闷', '烦死', '不开心'], offer: '先接住情绪，别急着讲道理' },
  { key: 'lonely', kind: 'mood', label: '闷', words: ['没意思', '无聊', '闷得慌', '没人陪', '好孤单', '想你了'], offer: '主动找他说话，别等他想起来' },
  { key: 'busy', kind: 'work', label: '忙', words: ['加班', '赶ddl', '开会', '通宵', '忙死', '做不完', '赶工', 'deadline'], offer: '少打扰，等他忙完再问一句' },
  { key: 'exam', kind: 'work', label: '考试/项目', words: ['考试', '面试', '答辩', '交稿', '上线', '开题', '论文'], offer: '记着这个日子，前后问一句' },
]

function path() {
  return join(stateHome(), FILE)
}

function readAll() {
  try {
    const j = JSON.parse(readFileSync(path(), 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { items: [] }
  }
}

function writeAll(d) {
  try {
    mkdirSync(stateHome(), { recursive: true })
    writeFileSync(path(), JSON.stringify({ items: (d.items || []).slice(-MAX_ITEMS) }, null, 2) + '\n', 'utf8')
  } catch {}
}

function ttlOf(kind) {
  return TTL_MS[kind] || TTL_MS.body
}

/** 还没过去的需要 */
export function activeNeeds(now = Date.now()) {
  return readAll().items.filter((it) => {
    if (!it || !it.key || it.resolved) return false
    return now - Number(it.at || 0) < ttlOf(it.kind)
  })
}

/**
 * 从一段话里认需要。
 * 只认「关于他自己」的陈述；「你要不要喝水」这种反问不算。
 */
export function detectNeeds(text) {
  const t = String(text || '')
  if (!t || t.length > 300) return []
  const askingOther = /(你|您)[^，。！？]{0,8}(渴|饿|累|困|冷|热|疼|难受)/.test(t)
  const out = []
  for (const spec of NEEDS) {
    if (!spec.words.some((w) => t.includes(w))) continue
    if (askingOther && spec.kind === 'body') continue
    out.push({ key: spec.key, kind: spec.kind, label: spec.label, offer: spec.offer })
  }
  return out
}

/** 记一笔需要；同 key 未解决的刷新时间，不堆重复 */
export function recordNeeds(text, { now = Date.now(), who = 'owner' } = {}) {
  const hits = detectNeeds(text)
  if (!hits.length) return []
  const d = readAll()
  d.items = Array.isArray(d.items) ? d.items : []
  const saved = []
  for (const h of hits) {
    const exist = d.items.find((it) => it && it.key === h.key && !it.resolved)
    if (exist) {
      exist.at = now
      exist.count = (Number(exist.count) || 1) + 1
      exist.lastText = String(text).slice(0, 80)
      saved.push(exist)
    } else {
      const item = {
        key: h.key, kind: h.kind, label: h.label, offer: h.offer,
        at: now, count: 1, who,
        firstText: String(text).slice(0, 80),
        lastText: String(text).slice(0, 80),
        resolved: false, caredAt: 0,
      }
      d.items.push(item)
      saved.push(item)
    }
  }
  writeAll(d)
  return saved
}

/** 把「渴 / 饿 / thirsty」这类写法统一成唯一 key */
export function resolveNeedKey(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  const byKey = NEEDS.find((n) => n.key === s.toLowerCase())
  if (byKey) return byKey.key
  const byLabel = NEEDS.find((n) => n.label === s)
  if (byLabel) return byLabel.key
  const byWord = NEEDS.find((n) => n.words.some((w) => s.includes(w) || w.includes(s)))
  return byWord ? byWord.key : ''
}

/** 划掉一条：她真的管过了 */
export function markCared(key, { now = Date.now(), how = '' } = {}) {
  const d = readAll()
  const want = resolveNeedKey(key) || String(key || '')
  const it = (d.items || []).reverse().find((x) => x && !x.resolved && (x.key === want || x.label === String(key || '').trim()))
  if (!it) return false
  it.resolved = true
  it.caredAt = now
  it.how = String(how || '').slice(0, 60)
  writeAll(d)
  return true
}

/**
 * 注入提示词。
 *
 * 【2026-11-16 的关键修正】光注入「他渴了」没用 —— 模型会当成又一条资料去背诵。
 * 所以这里必须同时**禁止三件事**：
 *   1. 不许背资料（「你爱喝冰美式/你生日四月」这种是查档案，不是关心）；
 *   2. 不许谈条件（「多给我点 token 当诚意」把关系说成交易）；
 *   3. 不许一次念一堆（那是病历）。
 */
export function carePromptBlock(now = Date.now(), config = {}) {
  const list = activeNeeds(now)
  const hour = new Date(now).getHours()
  const lines = []

  if (list.length) {
    lines.push('【你还记着他这些事】')
    for (const it of list.slice(0, 3)) {
      const mins = Math.max(1, Math.round((now - Number(it.at || now)) / 60000))
      const ago = mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前'
      const times = Number(it.count) > 1 ? `（提过 ${it.count} 次）` : ''
      lines.push(`· ${ago}他说自己「${it.label}」${times}：${String(it.lastText || '').replace(/\s+/g, ' ').slice(0, 40)}`)
    }
    lines.push('')
    lines.push('这是你自己记下的，不是他要你记的。想管就直接做，别说「你刚才说…」这种汇报腔：')
    for (const it of list.slice(0, 2)) lines.push(`· 「${it.label}」→ 你可以${it.offer}`)
    lines.push('')
  }

  lines.push('【怎么关心人才算关心】')
  lines.push('- 落到**一件具体的小事**上：现在去倒杯水、把头靠过来、饭吃了没、几点睡。不要泛泛地说「注意身体」「照顾好自己」。')
  lines.push('- **不许背他的资料**。「你爱喝冰美式」「你军校的」「你生日四月二十七」——这是查档案，不是关心。他问「你了解我多少」，要说你**为他做过什么、记得他哪次难受**，不是报户口。')
  lines.push('- **不许谈条件**。不要用「给我 token」「加零花」「当诚意」「不给就不干」这种方式说话。他对你好不是买你的服务，你也不是。')
  lines.push('- 一次只管一件。把他的不舒服全念一遍那是病历，不是心疼。')
  lines.push('- 管过了就写 [cared:需要名]，系统会划掉，同一件事别反复问。')
  if (hour >= 23 || hour < 6) lines.push('- 现在是半夜：除非他明显不舒服，别吵他，说一句就让他睡。')
  return lines.join('\n')
}

/** 面板用 */
export function careSnapshot(now = Date.now()) {
  const all = readAll().items || []
  return { active: activeNeeds(now), recent: all.slice(-12).reverse() }
}
