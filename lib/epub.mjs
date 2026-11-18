// lib/epub.mjs — EPUB 正文提取（调容器里的 python3，标准库实现，无需第三方包）
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * @param {string} file 本地路径
 * @param {{maxChars?:number, maxChaps?:number, timeoutMs?:number}} [opts]
 */
export function epubExtract(file, opts = {}) {
  const maxChars = Math.max(500, Math.min(30000, Number(opts.maxChars) || 9000))
  const maxChaps = Math.max(1, Math.min(300, Number(opts.maxChaps) || 40))
  return new Promise((resolve) => {
    execFile('python3', [join(HERE, 'epub.py'), file, String(maxChars), String(maxChaps)], {
      timeout: Math.max(8000, Math.min(90000, Number(opts.timeoutMs) || 40000)),
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop() || ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: String((err && err.message) || 'epub 解析失败').slice(0, 160) })
      }
    })
  })
}
