// lib/pdf.mjs — PDF 文本提取（调容器里的 python3 + pypdf，离线可用）
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'pdf.py')
const MAX_BYTES = 80 * 1024 * 1024

/**
 * @param {string} file 本地绝对路径
 * @param {{maxPages?:number, maxChars?:number, start?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, pages?:number, chars?:number, scanned?:boolean, text?:string, error?:string}>}
 */
export function pdfExtract(file, opts = {}) {
  const maxPages = Math.max(1, Math.min(400, Number(opts.maxPages) || 80))
  const maxChars = Math.max(500, Math.min(30000, Number(opts.maxChars) || 9000))
  const start = Math.max(1, Number(opts.start) || 1)
  const timeout = Math.max(5000, Math.min(120000, Number(opts.timeoutMs) || 45000))
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
    } catch {}
    execFile('python3', [SCRIPT, file, String(maxPages), String(maxChars), String(start)], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err && !stdout) {
        const msg = String((err && err.message) || err)
        const hint = /ENOENT/.test(msg) ? 'python3 不可用' : /timed? ?out|ETIMEDOUT/i.test(msg) ? 'PDF 解析超时' : msg
        return finish({ ok: false, error: String(hint).slice(0, 200) })
      }
      const line = String(stdout || '').trim().split('\n').pop() || ''
      try {
        const j = JSON.parse(line)
        return finish(j)
      } catch (e) {
        return finish({ ok: false, error: '解析结果异常：' + String(stderr || line).slice(0, 160) })
      }
    })
  })
}

/** 把某一页渲染成 PNG（扫描件靠这个「看」） */
export function pdfRenderPage(file, page, out, width = 1000, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('python3', [join(HERE, 'pdf_render.py'), file, String(page), out, String(width)], {
      timeout: Math.max(8000, Math.min(120000, timeoutMs)),
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop() || ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: String((err && err.message) || '渲染失败').slice(0, 160) })
      }
    })
  })
}
