/**
 * lib/bilishare.mjs — 她自己去 B 站逛，看到有意思的发给你
 * ============================================================================
 * 用她自己登录的那个 B 站号拿推荐流，挑一个没发过的，
 * 配上她自己的话 + 链接（B 站链接在 QQ 里会自动展开成卡片）。
 *
 * 不是定时发，是「她逛到了」才发：
 *   - 同一天最多 2 条
 *   - 和上一次分享至少隔 3 小时
 *   - 分享过的 bvid 记下来，不重复
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAuth, getRecommend, getVideoInfo } from './bili/client.mjs'
import { stateHome } from './store.mjs'

const STATE = join(stateHome(), 'bili-shared.json')
const MIN_GAP_MS = 3 * 3600 * 1000
const MAX_PER_DAY = 2

function load() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { shared: [], times: [] } }
}
function save(v) {
  try { writeFileSync(STATE, JSON.stringify(v, null, 2) + '\n', 'utf8') } catch {}
}
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天还能不能发 */
export function shareAllowance(now = Date.now()) {
  const st = load()
  const today = todayStr(new Date(now))
  const todayTimes = (st.times || []).filter((t) => todayStr(new Date(t)) === today)
  if (todayTimes.length >= MAX_PER_DAY) return { ok: false, reason: `今天已经分享过 ${todayTimes.length} 条了` }
  const last = Math.max(0, ...(st.times || []))
  if (last && now - last < MIN_GAP_MS) {
    return { ok: false, reason: `距上次分享才 ${Math.round((now - last) / 60000)} 分钟` }
  }
  return { ok: true, left: MAX_PER_DAY - todayTimes.length }
}

/**
 * 挑一个她今天想分享的视频：推荐流里没分享过、有点播放量的。
 * @returns {{ok:boolean, video?:object, url?:string, error?:string}}
 */
export async function pickShareCandidate({ count = 15, minPlay = 30000 } = {}) {
  let auth = null
  try { auth = loadAuth() } catch (e) { return { ok: false, error: 'B 站登录信息读不出来：' + ((e && e.message) || e) } }
  if (!auth || !auth.cookie) return { ok: false, error: 'B 站没登录（缺 cookie）' }
  let feed = []
  try { feed = await getRecommend(auth, count) } catch (e) { return { ok: false, error: '推荐流拿不到：' + ((e && e.message) || e) } }
  if (!Array.isArray(feed) || !feed.length) return { ok: false, error: '推荐流是空的' }

  const st = load()
  const done = new Set(st.shared || [])
  const fresh = feed.filter((v) => v && v.bvid && !done.has(v.bvid) && Number(v.play) >= minPlay)
  if (!fresh.length) return { ok: false, error: '没有没发过的新视频' }

  // 播放量高的优先，但别永远是第一名：在前三里随机
  fresh.sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0))
  const top = fresh.slice(0, 3)
  const v = top[Math.floor(Math.random() * top.length)]
  return { ok: true, video: v, url: 'https://www.bilibili.com/video/' + v.bvid }
}

/** 记一笔：这个发过了 */
export function markShared(bvid, now = Date.now()) {
  const st = load()
  st.shared = [...new Set([...(st.shared || []), String(bvid)])].slice(-200)
  st.times = [...(st.times || []), now].slice(-50)
  save(st)
}

/** 构造 B 站小程序卡片（QQ 里显示成带封面的大卡片） */
export function buildShareCard(video, url) {
  if (!video) return ''
  const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万播放' : String(n) + '播放')
  const card = {
    app: 'com.tencent.miniapp_01',
    view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
    ver: '1.0.0.19',
    prompt: '[QQ小程序]哔哩哔哩',
    config: { ctime: Math.floor(Date.now() / 1000), token: '' },
    meta: {
      detail_1: {
        appid: '1109937557',
        title: String(video.title || '哔哩哔哩').slice(0, 60),
        desc: (String(video.up || '') + ' · ' + wan(Number(video.play) || 0)).slice(0, 40),
        icon: 'https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png',
        preview: String(video.pic || ''),
        url: url,
        qqdocurl: url,
      },
    },
  }
  return JSON.stringify(card)
}

/** 把视频信息整理成给模型看的一段 */
export function sharePromptBlock(video, url) {  if (!video) return ''
  const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n))
  return [
    '【你刚在 B 站刷到一个视频】',
    `标题：${video.title}`,
    `UP：${video.up}`,
    `分区：${video.tname || '—'}｜播放：${wan(Number(video.play) || 0)}`,
    video.reason ? `推荐理由：${video.reason}` : '',
    video.desc ? `简介：${String(video.desc).slice(0, 120)}` : '',
    `链接：${url}`,
    '',
    '如果你觉得主人会喜欢，就把链接发给他，顺便说一句你为什么想给他看（一句话就够，别说成「为您推荐」那种）。',
    '如果你觉得没意思，就只输出 [跳过]。',
  ].filter(Boolean).join('\n')
}


/** 分享渠道说明（给她在分享提示里的选择权） */
export function shareChannelHint() {
  return '你可以选择把这条分享发到 QQ（在话里写 [qq]）或者发到 B 站私信（写 [dm]）；不写就默认发 QQ。私信里只放标题和链接就行。'
}
