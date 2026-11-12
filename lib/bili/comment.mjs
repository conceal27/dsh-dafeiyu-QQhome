// 在主人的视频下评论（只在他 UID 的视频下，别处一律不发）。
//
// 限额：每天最多 1 条（commentPerDay 可调）；**同一个视频永远只评一次**。
// 接口：POST /x/v2/reply/add（form-urlencoded，csrf=bili_jct）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wbiQuery, BILI_UA } from './wbi.mjs';

const REF = 'https://www.bilibili.com/';
const MAX_LEN = 1000;

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function commentPaths(home = os.homedir()) {
  const base = path.join(home, '.dsh', 'qq-fish', 'bili');
  return { base, credentials: path.join(base, 'credentials.json'), state: path.join(base, 'comment-state.json'), config: path.join(home, '.dsh', 'qq-fish', 'config.json') };
}

function loadCredentials(home) {
  const cred = readJson(commentPaths(home).credentials, {}) || {};
  const sessdata = String(cred.sessdata || '').trim();
  const biliJct = String(cred.bili_jct || '').trim();
  const buvid3 = String(cred.buvid3 || '').trim();
  const cookie = [sessdata ? `SESSDATA=${sessdata}` : '', biliJct ? `bili_jct=${biliJct}` : '', buvid3 ? `buvid3=${buvid3}` : ''].filter(Boolean).join('; ');
  return { cookie, biliJct, hasCredentials: Boolean(sessdata && biliJct) };
}

function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 今天评论了几条 + 哪些视频已经评过。 */
export function commentState(home = os.homedir(), now = new Date()) {
  const state = readJson(commentPaths(home).state, {}) || {};
  const videos = state.videos && typeof state.videos === 'object' ? state.videos : {};
  const day = todayKey(now);
  const count = state.today && state.today.date === day ? Number(state.today.count || 0) : 0;
  return { count, videos };
}

export function commentBudget(home = os.homedir()) {
  const cfg = readJson(commentPaths(home).config, {}) || {};
  const raw = Number(cfg.commentPerDay);
  const perDay = Number.isFinite(raw) && raw >= 0 ? Math.min(3, Math.floor(raw)) : 1;
  const { count, videos } = commentState(home);
  return { perDay, count, remaining: Math.max(0, perDay - count), videos };
}

export function recordComment(home, aid, now = new Date()) {
  const p = commentPaths(home);
  const state = readJson(p.state, {}) || {};
  const videos = state.videos && typeof state.videos === 'object' ? state.videos : {};
  videos[String(aid)] = now.toISOString();
  const day = todayKey(now);
  const count = state.today && state.today.date === day ? Number(state.today.count || 0) : 0;
  atomicWriteJson(p.state, { videos, today: { date: day, count: count + 1 } });
}

/**
 * 在某个视频下发一条评论。
 * @returns {Promise<{ok:boolean, code?:number, message?:string, rpid?:string, error?:string}>}
 */
export async function postComment(home, aid, text) {
  const id = String(aid || '').trim();
  const bodyText = String(text || '').trim();
  if (!id) return { ok: false, error: '缺 aid' };
  if (!bodyText) return { ok: false, error: '评论为空' };
  if (bodyText.length > MAX_LEN) return { ok: false, error: `评论超长（${bodyText.length}/${MAX_LEN}）` };

  const acc = loadCredentials(home);
  if (!acc.hasCredentials) return { ok: false, error: '缺少 SESSDATA / bili_jct 凭据' };

  const form = new URLSearchParams({
    oid: id,
    type: '1',
    message: bodyText,
    plat: '1',
    csrf: acc.biliJct,
  });

  let out;
  try {
    const r = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: {
        'user-agent': BILI_UA,
        referer: REF,
        origin: 'https://www.bilibili.com',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: acc.cookie,
      },
      body: form.toString(),
    });
    out = await r.json().catch(() => ({ code: -1, message: `HTTP ${r.status} 非 JSON 响应` }));
  } catch (error) {
    return { ok: false, error: `网络错误：${error.message}` };
  }

  if (out.code !== 0) {
    return { ok: false, code: out.code, message: out.message || '', error: `code=${out.code} ${out.message || ''}`.trim() };
  }
  const rpid = String(out?.data?.rpid_str || out?.data?.rpid || '');
  recordComment(home, id);
  return { ok: true, code: 0, rpid };
}

/**
 * 发一条「楼中楼」回复（回复评论区里某个人的评论）。
 *
 * 【2026-11-12 补】lib/bili/at-loop.mjs 与 lib/bili/reply-loop.mjs 一直在
 * `import { postReply } from './comment.mjs'` 并调用它，但这个函数从来没被
 * 写出来过 —— comment.mjs 只导出 postComment。结果是整个 dafeiyu 插件在
 * 启动时 `failed to import`（SyntaxError: does not provide an export named
 * 'postReply'），QQ 机器人直接挂掉。这里按 postComment 的写法补齐。
 *
 * B 站楼中楼接口和发评论不同：
 *   POST https://api.bilibili.com/x/v2/reply/add
 *   oid=视频aid, type=1, root=顶层评论rpid, parent=被回复的那条rpid, message=正文
 * root 必须是「主评论」，parent 是「你回复的那条」。两者都传对才挂在正确楼层。
 *
 * @param {string} home 插件家目录
 * @param {string|number} aid 视频 aid
 * @param {string|number} root 顶层评论 rpid（楼层根）
 * @param {string|number} parent 被回复的那条 rpid
 * @param {string} text 回复正文
 * @returns {Promise<{ok:boolean, rpid?:string, code?:number, message?:string, error?:string}>}
 */
export async function postReply(home, aid, root, parent, text) {
  const id = String(aid || '').trim();
  const rootId = String(root || '').trim();
  const parentId = String(parent || '').trim();
  const bodyText = String(text || '').trim();
  if (!id) return { ok: false, error: '缺 aid' };
  if (!rootId) return { ok: false, error: '缺 root（楼层根评论 rpid）' };
  if (!parentId) return { ok: false, error: '缺 parent（要回复的那条 rpid）' };
  if (!bodyText) return { ok: false, error: '回复为空' };
  if (bodyText.length > MAX_LEN) return { ok: false, error: `回复超长（${bodyText.length}/${MAX_LEN}）` };

  const acc = loadCredentials(home);
  if (!acc.hasCredentials) return { ok: false, error: '缺少 SESSDATA / bili_jct 凭据' };

  const form = new URLSearchParams({
    oid: id,
    type: '1',
    root: rootId,
    parent: parentId,
    message: bodyText,
    plat: '1',
    csrf: acc.biliJct,
  });

  let out;
  try {
    const r = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: {
        'user-agent': BILI_UA,
        referer: REF,
        origin: 'https://www.bilibili.com',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: acc.cookie,
      },
      body: form.toString(),
    });
    out = await r.json().catch(() => ({ code: -1, message: `HTTP ${r.status} 非 JSON 响应` }));
  } catch (error) {
    return { ok: false, error: `网络错误：${error.message}` };
  }

  if (out.code !== 0) {
    return { ok: false, code: out.code, message: out.message || '', error: `code=${out.code} ${out.message || ''}`.trim() };
  }
  const rpid = String(out?.data?.rpid_str || out?.data?.rpid || '');
  recordComment(home, id);
  return { ok: true, code: 0, rpid };
}

/**
 * 发完之后回查：这条评论在评论区是不是「正常可见」。
 * B 站低等级号评论常进审核（state 非 0），接口却仍回 code=0 —— 必须回查，不能把"提交成功"当成"别人能看见"。
 */
export async function commentVisibility(home, aid, rpid) {
  const acc = loadCredentials(home);
  if (!acc.hasCredentials) return { ok: false, error: '缺少凭据' };
  try {
    const qs = await wbiQuery(acc.cookie, {
      oid: String(aid), type: 1, mode: 3, plat: 1, web_location: '1315875',
      pagination_str: '{"offset":""}',
    }, 'wts');
    const r = await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + qs, {
      headers: { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/', cookie: acc.cookie },
    });
    const j = await r.json().catch(() => null);
    if (!j || j.code !== 0) return { ok: false, error: 'code=' + (j && j.code) };
    const all = [...(j.data?.top_replies || []), ...(j.data?.replies || [])];
    const hit = all.find((x) => String(x.rpid) === String(rpid));
    if (!hit) return { ok: true, found: false, visible: false, state: null, reason: '列表里没有（审核中或被吞）' };
    const state = Number(hit.state != null ? hit.state : 0);
    return { ok: true, found: true, state, visible: state === 0, rpid: String(hit.rpid) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
