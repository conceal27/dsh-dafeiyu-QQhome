/**
 * lib/netguard.mjs — 出站请求的 SSRF 防护
 * ============================================================================
 * 为什么要有这个：
 *   图片/视频/网页抓取的 URL 来自聊天内容，也就是**别人可控**。
 *   不做防护的话，对方发一个 http://192.168.1.1/admin 就能让她去访问内网。
 *
 * 三条规则：
 *   1. 只允许 http/https（禁 file:/gopher:/data: 等）
 *   2. 解析出的所有 IP 都不能是内网/回环/链路本地/保留地址
 *   3. 重定向手动跟随，每一跳都重新校验（防「公网 302 到内网」）
 *
 * 用法：把原来的 fetch(url, opts) 换成 safeFetch(url, opts)
 * ============================================================================
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 判断一个 IP 是否属于内网/保留段 */
export function isPrivateIP(ip) {
  const s = String(ip || '').trim()
  if (!s) return true
  const v = isIP(s)
  if (v === 4) {
    const p = s.split('.').map(Number)
    if (p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
    const [a, b] = p
    if (a === 0) return true                          // 0.0.0.0/8
    if (a === 10) return true                         // 私有
    if (a === 127) return true                        // 回环
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 169 && b === 254) return true           // 链路本地（云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true  // 私有
    if (a === 192 && b === 168) return true           // 私有
    if (a === 192 && b === 0) return true             // 保留
    if (a >= 224) return true                         // 组播/保留
    return false
  }
  if (v === 6) {
    const lower = s.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true  // 唯一本地
    if (lower.startsWith('fe80')) return true                          // 链路本地
    if (lower.startsWith('::ffff:')) return isPrivateIP(lower.slice(7)) // 映射 v4
    return false
  }
  return true
}

/** 校验一个 URL 是否允许出站；返回 { ok, reason, host, ips } */
export async function checkUrl(raw) {
  let u
  try { u = new URL(String(raw || '').trim()) } catch { return { ok: false, reason: '不是合法 URL' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '只允许 http/https，收到 ' + u.protocol }

  const host = u.hostname
  if (!host) return { ok: false, reason: '缺少主机名' }

  // 直接写 IP 的情况
  if (isIP(host)) {
    if (isPrivateIP(host)) return { ok: false, reason: '目标是内网地址 ' + host }
    return { ok: true, host, ips: [host] }
  }

  // 域名 → 解析全部地址，任何一个落在内网就拒绝（防 DNS 混批）
  let addrs = []
  try {
    addrs = await lookup(host, { all: true, verbatim: true, family: 4 })
  } catch (e) {
    return { ok: false, reason: '域名解析失败：' + ((e && e.message) || e) }
  }
  if (!addrs.length) return { ok: false, reason: '域名没有解析结果' }
  const ips = addrs.map((a) => a.address)
  const bad = ips.find((ip) => isPrivateIP(ip))
  if (bad) return { ok: false, reason: '域名指向内网地址 ' + bad, host, ips }
  return { ok: true, host, ips }
}

/**
 * 带防护的 fetch。签名与 fetch 一致，多一个 opts.maxRedirects。
 * 重定向手动跟随，每一跳都重新校验目标。
 */
export async function safeFetch(url, opts = {}) {
  const { maxRedirects = 4, ...rest } = opts
  let current = String(url || '').trim()
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const chk = await checkUrl(current)
    if (!chk.ok) throw new Error('SSRF 拦截：' + chk.reason)
    const res = await fetch(current, { ...rest, redirect: 'manual' })
    const isRedirect = res.status >= 300 && res.status < 400
    if (!isRedirect) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    try { await res.arrayBuffer() } catch {}
    let next
    try { next = new URL(loc, current).toString() } catch { throw new Error('SSRF 拦截：重定向地址非法') }
    current = next
  }
  throw new Error('SSRF 拦截：重定向次数过多')
}
