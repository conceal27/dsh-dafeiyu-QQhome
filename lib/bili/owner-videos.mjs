// 读主人（owner B站 UID）空间里的视频列表，给「只在他视频下评论」用。
//
// 老手机容器出口 IP 容易被风控（-352），所以：
//   1. 有 Cookie 就带 Cookie（她的登录态）+ 常见浏览器指纹参数；
//   2. 拿不到新列表时回退到上次成功缓存的列表（owner-videos.json）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wbiQuery, BILI_UA } from './wbi.mjs';

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function ownerVideosCachePath(home = os.homedir()) {
  return path.join(home, '.dsh', 'qq-fish', 'bili', 'owner-videos.json');
}

function normalize(vlist) {
  return (Array.isArray(vlist) ? vlist : []).map((v) => ({
    aid: String(v.aid || ''),
    bvid: String(v.bvid || ''),
    title: String(v.title || ''),
    description: String(v.description || ''),
    created: Number(v.created || 0),
    play: Number(v.play || 0),
  })).filter((v) => v.aid && v.bvid);
}

/**
 * @param {string} mid 主人 UID
 * @param {number} count 拉多少个
 * @param {{cookie?: string, home?: string}} opts
 * @returns {Promise<{ok:boolean, videos?:Array, cached?:boolean, at?:number, error?:string}>}
 */
export async function listOwnerVideos(mid, count = 10, opts = {}) {
  const id = String(mid || '').trim();
  if (!id) return { ok: false, error: '没有 ownerBiliMid' };
  const size = Math.max(1, Math.min(50, Number(count) || 10));
  const home = opts.home || os.homedir();
  const cookie = String(opts.cookie || '').trim();
  const cacheFile = ownerVideosCachePath(home);

  const fromCache = (reason) => {
    const cached = readJson(cacheFile, null);
    if (cached && Array.isArray(cached.videos) && cached.videos.length) {
      return { ok: true, videos: cached.videos, cached: true, at: Number(cached.at || 0), error: reason };
    }
    return { ok: false, error: reason };
  };

  try {
    const qs = await wbiQuery(cookie, {
      mid: id,
      ps: size,
      pn: 1,
      order: 'pubdate',
      platform: 'web',
      web_location: '1550101',
      dm_img_list: '[]',
      dm_img_str: 'V2ViR0wgMS4w',
      dm_cover_img_str: 'QU5HTEUgKEFwcGxlLCBBcHBsZSBHUFUgKE1ldGFsKSkgR0w0',
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    }, 'wts');
    const headers = {
      'user-agent': BILI_UA,
      referer: `https://space.bilibili.com/${id}/video`,
      ...(cookie ? { cookie, origin: 'https://space.bilibili.com' } : {}),
    };
    const r = await fetch(`https://api.bilibili.com/x/space/wbi/arc/search?${qs}`, { headers });
    const j = await r.json().catch(() => null);
    if (j && j.code === 0) {
      const videos = normalize(j.data?.list?.vlist);
      if (videos.length) writeJson(cacheFile, { at: Date.now(), videos });
      return { ok: true, videos };
    }
    return fromCache(`code=${j?.code} ${j?.message || ''}`.trim());
  } catch (error) {
    return fromCache(`网络错误：${error.message}`);
  }
}
