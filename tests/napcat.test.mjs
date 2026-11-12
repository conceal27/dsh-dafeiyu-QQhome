/**
 * tests/napcat.test.mjs — NapCat 安装器的纯函数回归（零依赖、不联网）
 * ============================================================================
 * 这几个函数是「装 QQ 桥」这条链上最容易出错的地方，而且错了会很难查：
 *   - resolveDownloadUrl：镜像前缀拼错 → 404，用户只看到「下载失败」；
 *   - validateZipEntryNames：zip slip 没拦住 → 解压时写到 plugins/ 外面；
 *   - pickReleaseAsset：资产名对不上 → 官方包更新一次就装不上。
 * 所以它们必须能在没有 QQ、没有网络的机器上跑。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDownloadUrl,
  validateZipEntryNames,
  pickReleaseAsset,
  NAPCAT_ASSETS,
} from '../lib/napcat.mjs'

test('resolveDownloadUrl: 裸 github 前缀直接拼', () => {
  const url = resolveDownloadUrl({
    mirrorBase: 'https://ghfast.top/https://github.com/',
    tag: 'v4.8.0',
    assetName: 'NapCat.Shell.zip',
  })
  assert.equal(url, 'https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/download/v4.8.0/NapCat.Shell.zip')
})

test('resolveDownloadUrl: ghproxy 风格前缀按 /https://github.com/ 拼', () => {
  const url = resolveDownloadUrl({
    mirrorBase: 'https://ghproxy.net/',
    tag: 'v4.8.0',
    assetName: 'NapCat.Shell.zip',
  })
  assert.equal(url, 'https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/download/v4.8.0/NapCat.Shell.zip')
})

test('resolveDownloadUrl: 缺参数 / 非 http 前缀要报错而不是拼出坏地址', () => {
  assert.throws(() => resolveDownloadUrl({ mirrorBase: '', tag: 'v1', assetName: 'a.zip' }))
  assert.throws(() => resolveDownloadUrl({ mirrorBase: 'ftp://x', tag: 'v1', assetName: 'a.zip' }))
  assert.throws(() => resolveDownloadUrl({ mirrorBase: 'https://github.com', tag: '', assetName: 'a.zip' }))
  assert.throws(() => resolveDownloadUrl({ mirrorBase: 'https://github.com', tag: 'v1', assetName: '' }))
})

test('validateZipEntryNames: 正常条目通过', () => {
  assert.equal(
    validateZipEntryNames(['NapCat.Shell/', 'NapCat.Shell/launcher.bat', 'NapCat.Shell/resources/app.js']),
    true,
  )
  assert.equal(validateZipEntryNames([]), true)
})

test('validateZipEntryNames: 绝对路径 / 盘符 / .. 穿越都要拦住（zip slip）', () => {
  assert.throws(() => validateZipEntryNames(['/etc/passwd']), /绝对路径/)
  assert.throws(() => validateZipEntryNames(['C:\\Windows\\system32\\x.dll']), /盘符/)
  assert.throws(() => validateZipEntryNames(['a/../../b.txt']), /路径穿越/)
  assert.throws(() => validateZipEntryNames(['..\\..\\x']), /路径穿越/)
})

test('pickReleaseAsset: 精确命中优先', () => {
  const assets = [
    { name: 'NapCat.Shell.zip', browser_download_url: 'u1' },
    { name: 'NapCat.Shell.Windows.Node.zip', browser_download_url: 'u2' },
  ]
  assert.equal(pickReleaseAsset(assets, 'NapCat.Shell.zip').name, 'NapCat.Shell.zip')
  assert.equal(pickReleaseAsset(assets, 'napcat.shell.zip').name, 'NapCat.Shell.zip', '资产名大小写不敏感')
})

test('pickReleaseAsset: 想要的没有时退到官方包', () => {
  const assets = [{ name: NAPCAT_ASSETS.shell }, { name: NAPCAT_ASSETS.node }]
  const got = pickReleaseAsset(assets, 'NapCat.Shell.Windows.Node.zip')
  assert.ok(got && got.name, '应回退到某个官方包')
  assert.ok(assets.some((a) => a.name === got.name))
})

test('pickReleaseAsset: 一个都没有时抛错并带上可选项', () => {
  assert.throws(
    () => pickReleaseAsset([{ name: 'other.zip' }], 'NapCat.Shell.zip'),
    /没有|可用/,
  )
  assert.throws(() => pickReleaseAsset(null, 'x.zip'))
})
