import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatModelSwitchFeedback } from '../model-switch-feedback.js'

test('lost mounts survive the actual model-switch feedback formatter', () => {
  assert.match(formatModelSwitchFeedback({ ok: true, changed: true, modelName: 'fixture', warnings: ['galaxy(disabled) 未恢复'] }), /galaxy\(disabled\) 未恢复/)
})
import { DOMAIN_SWITCH_CACHE_WARNING, DOMAIN_SWITCH_CACHE_NOTE } from '../../agent/domain-picker-entries.js'

test('unchanged model confirmation does not imply a new cache generation', () => {
  const text = formatModelSwitchFeedback({ ok: true, changed: false, modelName: 'fixture' })
  assert.match(text, /当前模型保持不变：fixture/)
  assert.doesNotMatch(text, /缓存|切换|重建/)
})

test('a real model switch has a single bounded confirmation with no promised cache miss or fixed cost', () => {
  const text = formatModelSwitchFeedback({ ok: true, changed: true, modelName: 'fixture' }, 'high')
  assert.match(text, /Model → fixture/)
  assert.match(text, /命中率可能变化/)
  assert.match(text, /effort → high/)
  assert.doesNotMatch(text, /整体失效|全量重建|倍/)
  assert.equal(text.split('\n').length, 1)
})

test('domain warnings describe the next user boundary without claiming model replacement or a fixed cost', () => {
  assert.match(DOMAIN_SWITCH_CACHE_WARNING, /下一条用户消息/)
  assert.match(DOMAIN_SWITCH_CACHE_WARNING, /变化位置之后/)
  assert.match(DOMAIN_SWITCH_CACHE_WARNING, /不会因此切换模型/)
  for (const text of [DOMAIN_SWITCH_CACHE_WARNING, DOMAIN_SWITCH_CACHE_NOTE]) {
    assert.doesNotMatch(text, /整体失效|全量重建|10\s*倍/)
  }
})
