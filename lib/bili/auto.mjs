// B 站「她自主说话」的统一入口：发自己的动态 / 在主人视频下评论。
// push 的定时触发和面板的手动触发都走这里，保证提示词和限额只有一份。
import { stateHome } from '../store.mjs'
import { generateText } from '../llm.mjs';
import { cleanReply, parseSkip, systemPrompt } from '../persona.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postDynamic, dynamicBudget, loadDynamicAccount } from './dynamic.mjs';
import { postComment, commentBudget, commentVisibility } from './comment.mjs';
import { listOwnerVideos } from './owner-videos.mjs';

/** 清掉主动发言用不到的占位符（表情包/图片标记、渠道标记） */
function tidy(text) {
  return String(text || '')
    .replace(/\[{1,2}\s*sticker\s*:[^\]\n]{1,80}\]{1,2}/gi, '')
    .replace(/\[{1,2}\s*img\s*:[^\]\n]{1,200}\]{1,2}/gi, '')
    .replace(/\[(dm|qq)\]/gi, '')
    .replace(/^["'「『]|[)"'」』]$/g, '')
    .trim();
}

function timeText(date = new Date()) {
  const h = date.getHours();
  const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `${emoji} ${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 她自己的 B 站资料（昵称/UID），缓存 24 小时，避免每次面板刷新都打 nav */
export async function herProfile(home = os.homedir()) {
  const file = path.join(home, '.dsh', 'qq-fish', 'bili', 'self-profile.json');
  const cached = (() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  })();
  if (cached && cached.mid && Date.now() - Number(cached.at || 0) < 24 * 3600 * 1000) return cached;

  const acc = loadDynamicAccount(home);
  const mid = String(acc.cred.dedeuserid || '').trim();
  let name = '';
  if (acc.cookie) {
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { cookie: acc.cookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' },
      });
      const j = await r.json().catch(() => null);
      if (j && j.code === 0 && j.data) name = String(j.data.uname || '');
    } catch {}
  }
  const out = { mid, name, at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {}
  return out;
}

export function dynamicPrompt(t = timeText()) {
  return [
    '现在是 ' + t + '，你打开自己的 B 站，想发一条动态。',
    '',
    '你平时什么样子，这条就什么样子——嘴硬、爱嫌弃、说话短，偶尔自己先气鼓鼓又自己消下去。',
    '不是写给别人看的文案，是你随手往主页上一扔的东西。',
    '',
    '可以写（挑一个）：',
    '- 刚做了什么（煮了白饭、赖床、出门买了杯喝的），带一句当时的牢骚；',
    '- 刷到什么东西的反应（这谁啊 / 服了 / 哈哈哈哈不行了）；',
    '- 突然的一个念头，不用有头有尾；',
    '- 对空气说的半句话，让人看不懂也行。',
    '',
    '写法要求：',
    '- 一两句，20-45 字最好，别写长；',
    '- 用你自己的口吻：可以嫌弃、可以自夸、可以阴阳，但不要解释自己为什么这么说；',
    '- 不要写成心灵鸡汤、不要总结人生；',
    '- 不要提主人、不要 @ 任何人、不要放链接、不要带 # 话题；',
    '- 不要写旁白，只输出正文本身；',
    '- 真没什么想说的，就只输出 [跳过]。',
  ].join('\n');
}

export function videoCommentPrompt(video, t = timeText()) {
  return [
    '现在是' + t + '，你刷到主人发的一条视频：',
    '《' + String(video.title || '').slice(0, 60) + '》' + (video.description ? '\n简介：' + String(video.description).slice(0, 120) : ''),
    '',
    '你想在下面留一条评论。要求：',
    '- 一两句话，40 字以内，像随手留的，不要长篇大论；',
    '- 可以夸、可以撒娇、可以嫌他更新慢，符合你平时的说话方式；',
    '- 不要提"主人"这个词（外人看不懂），不要暴露你是 AI，不要放链接、不要 @ 任何人；',
    '- 只输出评论正文，不要引号、不要旁白。',
  ].join('\n');
}

async function ask(ctx, config, log, prompt) {
  const system = systemPrompt(config, { channel: 'push', personaOverride: String(config.personaOwner || '').trim() });
  const result = await generateText(ctx, {
    system,
    messages: [{ role: 'user', text: prompt }],
    config,
    timeoutMs: 45_000,
    log,
  });
  if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` };
  const text = tidy(parseSkip(result.text));
  if (!text) return { ok: true, skipped: true };
  return { ok: true, text };
}

/**
 * 发一条动态（dry 只生成不发布）。
 * @returns {Promise<{ok:boolean, dry?:boolean, text?:string, posted?:boolean, dynId?:string, skipped?:boolean, error?:string}>}
 */
export async function runDynamic(ctx, config, log, { dry = false } = {}) {
  const budget = dynamicBudget();
  if (!dry && budget.remaining <= 0) return { ok: false, error: `今天已经发过 ${budget.count} 条了（上限 ${budget.perDay}）` };
  const gen = await ask(ctx, config, log, dynamicPrompt());
  if (!gen.ok) return gen;
  if (gen.skipped) return { ok: true, skipped: true, text: '' };
  if (dry) return { ok: true, dry: true, text: gen.text };
  const r = await postDynamic(undefined, gen.text.slice(0, 800));
  if (!r.ok) return { ok: false, error: r.error || '发布失败', text: gen.text };
  return { ok: true, dry: false, posted: true, text: gen.text, dynId: r.dynId || '' };
}

/**
 * 在他最新且没评过的视频下评论（dry 只生成不发布）。
 * @returns {Promise<{ok:boolean, dry?:boolean, text?:string, posted?:boolean, video?:object, rpid?:string, skipped?:boolean, error?:string}>}
 */
/**
 * 从 bili-log.json 里挑「她刷到并写过判词」的视频（scope=watched 用的）。
 * 记录里只有 bvid，所以后面要换 aid 才能评论。
 * 排序：近 7 天优先 → 写过 thought → 看着喜欢（liked/favorited/inHistory）。
 */
function pickWatchedVideos(days = 7, limit = 12) {
  let rows = []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateHome(), 'bili-log.json'), 'utf8'))
    rows = Array.isArray(j) ? j : (j.items || j.log || [])
  } catch { return [] }
  const now = Date.now()
  const scored = []
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const bv = String(r && (r.bvid || r.bv) || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) continue
    const at = Number(r.at) || Date.parse(String(r.at || '')) || 0
    const fresh = at && (now - at) < days * 86400_000
    let score = 0
    if (fresh) score += 40
    if (String(r.thought || '').trim()) score += 30
    if (r.liked) score += 15
    if (r.favorited) score += 10
    if (r.inHistory) score += 5
    scored.push({ bvid: bv, title: String(r.title || ''), up: String(r.up || ''), at, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (b.at - a.at))
  const seen = new Set()
  const out = []
  for (const v of scored) {
    if (seen.has(v.bvid)) continue
    seen.add(v.bvid)
    out.push(v)
    if (out.length >= limit) break
  }
  return out
}

/**
 * bvid → aid。为什么要单独写一份、还带降级：
 * api.bilibili.com/x/web-interface/view 带账号 cookie/UA 反而回 412（风控），裸请求才通。
 * 拿不到就返回 0，让调用方跳过这条、去试下一条，不要因为一条 412 把整轮评论卡死。
 */
async function bvidToAid(bv, { timeoutMs = 8000 } = {}) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bv || ''))) return { ok: false, why: 'BV 号格式不对', aid: 0 }
  const tryOne = async (headers) => {
    const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bv), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => ({}))
    if (j && j.code === 0 && j.data && j.data.aid) {
      return { ok: true, aid: Number(j.data.aid), title: String(j.data.title || ''), up: String((j.data.owner && j.data.owner.name) || '') }
    }
    return { ok: false, why: 'view code=' + (j && j.code !== undefined ? j.code : r.status), aid: 0 }
  }
  try {
    // 先裸请求（实测最稳），失败再带 UA/Referer 兜一次
    const a = await tryOne({})
    if (a.ok) return a
    const b = await tryOne({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://www.bilibili.com/video/' + bv,
    })
    if (b.ok) return b
    return { ok: false, why: a.why + ' / ' + b.why, aid: 0 }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e), aid: 0 }
  }
}

export async function runComment(ctx, config, log, { dry = false } = {}) {
  // 【scope 三路】原来这里只按 ownerMid 拉「他的投稿」，可主人那个号 0 投稿，
  // 于是每天三次只能报「他还没投过稿」。现在按 biliCommentScope 分：
  //   off    不评论
  //   owner  评主人自己号的视频
  //   watched（默认）评她刷到并写过判词的视频
  const scope = String(config.biliCommentScope || 'watched').trim() || 'watched'
  if (scope === 'off') return { ok: true, skipped: true, error: '评论已关闭（biliCommentScope=off）' };
  const budget = commentBudget();
  if (!dry && budget.remaining <= 0) return { ok: false, error: `今天已经评论过 ${budget.count} 条了（上限 ${budget.perDay}）` };

  const acc = loadDynamicAccount();
  let video = null;
  if (scope === 'owner') {
    const ownerMid = String(config.ownerBiliMid || '').trim();
    if (!ownerMid) return { ok: false, error: '还没配置他的 B 站 UID（ownerBiliMid）' };
    const listed = await listOwnerVideos(ownerMid, 20, { cookie: acc.cookie });
    if (!listed.ok) return { ok: false, error: `拿不到他的视频列表：${listed.error}` };
    const fresh = listed.videos.filter((v) => !budget.videos[v.aid]);
    if (!fresh.length) return { ok: true, skipped: true, error: '他的视频都评过了' };
    video = fresh[Math.floor(Math.random() * Math.min(3, fresh.length))];
  } else {
    // 【2026-11-18 修】原来只取最近 7 天、最多查 6 个候选，
    // 一旦这 6 个都评过就永远返回「都评过了」——日志里 6 分钟刷 9 次这句话。
    // 现在：放宽到 30 天、候选上限 12 个（pickWatchedVideos 自己的 limit 默认就是 12），
    // 并且跳过已评的继续往后找，直到找完整个池子。
    const picks = pickWatchedVideos(30, 12).filter((v) => {
      try { return true } catch { return true }
    });
    if (!picks.length) return { ok: true, skipped: true, error: '她最近还没刷到能评论的视频' };
    for (const p of picks.slice(0, 12)) {
      if (budget.videos[p.bvid]) continue;
      let info = null;
      try { info = await bvidToAid(p.bvid); } catch {}
      if (!info || !info.ok || !info.aid) continue;
      if (budget.videos[String(info.aid)]) continue;
      video = { aid: info.aid, bvid: p.bvid, title: info.title || p.title, up: info.up || p.up }
      break;
    }
    if (!video) {
      // 【诊断 2026-11-18】说清到底查了几个、为什么全跳过
      try {
        const cl = picks.slice(0, 12).length
        const allBv = picks.slice(0, 12).map((p) => p.bvid).join(',')
        log && log.info('[B站·评诊断] 候选 ' + cl + ' 个（池子共 ' + picks.length + '）| 已评 ' + Object.keys(budget.videos || {}).length + ' 个 | 候选bv: ' + allBv.slice(0, 200))
      } catch {}
      return { ok: true, skipped: true, error: '她刷到过的视频都评过了（查了 ' + picks.slice(0, 12).length + ' 个候选）' }
    }
  }

  const gen = await ask(ctx, config, log, videoCommentPrompt(video));
  if (!gen.ok) return gen;
  if (gen.skipped) return { ok: true, skipped: true, text: '', video };
  let text = gen.text.slice(0, 120);
  // 【2026-11-18 修】主人明确要求：「他感觉有意思的 @ 我」。
  // 所以她**在任何视频下评论都 @ 主人**，不限于主人自己发的视频。
  // （之前误加了 upName === ownerName 的限制，导致大部分评论都不 @。）
  // 配置 biliCommentAt 仍然可用来关掉这个行为。
  try {
    if (config && config.biliCommentAt !== false) {
      const ownerName = String(config.ownerBiliName || '').trim()
      if (ownerName && !text.includes('@' + ownerName)) {
        text = (text + ' @' + ownerName).slice(0, 140)
      }
    }
  } catch (e) { try { log && log.warn('补 @ 失败：' + ((e && e.message) || e)) } catch {} }
  if (dry) return { ok: true, dry: true, text, video };
  const r = await postComment(undefined, video.aid, text);
  if (!r.ok) return { ok: false, error: r.error || '评论失败', text, video };
  let review = null;
  try { review = await commentVisibility(undefined, video.aid, r.rpid); } catch {}
  const visible = review && review.ok ? review.visible === true : null;
  const state = review && review.ok ? review.state : null;
  try {
      const { readFileSync: rf, writeFileSync: wf } = await import('node:fs')
      const p = stateHome() + '/comment-log.json'
      let items = []
      try { items = JSON.parse(rf(p, 'utf8')).items || [] } catch {}
      items.push({ at: Date.now(), aid: String(video && video.aid || ''), rpid: String(r.rpid || ''), text: String(text || '').slice(0, 100) })
      wf(p, JSON.stringify({ items: items.slice(-50) }))
    } catch {}
    return { ok: true, dry: false, posted: true, text, video, rpid: r.rpid || '', visible, state, reviewError: (review && review.error) || '' };
}
