// WBI 签名：B 站 web 接口的防爬参数（w_rid + 时间戳）。
//
// 算法是公开的：
//   1. GET /x/web-interface/nav 拿 data.wbi_img.img_url / sub_url
//   2. 取两个文件名（去掉 .png）拼起来，按固定表 MIXIN_TAB 重排后取前 32 位 = mixinKey
//   3. 业务参数 + 时间戳，按 key 排序 → 去掉 !'()* → encodeURIComponent → 拼 query
//   4. w_rid = md5(query + mixinKey)
//
// 时间戳参数名两种：普通接口用 wts；**动态发布等新接口用 t**（用错会 code=-111 csrf 校验失败）。
import crypto from 'node:crypto';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function keyOf(url) {
  const s = String(url || '');
  const slash = s.lastIndexOf('/');
  const dot = s.lastIndexOf('.');
  if (slash < 0 || dot <= slash) return '';
  return s.slice(slash + 1, dot);
}

/**
 * 生成带 WBI 签名的 query 串（不含前导 ?）。
 * @param {string} cookieHeader Cookie 头；可传空串（nav 未登录也会返回 wbi_img）
 * @param {Record<string, string|number>} params 业务参数（不要自带 w_rid / 时间戳）
 * @param {'wts'|'t'} tsKey 时间戳参数名：普通接口 wts，动态发布 t
 */
export async function wbiQuery(cookieHeader, params = {}, tsKey = 'wts') {
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers });
  const d = await r.json().catch(() => null);
  const img = d?.data?.wbi_img?.img_url;
  const sub = d?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error(`wbi keys 获取失败（code=${d?.code ?? '?'} ${d?.message || ''}）`.trim());

  const raw = keyOf(img) + keyOf(sub);
  const mixinKey = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  const ts = Math.round(Date.now() / 1000);
  const clean = (v) => String(v).replace(/[!'()*]/g, '');
  const all = { ...params, [tsKey]: ts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(all[k]))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

export const BILI_UA = UA;
