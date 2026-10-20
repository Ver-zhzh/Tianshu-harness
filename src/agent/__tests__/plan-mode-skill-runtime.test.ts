import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanMode, PLAN_MODE_ALLOWED_TOOLS } from '../plan-mode.js'

describe('plan-mode × skill_runtime — action 感知门（issue #523）', () => {
  it('skill_runtime 在白名单内（doctor 放行），prepare/run 被拒', () => {
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('skill_runtime'))
    assert.equal(checkPlanMode('planning', 'skill_runtime', { toolInput: { action: 'doctor', name: 'x' } }).allowed, true)
    for (const action of ['prepare', 'run']) {
      const result = checkPlanMode('planning', 'skill_runtime', { toolInput: { action, name: 'x' } })
      assert.equal(result.allowed, false, action)
      assert.match(result.reason!, /Plan Mode/)
      assert.match(result.reason!, /doctor/)
    }
  })

  it('action 缺失按最严处理（拒绝）；state=off 全放行', () => {
    assert.equal(checkPlanMode('planning', 'skill_runtime', { toolInput: { name: 'x' } }).allowed, false)
    assert.equal(checkPlanMode('planning', 'skill_runtime').allowed, false, '无 toolInput 也拒（缺 action 不可证 doctor）')
    assert.equal(checkPlanMode('off', 'skill_runtime', { toolInput: { action: 'run' } }).allowed, true)
  })

  it('既有语义不变：run_tests 仍放行、bash 仍拒', () => {
    assert.equal(checkPlanMode('planning', 'run_tests').allowed, true)
    assert.equal(checkPlanMode('planning', 'bash').allowed, false)
  })
})
