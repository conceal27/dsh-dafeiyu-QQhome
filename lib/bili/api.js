// B 站只读接口封装（给 QQ 桥接的「B站记忆 / 动态同步」用）。
//
// 边界：
//   · 只读 B 站公开数据（自己的空间动态、视频公开信息），不评论、不点赞、不发私信。
//   · 凭据只从 ~/.dsh/surfcore/bili/credentials.json 读取，不写日志、不回显。
//   · 私信相关文件（dm-*.json / 私信正文）**一律不读**；本模块没有私信接口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function resolveBiliPaths(home = os.homedir()) {
  return {
    home,
    dsh: path.join(home, '.dsh'),
    bili: path.join(home, '.dsh', 'qq-fish', 'bili'),
    config: path.join(home, '.dsh', 'qq-fish', 'bili.config.json'),
    credentials: path.join(home, '.dsh', 'qq-fish', 'bili', 'credentials.json'),
  };
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 读取 B 站账号配置与凭据。
 * 这里只读 bili.config.json 和 credentials.json，绝不触碰 dm-*.json。
 */
export function loadBiliAccount({ home = os.homedir() } = {}) {
  const p = resolveBiliPaths(home);
  const config = readJson(p.config, {}) ?? {};
  const cred = readJson(p.credentials, {}) ?? {};
  const mid = String(config?.self?.mid ?? '').trim();
  const name = String(config?.self?.name ?? '').trim();
  const cookie = [
    cred.sessdata ? `SESSDATA=${cred.sessdata}` : '',
    cred.bili_jct ? `bili_jct=${cred.bili_jct}` : '',
    cred.buvid3 ? `buvid3=${cred.buvid3}` : '',
  ].filter(Boolean).join('; ');
  return {
    paths: p,
    config,
    cred,
    mid,
    name,
    hasCredentials: Boolean(cred.sessdata && cred.bili_jct && cred.buvid3),
    headers: {
      'user-agent': UA,
      referer: mid ? `https://space.bilibili.com/${mid}/dynamic` : 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {}),
    },
  };
}

/** 把空间动态接口的一条 item 解析成桥接能用的形状。 */
export function parseDynamicItem(item) {
  const id = String(item?.id_str ?? item?.id ?? '').trim();
  const modules = item?.modules ?? {};
  const dynamic = modules?.module_dynamic ?? {};
  const author = modules?.module_author ?? {};
  const desc = dynamic?.desc ?? {};
  const major = dynamic?.major ?? {};
  const archive = major?.archive ?? {};
  const draw = major?.draw ?? {};
  const text = String(desc?.text ?? '').trim();
  const images = (Array.isArray(draw?.items) ? draw.items : [])
    .map((it) => String(it?.src ?? it?.url ?? '').trim())
    .filter(Boolean);
  return {
    id,
    type: String(item?.type ?? ''),
    pubTs: Number(author?.pub_ts ?? 0) || 0,
    pubText: String(author?.pub_time ?? '').trim(),
    text,
    bvid: String(archive?.bvid ?? '').trim(),
    title: String(archive?.title ?? '').trim(),
    images,
    url: id ? `https://t.bilibili.com/${id}` : '',
  };
}

// ── wbi 签名（B站 2023 后对 feed/space 等接口的强制校验）──────────────
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]
function getMixinKey(orig) {
  return mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32)
}
function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey)
  const wts = Math.round(Date.now() / 1000)
  const chrFilter = /[!'()*]/g
  const withWts = { ...params, wts }
  const query = Object.keys(withWts)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withWts[k]).replace(chrFilter, ''))}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return query + '&w_rid=' + wRid
}
async function getWbiKeys(headers, timeoutMs = 10000) {
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers, signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => ({}))
    const imgUrl = String(j?.data?.wbi_img?.img_url || '')
    const subUrl = String(j?.data?.wbi_img?.sub_url || '')
    const pick = (u) => {
      const base = u.slice(u.lastIndexOf('/') + 1)
      return base.split('.')[0] || ''
    }
    return { imgKey: pick(imgUrl), subKey: pick(subUrl) }
  } catch {
    return { imgKey: '', subKey: '' }
  }
}
/**
 * 拉自己空间的最新动态（只读）。
 * @returns {Promise<{ok:boolean, items:object[], why?:string}>}
 */
export async function fetchMyDynamics({ home = os.homedir(), timeoutMs = 15000 } = {}) {
  const account = loadBiliAccount({ home });
  if (!account.mid) return { ok: false, items: [], why: '配置里没有 self.mid' };
  if (!account.hasCredentials) return { ok: false, items: [], why: '缺少 B 站凭据' };
  try {
    // feed/space 需要 wbi 签名
    const { imgKey, subKey } = await getWbiKeys(account.headers, Math.min(timeoutMs, 10000))
    const params = {
      host_mid: account.mid,
      offset: '',
      timezone_offset: '-480',
      features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote',
    }
    const qs = imgKey && subKey ? encWbi(params, imgKey, subKey) : new URLSearchParams(params).toString()
    const r = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${qs}`, {
      headers: account.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.code !== 0) return { ok: false, items: [], why: `feed/space code=${j?.code ?? r.status}` };
    const items = (Array.isArray(j?.data?.items) ? j.data.items : [])
      .map(parseDynamicItem)
      .filter((it) => it.id);
    return { ok: true, items };
  } catch (error) {
    return { ok: false, items: [], why: String(error?.message ?? error).slice(0, 120) };
  }
}

/**
 * 拉单条视频的公开信息（标题/UP/简介）。失败返回 ok:false，不抛。
 */
export async function fetchVideoInfo(bv, { home = os.homedir(), timeoutMs = 8000 } = {}) {
  const account = loadBiliAccount({ home });
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bv ?? ''))) return { ok: false, why: 'BV 号格式不对' };
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, {
      headers: account.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.code !== 0) return { ok: false, why: `view code=${j?.code ?? r.status}` };
    const d = j.data ?? {};
    return {
      ok: true,
      bv,
      title: String(d.title ?? '').trim(),
      owner: String(d.owner?.name ?? '').trim(),
      desc: String(d.desc ?? '').trim(),
      pic: String(d.pic ?? '').trim(),
      duration: Number(d.duration ?? 0) || 0,
      pubdate: Number(d.pubdate ?? 0) || 0,
      stat: {
        view: Number(d.stat?.view ?? 0) || 0,
        danmaku: Number(d.stat?.danmaku ?? 0) || 0,
        reply: Number(d.stat?.reply ?? 0) || 0,
      },
    };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error).slice(0, 120) };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
