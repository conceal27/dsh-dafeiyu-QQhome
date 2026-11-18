/**
 * lib/bili/reply-loop.mjs — 有人回她的 B 站评论，她要接着回（楼中楼）
 * ============================================================================
 * 以前只做了「查一次有没有人回 + 记一句记忆」，查完就完了，人再回她她也不知道。
 * 这里做成对话：把她评论下别人（默认只认主人）的每条新回复都接上，
 * 用 root/parent 发楼中楼，记录已经回过哪些 rpid，不重复回。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateText } from '../llm.mjs'
import { cleanReply, parseSkip, systemPrompt } from '../persona.mjs'
import { getCommentReplies, loadAuth } from './client.mjs'
import { postReply } from './comment.mjs'

function stateHome(home) { return path.join(home || os.homedir(), '.dsh', 'qq-fish') }
function commentLogPath(home) { return path.join(stateHome(home), 'comment-log.json') }

function readLog(home) {
  try { return JSON.parse(fs.readFileSync(commentLogPath(home), 'utf8')) } catch { return { items: [] } }
}
function writeLog(home, data) {
  try { fs.writeFileSync(commentLogPath(home), JSON.stringify(data)) } catch {}
}

function timeText(date = new Date()) {
  const h = date.getHours()
  const emoji = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  return `${emoji} ${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function replyPrompt({ video, mine, theirs, history = [] }, t) {
  return [
    `现在是 ${t}。你在 B 站评论区跟人聊天（不是 QQ）。`,
    video ? '视频：《' + String(video).slice(0, 40) + '》' : '',
    '你之前的评论：「' + String(mine || '').slice(0, 120) + '」',
    history.length ? '前面几轮：\n' + history.slice(-6).join('\n') : '',
    '对方回你：「' + String(theirs || '').slice(0, 160) + '」',
    '就着他这句回一句。要求：',
    '· 40 字以内，口语，像评论区随口接话',
    '· 别提「主人」「QQ」，不要写 @ 谁',
    '· 纯文字，不要表情包/图片标记，不要引号包住整句',
    '· 不想接就只输出 [skip]',
  ].filter(Boolean).join('\n')
}

/**
 * 检查她评论下的新回复并回一条。
 * @returns {Promise<{ok:boolean, replied?:boolean, count?:number, skipped?:boolean, text?:string, error?:string}>}
 */
export async function runReplyLoop(ctx, config, log, { dry = false, home = os.homedir() } = {}) {
  if (config.biliCommentReplyEnabled === false) return { ok: true, skipped: true, reason: '关掉了评论回复' }
  const ownerMid = String(config.ownerBiliMid || '').trim()
  const acc = loadAuth(home)
  if (!acc || !acc.cookie) return { ok: false, error: 'B 站未登录' }
  const data = readLog(home)
  const items = (data.items || []).filter((x) => x && x.aid && x.rpid).slice(-10)
  if (!items.length) return { ok: true, skipped: true, reason: '还没评论过' }

  const maxPerTick = Math.max(1, Math.min(5, Number(config.biliCommentReplyMaxPerTick) || 2))
  let done = 0
  let lastText = ''
  for (const it of items) {
    if (done >= maxPerTick) break
    if (it.replyOff) continue
    let reps = []
    try { reps = await getCommentReplies(acc, it.aid, it.rpid, 20) } catch { continue }
    const answered = new Set((it.answered || []).map(String))
    // 只回主人（没配主人 UID 时回任何非自己的人）
    const fromOwner = reps.filter((r) => (ownerMid ? String(r.mid) === ownerMid : true) && !answered.has(String(r.rpid)))
    if (!fromOwner.length) continue
    const target = fromOwner[fromOwner.length - 1]
    const mineSelf = reps.filter((r) => answered.has(String(r.rpid))).map((r) => '你：' + String(r.text).slice(0, 60))
    const theirsPrev = reps.filter((r) => !answered.has(String(r.rpid)) && String(r.rpid) !== String(target.rpid) && String(r.mid) === (ownerMid || r.mid))
      .map((r) => String(r.user || '对方') + '：' + String(r.text).slice(0, 60))
    const prompt = replyPrompt({
      video: it.videoTitle || it.title || it.bvid,
      mine: it.text,
      theirs: target.text,
      history: [...theirsPrev, ...mineSelf],
    })
    const system = systemPrompt(config, { channel: 'push', personaOverride: String(config.personaOwner || '').trim() })
    const result = await generateText(ctx, {
      system,
      messages: [{ role: 'user', text: prompt }],
      config,
      timeoutMs: 45_000,
      log,
    })
    if (!result.ok) return { ok: false, error: `${result.reason}: ${result.message}` }
    const text = cleanReply(parseSkip(result.text), 150)
    if (!text) {
      it.answered = [...(it.answered || []), String(target.rpid)]
      writeLog(home, data)
      continue
    }
    if (dry) return { ok: true, dry: true, text, target: target.text, video: it.videoTitle || it.bvid }
    const r = await postReply(home, it.aid, it.rpid, target.rpid, text)
    if (!r.ok) return { ok: false, error: r.error || '回复失败', text }
    it.answered = [...(it.answered || []), String(target.rpid)]
    it.lastReplyAt = Date.now()
    writeLog(home, data)
    done += 1
    lastText = text
    if (log && log.info) log.info('[B站] 回了评论区的 ' + String(target.user || '') + '：' + text.slice(0, 40))
  }
  return { ok: true, replied: done > 0, count: done, text: lastText }
}
