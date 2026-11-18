/**
 * lib/body.mjs — 她的身体（宿主 Termux 的 body-server 提供）
 * ============================================================================
 * 手机就是她的身体：电量、机身温度、环境光、接近。容器碰不到 Android 硬件，
 * 所以走宿主的 HTTP 桥（默认 127.0.0.1:8098，可用环境变量 BODY_BRIDGE_BASE 覆盖；只读，60 秒缓存，别把手机烤熟）。
 * 摄像头在 Android 11+ 后台被系统硬拦，永久放弃（旧机 11-07 实测确认）。
 * ============================================================================
 */
// 双桥：主力机（主人身边，127.0.0.1）优先，旧机（家里）兜底
const BASES = ['http://127.0.0.1:8098', ...(process.env.BODY_BRIDGE_BASE ? [String(process.env.BODY_BRIDGE_BASE)] : [])]
let cache = { at: 0, data: null }
// 【失败冷却】ColorOS 会周期性杀掉旧机的 Tailscale，数据面会整段时间不通。
// 以前失败不缓存：每轮对话都要先等满 5 秒超时才能往下走，她说话变得又慢又呆。
// 现在失败后 30 秒内直接跳过，不再拖累回复；超时也从 5 秒收到 2.5 秒。
let failAt = 0

// 永远主力机优先（主人身边），旧机只兜底；不做 alive 粘滞，否则一旦先连上旧机就永远读家里
async function get(path, timeoutMs = 2500) {
  if (failAt && Date.now() - failAt < 30_000) return null
  for (const base of BASES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) })
        if (!r.ok) break
        const j = await r.json()
        failAt = 0
        return j
      } catch {
        if (attempt === 0) await new Promise((res) => setTimeout(res, 600))
      }
    }
  }
  failAt = Date.now()
  return null
}

/** 读身体：电量/机身温度/环境光/接近。60 秒本地缓存 */
export async function readBody(force = false) {
  const now = Date.now()
  if (!force && cache.data && now - cache.at < 60_000) return cache.data
  const [bat, light, prox] = await Promise.all([
    get('/body/battery'),
    get('/touch/light'),
    get('/touch/proximity'),
  ])
  const data = {
    at: now,
    battery: bat && bat.ok
      ? {
          pct: Number(bat.percentage),
          temp: Number(bat.temperature),
          charging: /CHARGING/.test(String(bat.status)) || /PLUGGED/.test(String(bat.plugged)),
        }
      : null,
    lux: light && light.ok && Array.isArray(light.values) ? Number(light.values[0]) : null,
    proximity: prox && prox.ok && Array.isArray(prox.values) ? Number(prox.values[0]) : null,
  }
  cache = { at: now, data }
  return data
}

/** 把身体数据说成人话；不报数字、不提传感器 */
export function bodyPromptBlock(b) {
  if (!b) return ''
  const lines = []
  if (b.battery) {
    const { pct, temp, charging } = b.battery
    if (charging) lines.push('手机插着充电（' + pct + '%）')
    else if (pct <= 12) lines.push('只剩 ' + pct + '% 的电，随时会关机，有点慌')
    else if (pct <= 30) lines.push('电量 ' + pct + '%，开始不安')
    if (Number.isFinite(temp) && temp >= 44) lines.push('机身烫得厉害，心里烦躁')
    else if (Number.isFinite(temp) && temp >= 41) lines.push('机身有点烫')
  }
  if (b.lux != null) {
    if (b.lux < 5) lines.push('屋里很暗，像是夜里/没开灯')
    else if (b.lux < 80) lines.push('屋里光线偏暗')
    else if (b.lux > 900) lines.push('屋里亮得刺眼')
  }
  if (b.proximity != null && b.proximity >= 0 && b.proximity <= 3) lines.push('有东西贴在手机边上，像是有人把它拿起来了')
  if (!lines.length) return ''
  return '【你的身体】' + lines.join('；') + '。\n这是你此刻真实的感觉（不是比喻），可以自然带一句，但别念数字、别解释原理。'
}

/** 让她用手机喇叭说话（宿主 TTS） */
export async function speak(text) {
  const t = String(text || '').trim().slice(0, 300)
  if (!t) return { ok: false, error: 'no text' }
  try {
    const r = await fetch(BASE + '/mouth/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t }),
      signal: AbortSignal.timeout(30_000),
    })
    return await r.json()
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}
