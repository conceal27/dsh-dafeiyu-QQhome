/**
 * lib/audio-analyze.mjs — 让她「听」音频（dsh-soundcheck 引擎）
 * ============================================================================
 * 用户发来一首歌/一段音频时，用本地分析引擎拿到客观数据（BPM、调性、响度、
 * 能量、标签、有没有人声），再给她的回复做参考。
 * 轻量模式：--preview，串行执行；可用内存不足时直接跳过，避免把 DSH 挤崩。
 * 引擎位置：~/soundcheck/src/engine（analyze.py + 模型），可用 FISH_AUDIO_ENGINE_DIR 覆盖
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENGINE_DIR = process.env.FISH_AUDIO_ENGINE_DIR || join(homedir(), 'soundcheck', 'src', 'engine')
const PYTHON = 'python3'
const MIN_AVAILABLE_MB = 500
const DEFAULT_TIMEOUT = 150000

function memAvailableMB() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/)
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

let chain = Promise.resolve()
function serial(task) {
  const run = chain.then(task, task)
  chain = run.catch(() => {})
  return run
}

export function analyzeAudioFile(filePath, { preview = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  // 整首分析峰值约 1.4GB，轻量预览约 1.1GB；内存不够就直接放弃，别把 DSH 挤崩
  const need = preview ? MIN_AVAILABLE_MB : 900
  const avail = memAvailableMB()
  if (avail < need) {
    return Promise.resolve({ ok: false, error: `内存不足（可用 ${avail}MB，需要 >${need}MB）` })
  }
  return serial(() => new Promise((resolve) => {
    const args = ['analyze.py', filePath, '--json', '--brief']
    if (preview) args.push('--preview')
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      resolve(r)
    }
    let child
    try {
      child = spawn(PYTHON, args, { cwd: ENGINE_DIR })
    } catch (e) {
      return finish({ ok: false, error: String((e && e.message) || e) })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, error: '分析超时' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: String((e && e.message) || e) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return finish({ ok: false, error: `分析失败(${code}) ${err.slice(0, 120)}` })
      try {
        const line = out.trim().split('\n').filter(Boolean).pop()
        const data = JSON.parse(line)
        finish({ ok: true, data })
      } catch {
        finish({ ok: false, error: '分析输出不是 JSON' })
      }
    })
  }))
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 把分析结果压成一句人话，给她的回复当参考 */
export function audioSummary(d) {
  if (!d || typeof d !== 'object') return ''
  const bits = []
  const dur = num(d.dur)
  if (dur) bits.push(`时长约 ${Math.round(dur)} 秒`)
  const bpm = num(d.bpm)
  if (bpm) bits.push(`速度约 ${bpm} 拍`)
  const key = d.key && d.key.best
  if (key) bits.push(`调性 ${key}`)
  const loud = d.loud || {}
  if (num(loud.rms) != null) bits.push(`响度 ${loud.rms} dB`)
  const en = d.energy || {}
  if (num(en.min) != null && num(en.max) != null) bits.push(`能量 ${en.min}~${en.max} dB`)
  const src = Array.isArray(d.src) ? d.src.filter(Boolean).slice(0, 4) : []
  if (src.length) bits.push('听起来像：' + src.join('、'))
  return bits.join('，')
}
