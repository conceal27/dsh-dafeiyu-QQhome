/**
 * lib/skills.mjs — 扩展机制（skill 轨）
 * ============================================================================
 * 两条轨：
 *   plugin（确定性）— 核心代码决定何时跑，不经过模型。本项目里的内置模块就是。
 *   skill （LLM 决定）— 模型读描述，决定要不要调用。本文件负责这一轨。
 *
 * 为什么这样分：
 *   能硬编码的写 plugin（稳定、零 token），需要理解自然语言的写 skill。
 *
 * skill 的生命周期：
 *   1. 注册：内置 skill + skills/ 目录下的用户 skill
 *   2. 注入：把「你能用下面这些能力」拼进提示词
 *   3. 调用：模型输出 [skill:名字 参数] → 执行 → 结果回注
 *   4. 开关：config.skills[id] === false 时整体消失（描述不注入、调用不执行）
 *
 * 文件格式（用户扩展）：
 *   skills/<id>/skill.json  { id, name, description, usage, builtin }
 *   skills/<id>/index.js    export default async function run(arg, ctx) { ... }
 * ============================================================================
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内置 skill（包装现有能力） */
const BUILTIN = [
  {
    id: 'search',
    name: '联网搜索',
    description: '查实时信息、新闻、事实、天气、价格。当对方问「是什么/多少钱/怎么回事」而你不知道时用。',
    usage: '[skill:search 关键词]',
    run: async (arg, ctx) => {
      const { webSearch, formatResults } = await import('./search.mjs')
      const r = await webSearch(String(arg || '').trim())
      if (!r.ok || !r.results.length) return { ok: false, text: '没搜到东西' }
      return { ok: true, text: formatResults(r) }
    },
  },
  {
    id: 'bili',
    name: '看B站',
    description: '去B站看一个视频，可以点赞收藏。她说「我去刷会儿B站」时用。',
    usage: '[skill:bili]',
    run: async (arg, ctx) => {
      const { watchOne } = await import('./biliwatch.mjs')
      const r = await watchOne({ ctx: ctx.ctx, config: ctx.config, log: ctx.log })
      if (!r.ok) return { ok: false, text: '没看成：' + (r.error || '') }
      return { ok: true, text: '看了「' + String(r.item && r.item.title || '').slice(0, 40) + '」' }
    },
  },
  {
    id: 'memory',
    name: '翻记忆',
    description: '想起以前聊过的事。当对方提到「上次/之前/你还记得」时用。',
    usage: '[skill:memory 关键词]',
    run: async (arg, ctx) => {
      try {
        const mod = await import('./memory-decay.mjs')
        const st = mod.status ? mod.status(ctx.home) : null
        const items = (st && st.items) || []
        const kw = String(arg || '').trim()
        const hits = kw ? items.filter((m) => String(m.text || '').includes(kw)).slice(0, 5) : items.slice(-5)
        if (!hits.length) return { ok: false, text: '没想起来' }
        return { ok: true, text: hits.map((m) => '- ' + String(m.text || '').slice(0, 60)).join('\n') }
      } catch (e) {
        return { ok: false, text: '记忆模块不可用' }
      }
    },
  },
  {
    id: 'ledger',
    name: '查账本',
    description: '检查自己的记忆有没有丢或被人改过。',
    usage: '[skill:ledger]',
    run: async (arg, ctx) => {
      try {
        const mod = await import('./memory-decay.mjs')
        const led = await import('./ledger.mjs')
        const st = mod.status ? mod.status(ctx.home) : null
        const v = led.ledgerVerify(ctx.home, (st && st.items) || [])
        return { ok: true, text: v.ok ? ('账本校验通过（' + v.total + ' 条）') : ('账本对不上：缺 ' + v.missing.length + ' 条，被改 ' + v.tampered.length + ' 条') }
      } catch (e) {
        return { ok: false, text: '账本不可用' }
      }
    },
  },
  {
    id: 'draw',
    name: '画图',
    description: '用 AI 画一张图发给对方。对方说「画一个/画张图/来张图/给我画」时用，参数写清楚画面。',
    usage: '[skill:draw 画面描述]',
    run: async (arg, ctx) => {
      const { generateImage, loadDrawProfile } = await import('./draw.mjs')
      // 固定形象 / 画风 / 参考图统一由 imagegen.mjs 提供：唯一来源是 ~/.dsh/qq-fish/selfimage.json
      const { herLook, STYLE_SUFFIX, selfRefFiles } = await import('./imagegen.mjs')
      let brief = String(arg || '').trim()
      const withRef = selfRefFiles(ctx.home).length > 0
      if (/自拍|画像|我长什么样|你的样子|画我|画你|画个我|画一只我|画一只你/.test(brief)) {
        let selfP = herLook(ctx.home)
        if (!selfP) selfP = (loadDrawProfile(ctx.home) || {}).selfPrompt || ''
        if (selfP && !brief.includes('鲸鱼娘')) {
          let stateLine = ''
          try {
            const { selfStateLine } = await import('./selfstate.mjs')
            stateLine = selfStateLine(ctx.home)
          } catch {}
          brief = '【固定形象·必须严格一致，任何情况下都不许改】' + selfP +
            (stateLine ? '\n【此刻状态·只影响表情动作光线场景，不许改上面的形象】' + stateLine : '') +
            '\n【这次的画面】' + brief
        }
      }
      // 统一画风：与官方参考图一致的日系半写实（不要Q版、不要水印）
      if (brief && !/半写实/.test(brief)) brief += '。' + STYLE_SUFFIX
      const r = await generateImage(brief, { home: ctx.home, useRef: withRef })
      if (!r.ok) return { ok: false, text: '没画成：' + (r.error || '') }
      return { ok: true, text: r.usedRef ? '画好了（带形象参考图）' : '画好了', image: { b64: r.b64, caption: '', model: r.model, size: r.size } }
    },
  },
  {
    id: 'hot',
    name: '看热点',
    description: '看今天的新闻早报和各种榜单：微博热搜、知乎热榜、抖音热点、EPIC 免费游戏。对方问「今天有什么新闻/出什么事了/热搜/知乎在聊什么/抖音火了啥/免费游戏」时用；参数写 weibo/zhihu/douyin/epic 可只看那个源。',
    usage: '[skill:hot] 或 [skill:hot zhihu]',
    run: async (arg, ctx) => {
      const { dailyHotReport, hotSource } = await import('./hotnews.mjs')
      const a = String(arg || '').trim().toLowerCase()
      const src = /zhihu|知乎/.test(a) ? 'zhihu' : /douyin|抖音/.test(a) ? 'douyin' : /epic|免费游戏/.test(a) ? 'epic' : /weibo|微博|热搜/.test(a) ? 'weibo' : ''
      if (src) {
        const r = await hotSource(src, 8)
        return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.text || '榜单连不上' }
      }
      const r = await dailyHotReport()
      return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.text || '热点源连不上' }
    },
  },
  {
    id: 'note',
    name: '记笔记',
    description: '把重要的事写成一篇笔记存起来（开题、课题、清单、长东西）。对方说「记一下/帮我记下来/存个笔记」时用；参数格式：笔记标题|正文。',
    usage: '[skill:note 标题|正文]',
    run: async (arg, ctx) => {
      const raw = String(arg || '')
      const i = raw.indexOf('|')
      const title = (i > 0 ? raw.slice(0, i) : raw).trim().slice(0, 60)
      const body = (i > 0 ? raw.slice(i + 1) : '').trim()
      if (!title) return { ok: false, text: '得给个标题' }
      const { writeNote } = await import('./notes.mjs')
      const r = writeNote(ctx.home, { title, body: body || title, source: 'skill', tags: ['skill'] })
      return r.ok ? { ok: true, text: '记下来了：《' + title + '》' } : { ok: false, text: '没记上：' + (r.error || '') }
    },
  },
  {
    id: 'notes',
    name: '翻笔记',
    description: '翻自己以前记的笔记。对方问「上次记的那个/笔记里写了什么/开题那个清单」时用。',
    usage: '[skill:notes 关键词]',
    run: async (arg, ctx) => {
      const { searchNotes, loadNotes } = await import('./notes.mjs')
      const kw = String(arg || '').trim()
      const list = kw ? searchNotes(ctx.home, kw, 5) : loadNotes(ctx.home).slice(-5)
      if (!list.length) return { ok: false, text: '没找到相关的笔记' }
      return { ok: true, text: list.map((n) => '《' + n.title + '》\n' + String(n.body || '').slice(0, 400)).join('\n\n') }
    },
  },
  {
    id: 'memo',
    name: '记着的事',
    description: '管理「一直记着的事」和到点提醒：status 加一条一直记着的；task 加每天/一次提醒（格式：task 22:30|提醒内容）；list 看都有什么；del 删掉。',
    usage: '[skill:memo list] / [skill:memo status 内容] / [skill:memo task 22:30|内容] / [skill:memo del 关键词]',
    run: async (arg, ctx) => {
      const raw = String(arg || 'list').trim()
      const m = /^(list|status|task|del|delete)\s*([\s\S]*)$/i.exec(raw) || [null, 'list', '']
      const cmd = String(m[1] || 'list').toLowerCase()
      const rest = String(m[2] || '').trim()
      const mod = await import('./memo.mjs')
      if (cmd === 'list') {
        const st = mod.loadMemo(ctx.home)
        const lines = []
        for (const x of st.statusMemos) lines.push('· 记着：' + x.content)
        for (const x of st.tasks.filter((t) => t.enabled)) lines.push('· 提醒：' + (x.type === 'daily' ? '每天 ' + String(x.hh).padStart(2, '0') + ':' + String(x.mm).padStart(2, '0') : '一次') + ' ' + x.text)
        for (const x of st.triggers) lines.push('· 关键词「' + x.keyword + '」→ ' + x.content)
        return lines.length ? { ok: true, text: lines.join('\n') } : { ok: true, text: '现在没有记着的事' }
      }
      if (cmd === 'status') { const r = mod.addStatusMemo(ctx.home, rest); return { ok: r.ok, text: r.ok ? '记住了' : (r.error || '没记上') } }
      if (cmd === 'task') {
        const i = rest.indexOf('|')
        const when = (i > 0 ? rest.slice(0, i) : '').trim()
        const text = (i > 0 ? rest.slice(i + 1) : rest).trim()
        const r = mod.addTask(ctx.home, { text, type: 'daily', hhmm: when })
        return { ok: r.ok, text: r.ok ? '定好了：每天 ' + when + ' ' + text : (r.error || '没定上') }
      }
      if (cmd === 'del' || cmd === 'delete') {
        const a = mod.removeStatusMemo(ctx.home, rest).removed
        const b = mod.removeTask(ctx.home, rest).removed
        const c = mod.removeTrigger(ctx.home, rest).removed
        return { ok: true, text: '删了 ' + (a + b + c) + ' 条' }
      }
      return { ok: false, text: '不认识的用法' }
    },
  },
  {
    id: 'github',
    name: '看GitHub趋势',
    description: '看 GitHub 今天/这周最火的开源项目。对方问「GitHub 上有什么/最近什么项目火」时用；参数可写 weekly。',
    usage: '[skill:github] 或 [skill:github weekly]',
    run: async (arg, ctx) => {
      const { githubTrending, formatTrending } = await import('./github-trending.mjs')
      const a = String(arg || '').trim().toLowerCase()
      const since = a.includes('week') ? 'weekly' : a.includes('month') ? 'monthly' : 'daily'
      const r = await githubTrending({ since, n: 8 })
      if (!r.ok) return { ok: false, text: '没拿到：' + (r.error || '') }
      return { ok: true, text: formatTrending(r, 6) }
    },
  },
]

let cached = null

/** 加载所有 skill（内置 + 用户目录） */
export function loadSkills(rootDir, config = {}) {
  const list = []
  for (const b of BUILTIN) {
    if (isEnabled(b.id, config)) list.push({ ...b, builtin: true })
  }
  // 用户 skill
  if (rootDir) {
    const dir = join(rootDir, 'skills')
    try {
      for (const name of readdirSync(dir)) {
        const metaFile = join(dir, name, 'skill.json')
        const codeFile = join(dir, name, 'index.js')
        if (!existsSync(metaFile) || !existsSync(codeFile)) continue
        try {
          const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
          const id = String(meta.id || name)
          if (!isEnabled(id, config)) continue
          list.push({
            id,
            name: String(meta.name || id),
            description: String(meta.description || ''),
            usage: String(meta.usage || '[skill:' + id + ']'),
            builtin: false,
            codeFile,
          })
        } catch {}
      }
    } catch {}
  }
  cached = list
  return list
}

function isEnabled(id, config) {
  const box = (config && config.skills) || {}
  return box[id] !== false
}

/** 拼给模型看的「能力清单」 */
export function skillsPromptBlock(skills) {
  if (!skills || !skills.length) return ''
  const lines = ['【你能用的本事（想用的时候按格式写在回复里，系统会执行并把结果给你）】']
  for (const s of skills) {
    lines.push(`- ${s.name}：${s.description}`)
    lines.push(`  用法：${s.usage}`)
  }
  lines.push('不想用就别写；一次最多用一个。')
  return lines.join('\n')
}

/** 从模型输出里抓 [skill:id 参数] */
export function detectSkillCall(text) {
  const m = /\[skill:([\w-]+)(?:\s+([^\]\n]*))?\]/.exec(String(text || ''))
  if (!m) return null
  return { id: m[1], arg: (m[2] || '').trim(), raw: m[0] }
}

/** 执行一个 skill */
export async function runSkill(skill, arg, ctx) {
  if (!skill) return { ok: false, text: '没有这个能力' }
  try {
    if (skill.builtin) return await skill.run(arg, ctx)
    const mod = await import(skill.codeFile)
    const fn = mod.default || mod.run
    if (typeof fn !== 'function') return { ok: false, text: 'skill 没有导出函数' }
    const r = await fn(arg, ctx)
    if (typeof r === 'string') return { ok: true, text: r }
    return r || { ok: false, text: 'skill 没返回' }
  } catch (e) {
    return { ok: false, text: '执行失败：' + ((e && e.message) || e) }
  }
}

/** 面板用 */
export function skillsSnapshot(config = {}) {
  const list = cached || loadSkills(null, config)
  return {
    skills: list.map((s) => ({ id: s.id, name: s.name, description: s.description, builtin: s.builtin })),
  }
}
