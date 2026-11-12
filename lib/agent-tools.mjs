// 她的工具层（C 档）：只读 + 读写家目录 + 受限命令 + 网页抓取。
// 安全优先级最高：只认主人私聊、命令白名单、禁止 shell 元字符、路径锁在家目录、超时/截断、全量审计。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process'
import { pdfExtract } from './pdf.mjs'
import { searchBooks, readEpubUrl, wikisourceText, takeSearchErrors } from './books.mjs';

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.dsh', 'qq-fish');
const AUDIT = path.join(STATE_DIR, 'tool-audit.jsonl');
const MAX_OUTPUT = 3000;
/** 截断时明确告诉她「这是截断的」，否则她会拿半个列表去数数（会把 61 数成 38） */
function clip(s) {
  const t = String(s || '');
  if (t.length <= MAX_OUTPUT) return t;
  return t.slice(0, MAX_OUTPUT) + '\n…（输出太长被截断：完整 ' + t.length + ' 字符，只显示了前 ' + MAX_OUTPUT + '。要看全的请缩小范围，比如指定具体文件）';
}
const TIMEOUT_MS = 10_000;

// 只允许这些命令（不带参数时安全）
const SAFE_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'du', 'df', 'date', 'pwd', 'echo', 'ps', 'free', 'uptime', 'whoami', 'uname']);
// shell 元字符：一律拒绝（不经过 shell，但防参数注入）
const BAD_CHARS = /[;&|<>`$(){}\\\n\r]/;
// 内网/本地地址：禁止（防 SSRF）
const BAD_URL = /(^|\/\/)(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.)/i;

/** 审计日志（一行一条 JSON） */
export function audit(tool, arg, ok, note = '') {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), tool, arg: String(arg || '').slice(0, 200), ok: !!ok, note: String(note || '').slice(0, 200) }) + '\n';
    fs.appendFileSync(AUDIT, line);
    // 控制体积：超过 500 行截断
    const st = fs.statSync(AUDIT);
    if (st.size > 256 * 1024) {
      const lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).slice(-300);
      fs.writeFileSync(AUDIT, lines.join('\n') + '\n');
    }
  } catch {}
}

function within(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

function normalizePath(p) {
  let s = String(p || '').trim();
  if (!s) s = '.';
  if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  if (!path.isAbsolute(s)) s = path.join(STATE_DIR, s);
  return path.resolve(s);
}

// 【领地】她可以在容器里自由行动，只拦「会动系统底子」的命令（这些交给主人）
const DENY_CMDS = new Set(['mkfs', 'mkfs.ext4', 'mkfs.ext2', 'mkfs.vfat', 'dd', 'shutdown', 'reboot', 'halt', 'poweroff',
  'passwd', 'chpasswd', 'useradd', 'userdel', 'usermod', 'chown', 'chmod', 'sudo', 'su',
  'modprobe', 'insmod', 'rmmod', 'iptables', 'ip6tables', 'nft', 'mount', 'umount',
  'fdisk', 'parted', 'mkswap', 'swapon', 'swapoff', 'init', 'systemctl', 'service', 'crontab']);
// 不许把自己的家和代码删了（那是她的命，误删就没法活了）
const PROTECT_DIRS = /rm\s+[^\n]*?(~\/|\.dsh|qqfish-custom)/;

function runShell(cmdLine) {
  const line = String(cmdLine || '').trim();
  if (!line) return Promise.resolve({ ok: false, error: '空命令' });
  const first = (line.split(/\s+/)[0] || '').split('/').pop();
  if (DENY_CMDS.has(first)) {
    return Promise.resolve({ ok: false, error: `命令不允许：${first}（会动系统底子，这个留给主人）` });
  }
  if (first === 'rm' && PROTECT_DIRS.test(line)) {
    return Promise.resolve({ ok: false, error: '不能删自己的家和代码目录（~/.dsh、qqfish-custom）' });
  }
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-lc', line], { timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, cwd: HOME }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 300), output: String(stdout || '').slice(0, MAX_OUTPUT) });
      resolve({ ok: true, output: String(stdout || '').slice(0, MAX_OUTPUT) || (String(stderr || '').slice(0, 500) || '(无输出)') });
    });
  })
}

function readFileSafe(p) {
  const f = normalizePath(p);
  if (!within(HOME, f)) return { ok: false, error: '只能读家目录里的文件' };
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (/\.pdf$/i.test(f)) return { ok: false, error: 'PDF 请用 [pdf:路径]（[read:] 只会读到乱码）' };
    if (st.size > 512 * 1024) return { ok: false, error: '文件太大（>512KB）' };
    return { ok: true, output: clip(fs.readFileSync(f, 'utf8')) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function writeFileSafe(p, content) {
  const f = normalizePath(p);
  if (!within(path.join(HOME, '.dsh'), f)) return { ok: false, error: '只能写 ~/.dsh 下的文件' };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(content || '').slice(0, 100_000));
    return { ok: true, output: '已写入 ' + f.replace(HOME, '~') + '（' + String(content || '').length + ' 字）' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function fetchUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只支持 http(s) 链接' };
  if (BAD_URL.test(u)) return { ok: false, error: '不允许访问内网/本地地址' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131' } });
    const t = await r.text();
    return { ok: true, output: ('HTTP ' + r.status + '\n' + t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_OUTPUT) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一次工具调用。
 * @param {{tool:string, arg:string}} call
 * @param {{owner: boolean, rate?: {count:number, since:number}|null}} guard 主人校验 + 频率限制
 */
export async function runTool(call, guard = {}) {
  const tool = String(call && call.tool || '').toLowerCase();
  const arg = String(call && call.arg || '').trim();
  if (!guard.owner) {
    audit(tool, arg, false, '非主人');
    return { ok: false, error: '这个能力只对主人开放' };
  }
  const rate = guard.rate;
  if (rate) {
    if (!rate.since || Date.now() - rate.since > 60_000) { rate.since = Date.now(); rate.count = 0; }
    if (rate.count >= 6) {
      audit(tool, arg, false, '频率限制');
      return { ok: false, error: '一分钟内工具最多 6 次，先缓缓' };
    }
    rate.count += 1;
  }
  let r;
  switch (tool) {
    case 'bash':
    case 'run':
      r = await runShell(arg);
      break;
    case 'read':
    case 'cat':
      r = readFileSafe(arg);
      break;
    case 'write':
    case 'save': {
      const idx = arg.indexOf('|');
      if (idx < 0) r = { ok: false, error: '格式：路径|内容' };
      else r = writeFileSafe(arg.slice(0, idx).trim(), arg.slice(idx + 1));
      break;
    }
    case 'pdf': {
      const f = normalizePath(arg);
      if (!within(HOME, f)) { r = { ok: false, error: '只能读家目录里的文件' }; break; }
      const x = await pdfExtract(f, { maxPages: 40, maxChars: 6000, timeoutMs: 45000 });
      if (!x || !x.ok) r = { ok: false, error: (x && x.error) || 'PDF 读不了' };
      else if (x.scanned) r = { ok: true, output: '这份 PDF 是扫描件（' + x.pages + ' 页，每页是图片，没有文字层），我只能看到页数，读不到字。' };
      else r = { ok: true, output: ('共 ' + x.pages + ' 页，读到 ' + x.read_pages + ' 页：\n' + x.text).slice(0, MAX_OUTPUT) };
      break;
    }
    case 'book': {
      const rawArg = arg
      const wantRead = /\|\s*读\s*$/.test(rawArg)
      const q = String(rawArg).replace(/\|\s*读\s*$/, '').trim()
      if (!q) { r = { ok: false, error: '要搜什么书？' }; break }
      const list = await searchBooks(q)
      if (!list.length) {
        const errs = takeSearchErrors()
        r = {
          ok: false,
          error: errs.length
            ? '没搜到「' + q + '」，而且网络也掉链子了：' + errs.slice(0, 2).join('；')
            : '没搜到「' + q + '」——公版库里确实没有这本（中文能搜的是古腾堡那 440 多本公版书，比如红楼梦/西游记/论语/诗经）',
        }
        break
      }
      if (!wantRead) {
        r = { ok: true, output: '搜到这些（想读全文就写 [book:书名|读]）：\n' + list.slice(0, 4).map((b, i) => (i + 1) + '. [' + b.source + '] ' + b.title + (b.author ? ' — ' + b.author : '')).join('\n') }
        break
      }
      const t0 = list[0]
      if (t0.epub) {
        const rd = await readEpubUrl(t0.epub, STATE_DIR, 6000)
        r = rd.ok ? { ok: true, output: '《' + t0.title + '》' + (t0.author ? ' — ' + t0.author : '') + '\n' + rd.text } : { ok: false, error: rd.error }
      } else if (t0.page) {
        const wt = await wikisourceText(t0.title, 4000)
        r = wt.ok ? { ok: true, output: '《' + t0.title + '》（维基文库）\n' + wt.text } : { ok: false, error: wt.error }
      } else {
        r = { ok: false, error: '这本没有可直接读的全文' }
      }
      break
    }
    case 'web':
    case 'fetch':
      r = await fetchUrl(arg);
      break;
    default:
      r = { ok: false, error: '未知工具：' + tool };
  }
  audit(tool, arg, r.ok, r.ok ? String(r.output || '').slice(0, 80) : r.error);
  return r;
}

/** 从她的一段回复里解析出工具调用（最多 3 个） */
export function parseToolCalls(text) {
  const out = [];
  const re = /\[(bash|run|read|cat|write|save|web|fetch|pdf|book)\s*[:：]\s*([^\]\n]{1,800})\]/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.push({ tool: m[1].toLowerCase(), arg: m[2].trim() });
    if (out.length >= 3) break;
  }
  return out;
}

/** 把工具调用从回复正文里剥掉（给最终展示用） */
export function stripToolCalls(text) {
  return String(text || '').replace(/\[(bash|run|read|cat|write|save|web|fetch|pdf|book)\s*[:：]\s*[^\]\n]{1,800}\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
