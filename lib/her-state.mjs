/**
 * lib/her-state.mjs — 她的「当前现场」唯一权威来源
 * ============================================================================
 * 问题：她有四个互不对账的状态来源——
 *   daystream（随机记的打盹/看书）、vitals（生理）、对话历史（上一句自己说的）、
 *   以及当轮即兴（模型现编一个现场）。
 * 结果就是同一分钟里"在窗边等人 / 摆桌子 / 穿鞋 / 刚从被窝爬起来"四个现场。
 *
 * 解法：让她每轮开口前，先在回复里写一行 [state:此刻在干嘛]（内部标记，会从正文删掉）。
 * 这就是"当前现场"的唯一权威：下一轮拿它当事实注入，禁止另编。
 * 没写就沿用上一次的；超过 3 小时或她睡着了，状态自动作废。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'her-state.json'
const STALE_MS = 3 * 60 * 60 * 1000

const pathOf = (home) => join(home, FILE)

export function loadState(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    if (!j || typeof j.text !== 'string') return null
    return { text: j.text, at: Number(j.at) || 0, place: j.place || '' }
  } catch {
    return null
  }
}

export function setState(home, text, now = Date.now(), place = '') {
  try {
    mkdirSync(home, { recursive: true })
    const tmp = pathOf(home) + '.tmp'
    writeFileSync(tmp, JSON.stringify({ text: String(text).slice(0, 120), at: now, place: String(place || '').slice(0, 40) }), 'utf8')
    renameSync(tmp, pathOf(home))
  } catch {}
}

/** 从回复里抠出 [state:...]；返回 { text, state } */
export function extractStateMarker(reply) {
  const raw = String(reply || '')
  const m = /\[state:([^\]]{1,120})\]/u.exec(raw)
  if (!m) return { text: raw, state: '' }
  return {
    text: raw.replace(/\[state:[^\]]{1,120}\]/gu, '').replace(/\n{3,}/g, '\n\n').trim(),
    state: m[1].trim(),
  }
}

/** 注入：她此刻在哪儿、在干嘛。这是事实，不是建议 */
export function statePromptBlock(home, now = Date.now()) {
  const st = loadState(home)
  if (!st || !st.text) return ''
  const age = now - Number(st.at || 0)
  if (age > STALE_MS) return ''
  const mins = Math.round(age / 60000)
  const ago = mins < 1 ? '刚刚' : mins < 60 ? mins + ' 分钟前' : (mins / 60).toFixed(1) + ' 小时前'
  return (
    '【你此刻的现场】' + ago + '你在：' + st.text + (st.place ? '（' + st.place + '）' : '') + '\n' +
    '这是事实，不是可选项：这一轮只要说到"我在干嘛/我在哪"，就顺着它往下说。\n' +
    '除非他来了、你被打断了、你走开了——否则别另编一个不一样的现场。\n' +
    '现场真的变了（你从窗边走到门口了），就在回复里写一行新的 [state:新的现场]，别在正文里解释这个标记。'
  )
}
