/**
 * lib/imagegen.mjs — 生图（火山方舟 Seedream / 硅基流动）
 * ============================================================================
 * 迁移自 AstrBot 的 `dfy_volc_gen`（火山方舟 doubao-seedream）与
 * `astrbot_plugin_llm_draw_plus`（硅基流动 /v1/images/generations）。
 *
 * 目前用在「QQ 空间说说配图」：让模型先把说说写成一句画面描述，
 * 再按她的形象（蓝鲸鱼娘）生成一张图，失败才退回表情包。
 *
 * 形象（2026-11-12 统一来源）：
 *   - 唯一来源是 ~/.dsh/qq-fish/selfimage.json 的 prompt（主人认可的三张参考图描述的
 *     那个「日系半写实、长卷蓝发、水手服」的少女）。这里不再硬编码 Q 版/女仆文案。
 *   - ~/.dsh/qq-fish/self/ref-1.jpg（可 ref-2/ref-3）是她的官方形象参考图，方舟
 *     Seedream 4.0 的 /images/generations 支持 `image` 字段（http URL / data URL /
 *     数组），实测传 data:image/jpeg;base64 有效；**裸 base64 会被 400 拒绝**。
 *     传参考图能保证「是同一个人」，姿势/场景仍按文字重画。
 * ============================================================================
 */
import { generateText } from './llm.mjs'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateHome } from './store.mjs'

const ARK_API = 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_DEFAULT_MODEL = 'doubao-seedream-4-0-20260415'
const SF_API = 'https://api.siliconflow.cn/v1/images/generations'
const SF_DEFAULT_MODEL = 'Qwen/Qwen-Image'

/**
 * 她的固定形象（selfimage.json 读不到时的回退文案）。
 * 注意：不要出现「Q版 / 三头身 / 女仆围裙」这类与官方参考图冲突的词。
 */
export const HER_LOOK_FALLBACK =
  '日系半写实插画风格的鲸鱼娘少女「大肥鱼」：人形少女体型，有两条修长的腿，不是人鱼、绝不用鱼尾代替双腿，'
  + '鲸鱼尾巴只是裙后一条可收起的装饰；接近真人比例、不要Q版不要三头身；外表16岁、158cm，身材纤细、腰细、腿长；'
  + '深蓝渐变到浅天蓝的长卷发、头顶一根细软的呆毛、鲸鱼鳍形状的耳饰、小鲸鱼发夹、海蓝眼、小虎牙；'
  + '水手服配藏青大蝴蝶结的修身短裙、白色过膝袜'

/** 与参考图一致的画风约束 */
export const STYLE_SUFFIX =
  '日系半写实插画风格，接近真人的头身比例（绝不是Q版、不是三头身、不是简笔），'
  + '真实柔和的自然光，精致的发丝与皮肤质感，低饱和马卡龙色调，构图简洁；'
  + '画面里不要出现任何文字、水印、logo、对话框'

/** 带参考图时追加：锁长相、放开姿势与场景 */
const REF_LOCK_SUFFIX =
  '保持参考图里这个角色的长相（同一张脸、同样的深蓝渐变浅天蓝长卷发、海蓝眼、鲸鱼鳍耳饰、小鲸鱼发夹、小虎牙），'
  + '只按文字重新构图画面的动作、服装、场景和光线，不要照抄参考图里的人物姿势和背景'

/** 兼容老代码：需要静态字符串时用这个（新代码请用 herLook()） */
export const HER_LOOK = herLook()

/**
 * 归一化到 qq-fish 目录。调用方传进来的可能是三种之一：
 * 用户家目录 / DSH_HOME / qq-fish 目录本身 / 空（用 stateHome()）。
 * 和 draw.mjs、selfstate.mjs 的写法保持一致。
 */
function qqFishDir(home) {
  const h = String(home || '').replace(/\/+$/, '')
  if (!h) return stateHome()
  if (h.endsWith('qq-fish')) return h
  if (h.endsWith('.dsh')) return join(h, 'qq-fish')
  return join(h, '.dsh', 'qq-fish')
}

/**
 * 她的固定形象（唯一来源：~/.dsh/qq-fish/selfimage.json 的 prompt）。
 * @returns {string} 读不到时回退 HER_LOOK_FALLBACK
 */
export function herLook(home) {
  try {
    const f = join(qqFishDir(home), 'selfimage.json')
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const p = String((raw && raw.prompt) || '').trim()
    if (p) return p
  } catch {}
  return HER_LOOK_FALLBACK
}

/** 官方形象参考图目录 */
export function selfRefDir(home) {
  return join(qqFishDir(home), 'self')
}

/** 列出可用的参考图（按文件名排序，ref-1 在最前） */
export function selfRefFiles(home) {
  try {
    const dir = selfRefDir(home)
    return readdirSync(dir)
      .filter((n) => /^ref-\d+\.(jpe?g|png|webp)$/i.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * 取第 index 张参考图的 data URL（给方舟的 image 字段用）。
 * @returns {string|null} 没有参考图时返回 null
 */
export function selfRefDataUrl(home, index = 0) {
  try {
    const files = selfRefFiles(home)
    const f = files[Math.max(0, Math.min(files.length - 1, Number(index) || 0))]
    if (!f) return null
    const buf = readFileSync(f)
    if (!buf || buf.length < 1024) return null
    const mime = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg'
    return 'data:' + mime + ';base64,' + buf.toString('base64')
  } catch {
    return null
  }
}

/** 是否启用参考图（config.imageGenUseRef 默认开，可用 false 关掉） */
export function useRefEnabled(config, opts = {}) {
  if (opts && opts.useRef !== undefined) return opts.useRef !== false
  if (config && config.imageGenUseRef === false) return false
  return true
}

function timeoutOf(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(10_000, Number(ms) || 180_000))
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * 生成一张图。
 * @param {string} prompt 画面描述
 * @param {object} config config.json（imageGenProvider / imageGenKey / imageGenModel / imageGenSize / imageGenUseRef）
 * @param {{timeoutMs?:number,useRef?:boolean,noRef?:boolean}|undefined} opts
 * @returns {Promise<{ok:true, bytes:Uint8Array, url:string, ms:number, usedRef:boolean}|{ok:false, error:string}>}
 */
export async function generateImage(prompt, config = {}, opts = {}) {
  const t0 = Date.now()
  const provider = String(config.imageGenProvider || 'ark').toLowerCase()
  const size = String(config.imageGenSize || '1024x1024')
  const p = String(prompt || '').trim()
  if (!p) return { ok: false, error: '提示词是空的' }

  if (provider === 'siliconflow') {
    const key = String(config.imageGenKey || process.env.SILICONFLOW_API_KEY || '').trim()
    if (!key) return { ok: false, error: '没有硅基流动 key' }
    const model = String(config.imageGenModel || SF_DEFAULT_MODEL)
    const t = timeoutOf(opts.timeoutMs || 180_000)
    try {
      // 硅基流动这条备选链路不传参考图：Qwen-Image 的 image 参数不保证存在，
      // 传了反而可能整条链路报错。参考图只在方舟 Seedream 分支启用。
      const body = { model, prompt: p, image_size: size, batch_size: 1, seed: Math.floor(Math.random() * 1e9) }
      const ref = null
      const res = await fetch(SF_API, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: t.signal,
      })
      const j = await res.json().catch(() => null)
      const url = j && Array.isArray(j.images) && j.images[0] && j.images[0].url
      if (!url) return { ok: false, error: '硅基流动没返回图片：' + JSON.stringify(j).slice(0, 160) }
      const bytes = await fetchBytes(url)
      if (!bytes) return { ok: false, error: '图片下载失败' }
      return { ok: true, bytes, url, ms: Date.now() - t0, usedRef: !!ref }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
    } finally { t.done() }
  }

  // 默认：火山方舟 Seedream
  const key = String(config.imageGenKey || process.env.ARK_API_KEY || '').trim()
  if (!key) return { ok: false, error: '没有火山方舟 key' }
  const model = String(config.imageGenModel || ARK_DEFAULT_MODEL)
  const t = timeoutOf(opts.timeoutMs || 180_000)
  // 角色参考图：默认第 1 张；方舟接受 data URL / http URL / 数组，裸 base64 会 400
  const ref = useRefEnabled(config, opts) && !opts.noRef ? selfRefDataUrl(undefined, 0) : null
  try {
    const body = {
      model,
      prompt: p,
      size,
      response_format: 'url',
      // 必须显式传 false：不传方舟默认加水印，家长/主人看到的右下角「AI生成」就是它
      watermark: false,
    }
    if (ref) body.image = [ref]
    let res = await fetch(ARK_API + '/images/generations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: t.signal,
    })
    let j = await res.json().catch(() => null)
    // 参考图这条链万一被上游拒（模型/区域不支持 image），别整个生图挂掉：退回纯文生图一次
    if (ref && (!res.ok || !(j && j.data && j.data[0] && j.data[0].url))) {
      const withoutRef = { ...body }
      delete withoutRef.image
      res = await fetch(ARK_API + '/images/generations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(withoutRef),
        signal: t.signal,
      })
      j = await res.json().catch(() => null)
    }
    const url = j && j.data && j.data[0] && j.data[0].url
    if (!url) return { ok: false, error: '方舟没返回图片：' + JSON.stringify(j && j.error ? j.error : j).slice(0, 160) }
    const bytes = await fetchBytes(url)
    if (!bytes) return { ok: false, error: '图片下载失败' }
    return { ok: true, bytes, url, ms: Date.now() - t0, usedRef: !!ref }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  } finally { t.done() }
}

async function fetchBytes(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > 1024 ? buf : null
  } catch {
    return null
  }
}

/**
 * 把一条说说变成画面描述（只输出一句中文，不要文字/水印要求）。
 * 用当前模型链，失败就用说说正文兜底。
 */
export async function describeScene(ctx, config, text, opts = {}) {
  const t = String(text || '').trim()
  if (!t) return ''
  const look = herLook(opts.home)
  try {
    const r = await generateText(ctx, {
      system: '你是配图策划。把下面这条 QQ 说说变成一句具体的画面描述，给画师用。'
        + '\n要求：只描写画面里能看到的东西（人物动作、场景、光线、道具），40~80 字；'
        + '\n主角固定是下面这个角色，不要改她的样子（不要画成Q版、不要三头身、不要改发色发型、不要加女仆装）；'
        + '\n不要出现任何文字、对话框、水印；不要解释你在做什么。',
      messages: [{ role: 'user', text: `角色设定：${look}\n\n说说：${t}` }],
      config,
      timeoutMs: Number(opts.timeoutMs) || 30_000,
      log: opts.log,
    })
    if (r && r.ok) {
      return String(r.text || '').replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
    }
  } catch {}
  return ''
}

/**
 * 给一条说说生成配图（base64:// 数组）。失败返回 {images:[], error}。
 * 供 qzone-auto 和 engine 的 [qzone:post:] 共用。
 */
export async function qzoneImagesFor(ctx, config, text, opts = {}) {
  const want = Math.max(0, Math.min(3, Math.round(Number(opts.count == null ? config.qzonePostImages == null ? 1 : config.qzonePostImages : opts.count))))
  if (!want) return { images: [], prompt: '', error: '' }
  // 一张一张来：Seedream 一次一张，多张就多调
  const images = []
  const prompts = []
  let lastError = ''
  const look = herLook(opts.home)
  const withRef = useRefEnabled(config, opts) && selfRefFiles(undefined).length > 0
  for (let i = 0; i < want; i += 1) {
    const scene = await describeScene(ctx, config, text, { log: opts.log, home: opts.home })
    const prompt = (scene ? `${look}，${scene}` : `${look}，正在做一件事：${String(text).slice(0, 60)}`)
      + (withRef ? '。' + REF_LOCK_SUFFIX : '') + '。' + STYLE_SUFFIX
    const r = await generateImage(prompt, config)
    if (r.ok) {
      images.push('base64://' + Buffer.from(r.bytes).toString('base64'))
      prompts.push(prompt)
      // 落盘留档：方便面板回看、也方便你确认她画成什么样
      try {
        const dir = join(stateHome(), 'qzone', 'generated')
        mkdirSync(dir, { recursive: true })
        const name = 'gen-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6) + '.jpg'
        writeFileSync(join(dir, name), Buffer.from(r.bytes))
        if (opts && opts.log) opts.log('生图已存盘：qzone/generated/' + name + (r.usedRef ? '（带形象参考图）' : ''))
      } catch {}
    } else {
      lastError = r.error
      if (opts.log) opts.log('生图失败：' + r.error)
      break
    }
  }
  return { images, prompt: prompts.join(' / '), prompts, error: images.length ? '' : lastError }
}
