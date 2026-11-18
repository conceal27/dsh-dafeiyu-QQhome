// lib/files.mjs — QQ 文件消息 → 落盘 + 提取正文（PDF / 文本），扫描件还会渲染页面给她「看」
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pdfExtract, pdfRenderPage } from './pdf.mjs'
import { epubExtract } from './epub.mjs'

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.ini', '.html', '.htm', '.xml', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.sql', '.java', '.c', '.cpp', '.h'])
const BIG = 80 * 1024 * 1024

function fmtSize(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB'
  if (v >= 1024) return Math.round(v / 1024) + 'KB'
  return v + 'B'
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(-80)
}

async function resolveLocal(seg, bridge) {
  const d = (seg && seg.data) || {}
  const fileId = String(d.file_id || d.fileId || '')
  const fileName = String(d.file || d.name || d.file_name || '')
  const tryCall = async (params) => {
    if (!bridge || typeof bridge.call !== 'function') throw new Error('没有 QQ 桥')
    return bridge.call('get_file', params)
  }
  let got = null
  let lastErr = ''
  for (const params of [
    { file_id: fileId, file: fileName },
    { file_id: fileId },
    { file: fileName },
  ]) {
    if (!params.file_id && !params.file) continue
    try {
      got = await tryCall(params)
      if (got && (got.file || got.url || got.base64)) break
    } catch (e) {
      lastErr = String((e && e.message) || e)
    }
  }
  if (!got) throw new Error(lastErr || '取文件失败')
  const p = String(got.file || got.url || '')
  return { path: p, name: String(got.file_name || fileName || basename(p)).slice(0, 100), size: Number(got.file_size || d.file_size || 0) }
}

/**
 * 把这条消息里的文件收下来并解析。
 * @returns {Promise<{block:string, items:Array}>} items[].pagesShown = [{path, page}]
 */
export async function collectInboundFiles(msg, opts = {}) {
  const { bridge, stateDir, maxFiles = 2, maxPages = 80, maxChars = 3000, renderPages = 2 } = opts
  const segs = (Array.isArray(msg && msg.segments) ? msg.segments : []).filter((s) => s && s.type === 'file')
  if (!segs.length) return { block: '', items: [] }
  const outDir = join(stateDir, 'uploads')
  try { mkdirSync(outDir, { recursive: true }) } catch {}
  const items = []
  for (const seg of segs.slice(0, maxFiles)) {
    const d = seg.data || {}
    const item = { name: String(d.file || d.name || '文件').slice(0, 100), size: Number(d.file_size || 0), kind: 'other', text: '', note: '', pagesShown: [] }
    try {
      const loc = await resolveLocal(seg, bridge)
      item.name = loc.name || item.name
      item.size = loc.size || item.size
      if (!loc.path) throw new Error('没有本地路径')
      if (!existsSync(loc.path)) throw new Error('文件没落到本机：' + loc.path.slice(0, 80))
      const st = statSync(loc.path)
      if (st.size > BIG) throw new Error('文件太大（' + fmtSize(st.size) + '），我先不读')
      const stamp = Date.now().toString(36)
      const dest = join(outDir, stamp + '-' + safeName(item.name))
      try { copyFileSync(loc.path, dest) } catch {}
      const ext = extname(item.name || loc.path).toLowerCase()
      if (ext === '.pdf') {
        item.kind = 'pdf'
        const r = await pdfExtract(dest, { maxPages, maxChars, timeoutMs: 50000 })
        if (!r.ok) throw new Error(r.error || 'PDF 读不了')
        item.pages = r.pages
        item.readPages = r.read_pages
        item.nextPage = r.next_page
        item.scanned = !!r.scanned
        item.truncated = !!r.truncated
        item.text = String(r.text || '')
        item.title = (r.meta && r.meta.title) || ''
        item.path = dest
        if (item.scanned) {
          // 扫描件没有文字层：渲染几页让她直接「看」
          const want = Math.max(0, Math.min(3, Number(renderPages) || 0))
          for (let p = 1; p <= want; p += 1) {
            if (p > item.pages) break
            const png = join(outDir, stamp + '-p' + p + '.png')
            const rr = await pdfRenderPage(dest, p, png, 1000)
            if (rr && rr.ok) item.pagesShown.push({ path: png, page: p })
          }
          item.note = '扫描件（没有文字层），已把第 ' + item.pagesShown.map((x) => x.page).join('、') + ' 页渲染成画面'
        } else if (item.text && item.text.length >= maxChars - 80) {
          item.note = (item.note ? item.note + '；' : '') + '正文只摘了前 ' + maxChars + ' 字，不是全文'
        }
      } else if (ext === '.epub') {
        item.kind = 'epub'
        const er = await epubExtract(dest, { maxChars, maxChaps: 40 })
        if (!er.ok) throw new Error(er.error || 'epub 读不了')
        item.title = String(er.title || '')
        item.chaptersTotal = Number(er.chapters_total || 0)
        item.chaptersRead = Number(er.chapters_read || 0)
        item.truncated = !!er.truncated
        item.text = String(er.text || '')
        item.path = dest
      } else if (TEXT_EXT.has(ext)) {
        item.kind = 'text'
        item.text = readFileSync(dest, 'utf8').slice(0, maxChars)
        item.path = dest
      } else {
        item.kind = 'other'
        item.ext = ext.replace('.', '')
        item.path = dest
      }
    } catch (e) {
      item.error = String((e && e.message) || e).slice(0, 160)
    }
    items.push(item)
  }
  return { block: renderBlock(items), items }
}

function renderBlock(items) {
  if (!items.length) return ''
  const parts = []
  for (const it of items) {
    const head = `【主人发来的文件】${it.name}（${fmtSize(it.size)}）`
    if (it.error) {
      parts.push(`${head}\n我没能打开：${it.error}。跟主人说话时直说没读到，别编内容。`)
      continue
    }
    if (it.kind === 'pdf') {
      const bits = [`共 ${it.pages} 页`]
      if (it.title) bits.push('标题：' + it.title)
      if (it.scanned) {
        let s = `${head}，${bits.join('，')}。这份是扫描件——每一页都是照片，抠不出文字。`
        if (it.pagesShown.length) {
          s += `\n我把第 ${it.pagesShown.map((x) => x.page).join('、')} 页拍成画面附在后面了，你先看清这是什么书、这一页在讲什么。`
          s += `\n然后跟主人说清楚：这本是扫描版，${it.pages} 页，我可以一页一页看，但一次看不了太多，问他要读哪几页/哪一章。`
          s += '\n别假装读过全书，别编后面的内容，也别把封面上的话当成全书结论。'
          s += '\n【硬约束】你手上只有这 ' + it.pagesShown.length + ' 页的画面，其余 ' + Math.max(0, it.pages - it.pagesShown.length) + ' 页你一个字都没看到。主人问这几页以外的内容，必须直说「我只看了开头几页」，不许编，也不许说「我念完了」。'
        } else {
          s += '\n这次没渲染出来，直说没法看。'
        }
        parts.push(s)
        continue
      }
      let s = `${head}，${bits.join('，')}。以下是${it.readPages}页的正文`
      if (it.truncated) s += it.nextPage ? `（只读到第 ${it.nextPage - 1} 页，后面还有）` : '（截断了）'
      s += '：\n' + (it.text || '（空）')
      s += '\n引用原话时按「第几页」标注，别整段照抄，用你自己的话讲。'
      parts.push(s)
    } else if (it.kind === 'epub') {
      const bits = []
      if (it.title) bits.push(it.title)
      if (it.chaptersTotal) bits.push('共 ' + it.chaptersTotal + ' 节')
      let s = head + '，' + bits.join('，') + '。以下是读到的 ' + it.chaptersRead + ' 节正文'
      if (it.truncated) s += '（没读完，后面还有）'
      s += '：\n' + (it.text || '（空）')
      s += '\n【硬约束】没读到的部分你完全不知道，问到就直说没读到，不许编。引用按「第几节」标。'
      parts.push(s)
    } else if (it.kind === 'text') {
      parts.push(`${head}，正文如下：\n${it.text || '（空）'}`)
    } else {
      parts.push(`${head}，这个格式（${it.ext || '未知'}）我现在还解析不了，只能看到文件名和大小；直说读不了，别编。`)
    }
  }
  return '\n\n' + parts.join('\n\n')
}
