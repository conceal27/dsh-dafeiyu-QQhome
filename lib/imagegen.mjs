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

/** 画风兜底：qq-fish/style.json 读不到时用这份（真人 cos 自拍质感，不是插画） */
export const PHOTO_STYLE_FALLBACK =
  '【画风·最高优先】真实拍摄的 cos 自拍照，不是插画：真人 coser 用手机前置镜头自拍，'
  + '真实皮肤的毛孔、薄薄一层出油高光与轻微不平整，但皮肤干净通透，假发根部可见分缝与碎发，'
  + '服装布料有真实褶皱与反光，手机广角轻微桶形畸变，室内暖黄灯光局部过曝，'
  + '真实可见的噪点与胶片颗粒，浅景深；脸部保留动漫式的大眼睛与小脸比例，'
  + '但皮肤、头发、服装、光线全部按真人照片走。'
  + '脸上不要雀斑、不要斑点、不要痘印、不要痣；画面里不要出现任何文字、水印、logo、对话框'

/**
 * 画风档案：主人自己调的那份（~/.dsh/qq-fish/style.json）。
 * 为什么单独抽出来：画风一改就要动三处（qzone 配图 / draw 技能 / 生图提示词），
 * 写死在三个文件里必然改漏，所以只留这一个出口。
 */
export function styleProfile(home) {
  try {
    const j = JSON.parse(readFileSync(join(qqFishDir(home), 'style.json'), 'utf8'))
    return {
      enabled: j.enabled !== false,
      prompt: String(j.prompt || '').trim(),
      useStyleRef: j.useStyleRef !== false,
      refCount: Math.max(0, Math.min(4, Number(j.refCount) || 1)),
    }
  } catch {
    return { enabled: false, prompt: '', useStyleRef: true, refCount: 1 }
  }
}

/** 这次出图该用的画风段（读不到配置就退回兜底常量） */
export function stylePrompt(home) {
  const p = styleProfile(home)
  return (p.enabled && p.prompt) ? p.prompt : PHOTO_STYLE_FALLBACK
}

/** 画风样张（style/style-N.jpg），按序取前 refCount 张 */
export function styleRefFiles(home) {
  const p = styleProfile(home)
  if (!p.enabled || !p.useStyleRef) return []
  try {
    const dir = join(qqFishDir(home), 'style')
    return readdirSync(dir)
      .filter((n) => /^style-\d+\.(jpe?g|png|webp)$/i.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .slice(0, Math.max(1, p.refCount))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** 样张的 data URL（方舟的 image 字段要 base64，不要本地路径） */
export function styleRefDataUrls(home) {
  const out = []
  for (const f of styleRefFiles(home)) {
    try {
      const b = readFileSync(f)
      const ext = String(f).toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
      out.push('data:image/' + ext + ';base64,' + b.toString('base64'))
    } catch {}
  }
  return out
}

/**
 * 带参考图时追加的约束（2026-11-17 重写）
 * 踩过的坑：写「保持参考图里这个角色的长相…服装按文字重画」，但只传画风样张、不传形象图时，
 * 模型会把样张里那个人整个当成「参考角色」，连她身上的蕾丝水手服一起抄 → 衣服乱换。
 * 现在把三件事拆开锁：① 长相锁在文字里（不依赖参考图）② 衣服锁死在文字里 ③ 参考图只准贡献画风质感。
 */
export const LOOK_LOCK =
  '【长相·必须照文字，不许照参考图】深蓝中透浅天蓝的长卷发（发根是深的海蓝，发尾浅到接近天蓝，绝不是灰紫、不是银灰、不是紫罗兰），'
  + '头顶一根细软的呆毛，鲸鱼鳍形状的耳饰，侧发别小鲸鱼发夹，海蓝眼，小虎牙，脸小、圆润下巴。'

/**
 * 衣服规则（2026-11-17 晚改）：不是永远一套，是「按她此刻的日程换」。
 * 上一版写死成永远白水手服，主人反馈「不要永远一样的衣服」。
 * 她自己的 life_state.json 里每个时段本来就写了 outfit（睡袋/家居小裙子/水手小裙子/卫衣/薄外套/睡衣…），
 * 这里的规则就是：照那份穿，没写才退回默认水手服；参考图里的衣服一律不抄。
 */
export const OUTFIT_RULE =
  '【衣服·优先于一切参考图】以【此刻状态】里写的那套为准；没写就按时间段随便挑一套日常的。'
  + '衣柜范围：白色水手服（藏青蝴蝶结+百褶裙+过膝袜）、家居裙、卫衣、薄外套、睡衣/睡袋、'
  + '以及偶尔的蕾丝边睡裙或露肩款——蕾丝款可以有，但不要每次都画成蕾丝，大多数时候是普通家居服或水手服。'
  + '不要女仆装、不要吊带、不要浓妆艳抹的洛丽塔；也不要每次都跟参考图里那套一模一样（参考图只是画风参考，不是服装模板）。'

/**
 * 统一提示词组装（2026-11-17 定稿）
 * 踩过的坑：①衣服约束写在中段会被样张里的蕾丝裙盖掉 → 挪到最前并点名排除；
 * ②聊天链路以前只在命中「自拍/鲸鱼娘」等关键词时才注入固定形象，说「画个你在窗台啃吐司」就只有 360 字，
 *   跟空间链路（905 字）完全是两套 → 现在两条链路都调这个函数，结构一致。
 * @param {{look:string, stateLine?:string, scene:string, style?:string, hasRef?:boolean}} o
 */
export function buildImagePrompt(o = {}) {
  const look = String(o.look || '').trim()
  const scene = String(o.scene || '').trim()
  const style = String(o.style || '').trim()
  // selfStateLine 自带【她此刻的状态…】开头，这里剥掉，统一由我们给标题
  const state = String(o.stateLine || '').replace(/^【[^】]*】/, '').trim()
  return OUTFIT_RULE + LOOK_LOCK
    + (look ? '【固定形象·不改】' + look + '。' : '')
    + (state ? '【此刻状态】' + state + '。' : '')
    + '【这次的画面·只改动作表情场景光线】' + scene + '。'
    + (o.hasRef ? '【参考图怎么用】参考图只提供画风质感；图里的人发色、衣服、姿势一律不抄。' : '')
    + style
}

/** 兼容旧名字：别处还 import 了 OUTFIT_LOCK */
export const OUTFIT_LOCK = OUTFIT_RULE

export const REF_LOCK_SUFFIX = LOOK_LOCK + OUTFIT_LOCK +
  '【参考图怎么用】参考图只用来决定画风质感（真人 cos 自拍、光线、噪点、景深、手机自拍视角）；'
  + '参考图里的人如果发色或衣服跟上面写的不一样，一律忽略，一件都不要照抄；也不要照抄她的姿势和背景'

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
  // 【参考图顺序】2026-11-17：与 draw.mjs 对齐。
  // 实测只带「画风样张」最像真人 cos 自拍；把她那张 AI 生成的「形象图」一起塞进去，
  // 脸会被拉回娃娃/CG 感。以前这里只传 selfRefDataUrl（形象图），所以空间图一直是插画风。
  // 顺序：只画风样张 → 样张+形象图 → 只形象图 → 纯文生图。useRef:false 可整段关掉。
  const wantRef = useRefEnabled(config, opts) && !opts.noRef
  const selfRef = wantRef ? selfRefDataUrl(undefined, 0) : null
  const styleRefs = wantRef ? styleRefDataUrls(undefined) : []
  // 【参考图顺序·定稿 2026-11-17】
  // 样例图换成主人自己认可的成品后（style/style-1~4.jpg = 真人 cos 自拍），
  // 它们同时锁「画风 + 长相」，所以只传样张就是最优解：
  //   ① 样张（1~2 张）→ 最像真人、长相也稳
  //   ② 样张 + 形象图 → 兜底
  //   ③ 纯文生图     → 最后兜底
  // 旧的 self/ref-1.jpg 是二次元平涂插画，传它会把画风拽回插画，已挪成 old-ref-*.jpg 不再自动带。
  const refSets = []
  if (styleRefs.length) refSets.push(styleRefs.slice(0, 4))
  if (styleRefs.length && selfRef) refSets.push([...styleRefs.slice(0, 4), selfRef])
  try {
    const baseBody = {
      model,
      prompt: p,
      size,
      response_format: 'url',
      // 必须显式传 false：不传方舟默认加水印，家长/主人看到的右下角「AI生成」就是它
      watermark: false,
    }
    // 分级降级：每种参考图组合试一次，全挂再退回纯文生图
    // 样张优先，纯文生图垫底
    const attempts = [...refSets.map((r) => ({ image: r })), {}]
    let res = null
    let j = null
    let usedRef = false
    let usedStyleRefs = 0
    for (const extra of attempts) {
      const payload = { ...baseBody, ...extra }
      res = await fetch(ARK_API + '/images/generations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: t.signal,
      })
      j = await res.json().catch(() => null)
      if (res.ok && j && j.data && j.data[0] && j.data[0].url) {
        const imgs = extra.image || []
        usedRef = !!selfRef && imgs.includes(selfRef)
        usedStyleRefs = styleRefs.length ? imgs.filter((x) => styleRefs.includes(x)).length : 0
        break
      }
    }
    const url = j && j.data && j.data[0] && j.data[0].url
    if (!url) return { ok: false, error: '方舟没返回图片：' + JSON.stringify(j && j.error ? j.error : j).slice(0, 160) }
    const bytes = await fetchBytes(url)
    if (!bytes) return { ok: false, error: '图片下载失败' }
    return { ok: true, bytes, url, ms: Date.now() - t0, usedRef, usedStyleRefs }
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
      feature: 'image',
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
  // 只要有任一参考图（样张或形象图）就要加长相/衣服锁
  const withRef = useRefEnabled(config, opts) && (selfRefFiles(undefined).length > 0 || styleRefFiles(undefined).length > 0)
  for (let i = 0; i < want; i += 1) {
    const scene = await describeScene(ctx, config, text, { log: opts.log, home: opts.home })
    // 【提示词结构】2026-11-17 对齐聊天路径（skills.mjs 的 draw）：
    // 以前是「look，场景，锁，画风」——场景夹在中间，衣服/发色锁写在后面，模型基本不看，
    // 结果把画风样张里那个人的灰紫发和蕾丝裙一起抄过来。
    // 现在照聊天那条路的写法：固定形象整块打头 → 场景 → 画风。
    const sceneBit = scene ? scene : `正在做一件事：${String(text).slice(0, 60)}`
    // 空间这条以前完全不看她的日程，所以衣服只能靠默认值。现在把当下状态（含 outfit）带进来。
    let stateBit = ''
    try {
      const { selfStateLine } = await import('./selfstate.mjs')
      stateBit = String(selfStateLine(opts.home) || '').replace(/^【[^】]*】/, '').trim()
    } catch {}
    const prompt = buildImagePrompt({
      look, stateLine: stateBit, scene: sceneBit,
      style: stylePrompt(opts.home), hasRef: withRef,
    })
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
        if (opts && opts.log) opts.log('生图已存盘：qzone/generated/' + name + (r.usedStyleRefs ? '（带画风样张' + (r.usedRef ? '+形象图' : '') + '）' : r.usedRef ? '（带形象参考图）' : ''))
      } catch {}
    } else {
      lastError = r.error
      if (opts.log) opts.log('生图失败：' + r.error)
      break
    }
  }
  return { images, prompt: prompts.join(' / '), prompts, error: images.length ? '' : lastError }
}
