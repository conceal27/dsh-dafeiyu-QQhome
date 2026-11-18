#!/usr/bin/env node
/**
 * scripts/check.mjs — 无依赖自检（归属：xingzhu）
 * ============================================================================
 * 为什么不是 jest/vitest：这个插件要在别人的 DSH 里 `dsh plugin add` 装，
 * 安装时不该拉一堆 devDependencies。所以自检只用 node 内置能力：
 *
 *   1. 语法：对所有入口和 lib/*.mjs 跑 node --check（等价于「能不能加载」）；
 *   2. 结构：package.json 里 files 列的每个路径都必须真实存在；
 *   3. 导入：把纯逻辑模块真 import 一遍，确保没有拼错的具名导出；
 *   4. 契约：cordis.patch.yml 里的插件 id/name 必须和 package.json 对得上。
 *
 * 用法：node scripts/check.mjs
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
let failed = 0

function fail(msg) {
  failed += 1
  console.error('  ✗ ' + msg)
}
function pass(msg) {
  console.log('  ✓ ' + msg)
}

console.log('[1/4] 语法检查')
const entries = ['index.js', 'client.js']
const libDir = join(ROOT, 'lib')
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const files = [...entries.map((f) => join(ROOT, f)).filter(existsSync), ...walk(libDir)]
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    fail(f.replace(ROOT + '/', '') + ' 语法错误：' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' '))
  }
}
if (!failed) pass(files.length + ' 个文件语法正常')

console.log('[2/4] files 白名单')
for (const f of pkg.files || []) {
  // package.json 的 files 允许通配（locale/*.json），只检查不带通配的那部分
  if (f.includes('*')) continue
  if (existsSync(join(ROOT, f))) pass(f)
  else fail('files 里列了不存在的路径：' + f)
}

console.log('[3/4] 纯逻辑模块导入')
const PURE = [
  'lib/store.mjs',
  'lib/privacy.mjs',
  'lib/persona.mjs',
  'lib/netguard.mjs',
]
for (const rel of PURE) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) { fail(rel + ' 不存在'); continue }
  try {
    await import(pathToFileURL(abs).href)
    pass(rel)
  } catch (e) {
    fail(rel + ' 导入失败：' + String(e.message).split('\n')[0])
  }
}

console.log('[4/4] cordis.patch.yml 与 package.json 一致性')
const patchPath = join(ROOT, 'cordis.patch.yml')
if (!existsSync(patchPath)) fail('cordis.patch.yml 缺失')
else {
  const yml = readFileSync(patchPath, 'utf8')
  if (!yml.includes(pkg.name)) fail('cordis.patch.yml 里没有包名 ' + pkg.name)
  else pass('插件名一致：' + pkg.name)
  const idMatch = yml.match(/-\s*id:\s*([A-Za-z0-9_-]+)/)
  if (!idMatch) fail('cordis.patch.yml 里没有 id')
  else pass('插件 id：' + idMatch[1])
}

if (failed) {
  console.error('\n[check] 失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('\n[check] 全部通过')
