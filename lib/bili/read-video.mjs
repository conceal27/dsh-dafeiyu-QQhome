// 把一个 B 站视频读成结构化文本（抄 dsh-bili-watch 的思路）：
//   元数据 + 热评（过滤 AI 评论）+ 字幕（优先）+ 弹幕采样 + 24h 缓存。
// 目的：让她"真的看过"，而不是只拿标题瞎猜。只读，不点任何东西。
// 说明：抽帧 OCR 需要 tesseract，这台机器没有，所以不做；视频理解靠字幕+热评+弹幕。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { wbiQuery, BILI_UA } from './wbi.mjs';

const UA = BILI_UA;
const CACHE_TTL = 24 * 3600 * 1000;

function cachePath(home = os.homedir()) {
  return path.join(home, '.dsh', 'qq-fish', 'bili', 'read-cache.json');
}
function loadCache(home) {
  try { return JSON.parse(fs.readFileSync(cachePath(home), 'utf8')) || {}; } catch { return {}; }
}
function saveCache(home, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
    const keys = Object.keys(cache).slice(-200);
    const trimmed = {};
    for (const k of keys) trimmed[k] = cache[k];
    fs.writeFileSync(cachePath(home), JSON.stringify(trimmed), 'utf8');
  } catch {}
}

/** 从文本/短链里认出视频：BV 号、av 号、b23.tv 短链 */
export async function resolveVideoInput(input) {
  const s = String(input || '').trim();
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const av = s.match(/av(\d+)/i);
  if (av) return { aid: av[1] };
  const short = s.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/);
  if (short) {
    try {
      const r = await fetch(short[0], { redirect: 'manual', headers: { 'user-agent': UA } });
      const loc = r.headers.get('location') || '';
      const m = loc.match(/BV[0-9A-Za-z]{10}/);
      if (m) return { bvid: m[0] };
    } catch {}
  }
  return null;
}

/** 元数据（公开接口） */
export async function fetchView(bvid) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0 || !j.data) return { ok: false, error: `view code=${j && j.code} ${j && j.message}` };
  const d = j.data;
  const page = (d.pages || [])[0] || {};
  return {
    ok: true,
    aid: String(d.aid),
    cid: String(page.cid || d.cid),
    bvid,
    title: String(d.title || ''),
    owner: String((d.owner && d.owner.name) || ''),
    ownerMid: String((d.owner && d.owner.mid) || ''),
    desc: String(d.desc || ''),
    tags: Array.isArray(d.tags) ? d.tags : [],
    view: Number((d.stat && d.stat.view) || 0),
    reply: Number((d.stat && d.stat.reply) || 0),
    duration: Number(d.duration || 0),
    pubdate: Number(d.pubdate || 0),
  };
}

const AI_COMMENT_NAME = /(^|\b)(ai|bot|机器人|助手|自动)(\b|$)/i;
const AI_COMMENT_TEXT = /(本条评论由|ai生成|自动回复|机器人生成)/i;

/** 热评（过滤 AI/机器人评论） */
export async function fetchComments(aid, want = 8) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=0&ps=${Math.max(want, 10)}`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    });
    const j = await r.json().catch(() => null);
    if (!j || j.code !== 0) return { ok: false, list: [] };
    const out = [];
    const push = (x, tag) => {
      if (!x || out.length >= want) return;
      const name = String((x.member && x.member.uname) || '');
      const text = String((x.content && x.content.message) || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (AI_COMMENT_NAME.test(name) || AI_COMMENT_TEXT.test(text)) return;
      out.push({ tag, name, text: text.slice(0, 120), like: Number(x.like || 0) });
    };
    push(j.data && j.data.top && j.data.top.upper, 'UP置顶');
    for (const x of (j.data && j.data.replies) || []) push(x, '');
    return { ok: true, list: out };
  } catch (error) {
    return { ok: false, list: [], error: String(error.message || error) };
  }
}

/** 字幕（需要登录态；没有轨就返回空） */
export async function fetchSubtitle(cookie, aid, cid) {
  try {
    const qs = await wbiQuery(cookie || '', { aid: String(aid), cid: String(cid) }, 'wts');
    const r = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${qs}`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    });
    const j = await r.json().catch(() => null);
    if (!j || j.code !== 0) return { ok: false, error: `wbi/v2 code=${j && j.code}` };
    const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    const track = subs.find((s) => s.subtitle_url);
    if (!track) return { ok: false, error: '无字幕轨' };
    const url = String(track.subtitle_url).startsWith('//') ? 'https:' + track.subtitle_url : track.subtitle_url;
    const sr = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } });
    const sj = await sr.json().catch(() => null);
    const text = ((sj && sj.body) || []).map((x) => String(x.content || '')).join('').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, error: '字幕内容为空' };
    return { ok: true, text, lan: track.lan || '' };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/** 弹幕采样（接口返回 deflate 流，需要手动解压） */
export async function fetchDanmaku(cid, sample = 24) {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/video/BV1/' },
    });
    if (!r.ok) return { ok: false, list: [] };
    const buf = Buffer.from(await r.arrayBuffer());
    let xml = buf.toString('utf8');
    if (!xml.includes('<d ')) {
      for (const fn of ['inflateRawSync', 'inflateSync', 'gunzipSync', 'brotliDecompressSync']) {
        try {
          const out = zlib[fn](buf).toString('utf8');
          if (out.includes('<d ')) { xml = out; break; }
        } catch {}
      }
    }
    const all = [];
    const re = /<d p="[^"]*">([^<]*)<\/d>/g;
    let m;
    while ((m = re.exec(xml)) && all.length < 4000) {
      const t = m[1].replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 40) all.push(t);
    }
    if (!all.length) return { ok: true, list: [] };
    const step = Math.max(1, Math.floor(all.length / sample));
    const picked = [];
    for (let i = 0; i < all.length && picked.length < sample; i += step) picked.push(all[i]);
    return { ok: true, list: picked };
  } catch (error) {
    return { ok: false, list: [], error: String(error.message || error) };
  }
}

/**
 * 读一个视频，返回结构化结果（默认 24h 缓存，二次读瞬时）。
 * @param {string} bvid
 * @param {{cookie?: string, comments?: boolean, subtitle?: boolean, danmaku?: boolean, noCache?: boolean, home?: string}} opts
 */
/**
 * 抽帧 OCR 兜底：字幕拿不到时，下 360P + 抽 4 帧 + tesseract 识别。
 * 优化点：
 *   - 只请求 360P（qn=16），流量最小
 *   - 只下前 60 秒（ffmpeg -t 60），信息密度最高
 *   - 只抽 4 帧（1/15s 间隔），够覆盖片头字幕/封面文字
 *   - 识别结果并进 subtitle，走同一份缓存
 */
export async function fetchFrameOCR(view, opts = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const path2 = await import('node:path')

  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'dsh-ocr-'))
  const vid = path2.join(tmp, 'v.mp4')
  const cleanup = () => { try { fs2.rmSync(tmp, { recursive: true, force: true }) } catch {} }

  try {
    // ① 拿播放地址（最低清）
    const referer = 'https://www.bilibili.com/video/' + view.bvid
    const u = new URL('https://api.bilibili.com/x/player/playurl')
    u.searchParams.set('bvid', view.bvid)
    u.searchParams.set('cid', view.cid)
    u.searchParams.set('qn', '16')        // 360P
    u.searchParams.set('fnval', '1')      // mp4
    u.searchParams.set('fourk', '0')
    const cookie = String(opts.cookie || '')
    const res = await fetch(u.toString(), {
      headers: { 'user-agent': BILI_UA, referer, ...(cookie ? { cookie } : {}) },
    })
    const j = await res.json().catch(() => null)
    const durl = j && j.data && j.data.durl && j.data.durl[0]
    if (!durl || !durl.url) return { ok: false, error: '拿不到播放地址（可能需登录或有版权限制）' }

    // ② 下前 60 秒（ffmpeg 直接读远端，不落完整文件）
    await execFileP('ffmpeg', [
      '-y', '-t', '60',
      '-headers', 'Referer: ' + referer + '\r\nUser-Agent: ' + BILI_UA + '\r\n',
      '-i', durl.url, '-c', 'copy', vid,
    ], { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })

    // ③ 抽 4 帧
    const frames = []
    for (let i = 0; i < 4; i++) {
      const f = path2.join(tmp, 'f' + i + '.jpg')
      try {
        await execFileP('ffmpeg', ['-y', '-ss', String(i * 15), '-i', vid, '-frames:v', '1', '-q:v', '3', f], { timeout: 20_000 })
        if (fs2.existsSync(f)) frames.push(f)
      } catch {}
    }
    if (!frames.length) return { ok: false, error: '抽帧失败' }

    // ④ OCR
    const texts = []
    for (const f of frames) {
      try {
        const r = await execFileP('tesseract', [f, '-', '-l', 'chi_sim'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        const t = String(r.stdout || '').replace(/\s+/g, ' ').trim()
        if (t && t.length >= 4) texts.push(t)
      } catch {}
    }
    if (!texts.length) return { ok: false, error: '没识别到文字（可能是纯画面/音乐视频）' }
    return { ok: true, text: texts.join(' / ').slice(0, 800), frames: frames.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) }
  } finally {
    cleanup()
  }
}

export async function readVideo(bvid, opts = {}) {
  const home = opts.home || os.homedir();
  const key = String(bvid || '').trim();
  if (!opts.noCache) {
    const cache = loadCache(home);
    const hit = cache[key];
    if (hit && Date.now() - Number(hit.at || 0) < CACHE_TTL && hit.data && hit.data.ok) {
      return { ...hit.data, cached: true };
    }
  }
  const view = await fetchView(key);
  if (!view.ok) return view;
  const out = { ok: true, ...view, comments: [], subtitle: '', danmaku: [], notes: [] };

  if (opts.comments !== false) {
    const c = await fetchComments(view.aid, 8);
    if (c.ok) out.comments = c.list;
    else out.notes.push('热评没拿到');
  }
  if (opts.subtitle !== false) {
    const s = await fetchSubtitle(opts.cookie || '', view.aid, view.cid);
    if (s.ok) out.subtitle = s.text.slice(0, 1200);
    else {
      out.notes.push('字幕：' + s.error);
      // 【兜底】没字幕就抽帧 OCR，画面上的字也算"视频里说了什么"
      try {
        const ocr = await fetchFrameOCR(view, { cookie: opts.cookie });
        if (ocr.ok && ocr.text) {
          out.subtitle = '[画面文字] ' + ocr.text;
          out.notes.push('OCR 补了 ' + ocr.frames + ' 帧');
        } else {
          out.notes.push('OCR：' + (ocr.error || '无'));
        }
      } catch (e) {
        out.notes.push('OCR 异常：' + String((e && e.message) || e).slice(0, 60));
      }
    }
  }
  if (opts.danmaku !== false) {
    const d = await fetchDanmaku(view.cid, 20);
    if (d.ok) out.danmaku = d.list;
    else out.notes.push('弹幕没拿到');
  }
  try {
    const cache = loadCache(home);
    cache[key] = { at: Date.now(), data: out };
    saveCache(home, cache);
  } catch {}
  return out;
}

/** 把时间戳说成人话：3 天前 / 5 小时前 */
function relTime(sec) {
  const ts = Number(sec) || 0;
  if (!ts) return '';
  const diff = Date.now() - ts * 1000;
  if (diff < 0) return '刚发布';
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const dd = Math.floor(h / 24);
  if (dd < 30) return dd + ' 天前';
  const mo = Math.floor(dd / 30);
  if (mo < 12) return mo + ' 个月前';
  return Math.floor(mo / 12) + ' 年前';
}

/** 拼成给模型的「看过这个视频」背景文本 */
export function videoPromptText(v) {
  if (!v || !v.ok) return '';
  const lines = [`标题：${v.title}`, `UP：${v.owner}　播放：${v.view}`];
  if (v.pubdate) lines.push(`发布：${relTime(v.pubdate)}${(() => { try { return '（' + new Date(v.pubdate * 1000).toLocaleDateString('zh-CN') + '）' } catch { return '' } })()}`);
  if (v.duration) lines.push(`时长：${Math.floor(v.duration / 60)} 分 ${v.duration % 60} 秒`);
  if (v.desc) lines.push('简介：' + v.desc.slice(0, 200));
  if (v.subtitle) lines.push('【视频里说了什么（字幕节选）】\n' + v.subtitle.slice(0, 800));
  if (v.comments.length) {
    lines.push('【评论区】');
    for (const c of v.comments.slice(0, 5)) lines.push('- ' + (c.tag ? c.tag + '：' : '') + c.name + '：' + c.text);
  }
  if (v.danmaku.length) lines.push('【弹幕节选】' + v.danmaku.slice(0, 12).join(' / '));
  return lines.join('\n');
}
