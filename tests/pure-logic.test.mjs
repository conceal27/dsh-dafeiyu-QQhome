/**
 * tests/pure-logic.test.mjs — 纯逻辑回归（node 内置 test runner，零依赖）
 * 跑法：npm test
 *
 * 只测「不需要 DSH 运行时、不需要网络、不需要 QQ」的函数，
 * 这样任何人在 clone 之后都能立刻验证插件没坏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { privateNumbers } from '../lib/privacy.mjs'
import { clampSetting, DEFAULT_CONFIG } from '../lib/store.mjs'

test('privacy: 把配置里的私有号码都收进脱敏集合', () => {
  const set = privateNumbers({
    ownerQq: '10001',
    accessAdminId: '10002',
    accessAdminIds: '10003,10004',
    ownerBiliMid: '999888777',
    selfQq: '10005',
    account: { uin: '10****05' },
  })
  for (const n of ['10001', '10002', '10003', '10004', '999888777', '10005']) {
    assert.ok(set.includes(n), '应该包含 ' + n)
  }
  // 打码号（带 *）不该被当成真实号码
  assert.ok(!set.includes('10****05'))
})

test('privacy: 空配置不炸，也不产生伪号码', () => {
  const set = privateNumbers(DEFAULT_CONFIG)
  assert.deepEqual(set, [])
})

test('store: clampSetting 对身份类字段做清洗', () => {
  assert.equal(clampSetting('selfQq', ' 100-01x '), '10001')
  assert.equal(clampSetting('selfBiliName', '<b>小鱼</b>\n'), 'b小鱼/b')
  assert.ok(String(clampSetting('selfBiliName', 'x'.repeat(100))).length <= 40)
})

test('store: 未知键原样透传（不静默丢弃）', () => {
  assert.equal(clampSetting('someNewKey', 42), 42)
})

test('store: DEFAULT_CONFIG 里没有真实个人信息', () => {
  for (const k of ['ownerQq', 'ownerBiliMid', 'ownerBiliName', 'accessAdminId', 'accessAdminIds', 'selfQq', 'selfBiliName']) {
    assert.ok(k in DEFAULT_CONFIG, 'DEFAULT_CONFIG 缺键 ' + k)
    assert.equal(String(DEFAULT_CONFIG[k]), '', k + ' 默认值应为空')
  }
})
