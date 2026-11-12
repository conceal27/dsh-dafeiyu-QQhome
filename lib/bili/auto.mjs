// B 站「她自主说话」的统一入口：发自己的动态 / 在主人视频下评论。
// push 的定时触发和面板的手动触发都走这里，保证提示词和限额只有一份。
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
export async function runComment(ctx, config, log, { dry = false } = {}) {
  const ownerMid = String(config.ownerBiliMid || '').trim();
  if (!ownerMid) return { ok: false, error: '还没配置他的 B 站 UID（ownerBiliMid）' };
  const budget = commentBudget();
  if (!dry && budget.remaining <= 0) return { ok: false, error: `今天已经评论过 ${budget.count} 条了（上限 ${budget.perDay}）` };

  const acc = loadDynamicAccount();
  const listed = await listOwnerVideos(ownerMid, 20, { cookie: acc.cookie });
  if (!listed.ok) return { ok: false, error: `拿不到他的视频列表：${listed.error}` };
  const fresh = listed.videos.filter((v) => !budget.videos[v.aid]);
  if (!fresh.length) return { ok: true, skipped: true, error: '他的视频都评过了' };
  const video = fresh[Math.floor(Math.random() * Math.min(3, fresh.length))];

  const gen = await ask(ctx, config, log, videoCommentPrompt(video));
  if (!gen.ok) return gen;
  if (gen.skipped) return { ok: true, skipped: true, text: '', video };
  const text = gen.text.slice(0, 120);
  if (dry) return { ok: true, dry: true, text, video };
  const r = await postComment(undefined, video.aid, text);
  if (!r.ok) return { ok: false, error: r.error || '评论失败', text, video };
  let review = null;
  try { review = await commentVisibility(undefined, video.aid, r.rpid); } catch {}
  const visible = review && review.ok ? review.visible === true : null;
  const state = review && review.ok ? review.state : null;
  try {
      const { readFileSync: rf, writeFileSync: wf } = await import('node:fs')
      const p = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'qq-fish', 'comment-log.json')
      let items = []
      try { items = JSON.parse(rf(p, 'utf8')).items || [] } catch {}
      items.push({ at: Date.now(), aid: String(video && video.aid || ''), rpid: String(r.rpid || ''), text: String(text || '').slice(0, 100) })
      wf(p, JSON.stringify({ items: items.slice(-50) }))
    } catch {}
    return { ok: true, dry: false, posted: true, text, video, rpid: r.rpid || '', visible, state, reviewError: (review && review.error) || '' };
}
