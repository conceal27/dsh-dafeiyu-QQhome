// 她自己的 B 站动态发布（写操作，只发自己的号）。
//
// 边界：只发文字动态，不 @ 任何人、不配图、不带话题。每天最多 N 条（默认 1 条），
// 由调用方（push）决定要不要发、发什么；本模块只负责「发 + 记账 + 限额」。
//
// 接口：POST /x/dynamic/feed/create/dyn，WBI 签名的时间戳参数名必须是 t，body 里 csrf 也要带。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wbiQuery, BILI_UA } from './wbi.mjs';

const REF = 'https://t.bilibili.com/';
const MAX_LEN = 2000;

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

export function dynamicPaths(home = os.homedir()) {
  const base = path.join(home, '.dsh', 'qq-fish', 'bili');
  return {
    base,
    credentials: path.join(base, 'credentials.json'),
    state: path.join(base, 'dynamic-state.json'),
    config: path.join(home, '.dsh', 'qq-fish', 'config.json'),
  };
}

export function loadDynamicAccount(home = os.homedir()) {
  const p = dynamicPaths(home);
  const cred = readJson(p.credentials, {}) || {};
  const sessdata = String(cred.sessdata || '').trim();
  const biliJct = String(cred.bili_jct || '').trim();
  const buvid3 = String(cred.buvid3 || '').trim();
  const cookie = [
    sessdata ? `SESSDATA=${sessdata}` : '',
    biliJct ? `bili_jct=${biliJct}` : '',
    buvid3 ? `buvid3=${buvid3}` : '',
  ].filter(Boolean).join('; ');
  return { cred, sessdata, biliJct, cookie, hasCredentials: Boolean(sessdata && biliJct) };
}

function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 今天已经发了几条（只统计成功的）。 */
export function dynamicCountToday(home = os.homedir(), now = new Date()) {
  const state = readJson(dynamicPaths(home).state, {}) || {};
  const day = todayKey(now);
  if (state.date !== day) return { count: 0, items: [] };
  const items = Array.isArray(state.items) ? state.items : [];
  return { count: items.length, items };
}

/** 今天的额度（默认 1 条/天，可在 config.json 用 biliDynamicPerDay 改）。 */
export function dynamicBudget(home = os.homedir()) {
  const p = dynamicPaths(home);
  const cfg = readJson(p.config, {}) || {};
  const raw = Number(cfg.biliDynamicPerDay);
  const perDay = Number.isFinite(raw) && raw >= 0 ? Math.min(5, Math.floor(raw)) : 1;
  const { count, items } = dynamicCountToday(home);
  return { perDay, count, remaining: Math.max(0, perDay - count), items };
}

export function recordDynamic(home, { text = '', dynId = '' } = {}, now = new Date()) {
  const p = dynamicPaths(home);
  const state = readJson(p.state, {}) || {};
  const day = todayKey(now);
  const items = state.date === day && Array.isArray(state.items) ? state.items : [];
  items.push({ at: now.toISOString(), dynId: String(dynId || ''), text: String(text || '').slice(0, 200) });
  atomicWriteJson(p.state, { date: day, items });
  return items.length;
}

/**
 * 发一条文字动态。
 * @returns {Promise<{ok:boolean, code?:number, message?:string, dynId?:string, error?:string, text?:string}>}
 */
export async function postDynamic(home, text) {
  const bodyText = String(text || '').trim();
  if (!bodyText) return { ok: false, error: '正文为空' };
  if (bodyText.length > MAX_LEN) return { ok: false, error: `正文超长（${bodyText.length}/${MAX_LEN}）` };

  const acc = loadDynamicAccount(home);
  if (!acc.hasCredentials) return { ok: false, error: '缺少 SESSDATA / bili_jct 凭据' };

  let qs;
  try {
    qs = await wbiQuery(acc.cookie, { csrf: acc.biliJct }, 't');
  } catch (error) {
    return { ok: false, error: `签名失败：${error.message}` };
  }

  const body = JSON.stringify({
    csrf: acc.biliJct,
    dyn_req: {
      content: { contents: [{ raw_text: bodyText, type: 1, biz_id: '' }] },
      scene: 1,
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
  });

  let out;
  try {
    const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/create/dyn?${qs}`, {
      method: 'POST',
      headers: {
        'user-agent': BILI_UA,
        referer: REF,
        origin: 'https://t.bilibili.com',
        'content-type': 'application/json',
        cookie: acc.cookie,
      },
      body,
    });
    out = await r.json().catch(() => ({ code: -1, message: `HTTP ${r.status} 非 JSON 响应` }));
  } catch (error) {
    return { ok: false, error: `网络错误：${error.message}` };
  }

  if (out.code !== 0) {
    return { ok: false, code: out.code, message: out.message || '', error: `code=${out.code} ${out.message || ''}`.trim() };
  }
  const dynId = String(out?.data?.dyn_id_str || out?.data?.dyn_id || '');
  recordDynamic(home, { text: bodyText, dynId });
  return { ok: true, code: 0, message: 'OK', dynId, text: bodyText };
}
