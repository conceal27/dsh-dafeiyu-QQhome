#!/usr/bin/env node
/**
 * scripts/scan-secrets.mjs — 发布前安全扫描（归属：xingzhu）
 * ============================================================================
 * 为什么要有这个：这个插件原本是私人装机用的，里面难免会留下真实 QQ 号、
 * 本机绝对路径、内网 IP、token 之类的东西。一旦发布到 npm / GitHub，
 * 那些就变成了别人能直接 grep 到的个人信息，且 git 历史删不干净。
 *
 * 扫描对象：package.json 里 files 白名单列出的所有文件（不看 node_modules）。
 * 命中任何一条规则就 exit 1，并打印「文件:行号」——发布流程里它挡在 publish 前面。
 *
 * 用法：
 *   node scripts/scan-secrets.mjs          # 扫默认白名单
 *   node scripts/scan-secrets.mjs --all    # 连 docs/、tests/ 也扫
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|wav|ogg|mp4|zip|tgz|onnx|bin)$/i

/** 命中即报错的规则。每条都写清「为什么」。 */
const RULES = [
  {
    id: 'qq-number',
    // 5~12 位纯数字 QQ。会误报，所以只看「看起来像 QQ 的位置」：ownerQq/uin/QQ 附近
    re: /(?:ownerQq|selfQq|accessAdminId|ownerBiliMid|uin)['"]?\s*[:=]\s*['"]?(\d{5,12})/g,
    why: '配置里写死了真实 QQ / B 站 mid',
  },
  {
    id: 'private-path',
    re: /(?:\/home\/[a-z0-9_-]+|\/root\/|\/opt\/[a-z0-9_-]+|[A-Z]:\\\\?(?:Users|dsh)-?[a-z0-9_-]*\\\\)/g,
    why: '写死了某台机器的绝对路径（应该走 DSH_HOME / homedir()）',
  },
  {
    id: 'lan-ip',
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
    why: '内网 IP 只对某台机器有意义',
  },
  {
    id: 'api-key',
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ark-[a-z0-9-]{12,}|ghp_[A-Za-z0-9]{20,}|brz_[A-Za-z0-9]{12,})\b/g,
    why: '疑似明文 API Key / Token',
  },
  {
    id: 'npmless-token',
    re: /(?:token|password|passwd|secret)['"]?\s*[:=]\s*['"]([A-Za-z0-9_\-+=/]{20,})['"]/g,
    why: '疑似明文 token / 口令',
  },
  {
    id: 'cookie',
    re: /(?:SESSDATA|bili_jct|DedeUserID)['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]/g,
    why: '写死了 B 站登录 cookie',
  },
]

/**
 * 按文件豁免某一条规则（只豁免这一条，别的规则照扫）。
 * tests/ 里的号码全是编造的测试夹具（10001、999888777…），
 * 它们必须长得像 QQ 号才能测出「脱敏函数有没有生效」，所以放过。
 */
const FILE_RULE_ALLOW = [{ file: /^tests\/.*\.(test\.)?mjs$/, rule: 'qq-number' }]

/** 允许的例外：文档里的占位符 / 示例值。命中这些不报。 */
const ALLOW = [
  /10001\/abc123/,          // qzone 提示词里的示例 uin
  /192\.168\.1\.1\/admin/,  // netguard 注释里的 SSRF 示例
  /<你的用户名>/, /<user>/, /<你>/,
  /example\.com/,
  /127\.0\.0\.1/,
  /"123456"/,               // docs/api-contract.md 里的接口示例号
  /"12\*{4}78"/, /12345678/, // 同上：打码号与示例 id
]

function walk(dir, out = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out)
    } else if (e.isFile() && !SKIP_EXT.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const targets = walk(ROOT)
const hits = []
for (const file of targets) {
  const rel = relative(ROOT, file)
  if (rel.startsWith('scripts/')) continue // 本文件自己是规则表，跳过
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  if (text.length > 2_000_000) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line)) !== null) {
        const chunk = m[0]
        if (ALLOW.some((a) => a.test(chunk) || a.test(line))) continue
        if (FILE_RULE_ALLOW.some((r) => r.rule === rule.id && r.file.test(rel))) continue
        hits.push({ file: rel, line: i + 1, rule: rule.id, why: rule.why, text: chunk.slice(0, 80) })
      }
    }
  }
}

if (!hits.length) {
  console.log('[scan-secrets] 干净：' + targets.length + ' 个文件，0 命中')
  process.exit(0)
}

console.error('[scan-secrets] 发现 ' + hits.length + ' 处疑似敏感内容：\n')
for (const h of hits) {
  console.error('  ' + h.file + ':' + h.line + '  [' + h.rule + '] ' + h.why)
  console.error('      ' + h.text)
}
console.error('\n发布前必须清掉（或加进 ALLOW 并写清理由）。')
process.exit(1)
