import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelBinding, ModelBindingUnavailable } from '../../model/model-binding.js'
import { workerFailureResult } from '../coordinator.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

/**
 * 收编公开仓 PR #37：绑定拒绝必须让主会话看见「谁不可用 + 连的是哪个实例」，
 * 同时不得把凭据、网关地址或主体带进 worker 协议（WorkerResult 会进会话记录与 UI）。
 */
test('a binding refusal retains the exact requested identity and config without credential fields', () => {
  const target = { provider: 'custom', model: 'removed', keyId: 'selected', baseUrl: 'https://private:password@gateway.example/v1', credentialPrincipal: 'private-principal' }
  const order = createReadOnlyWorkOrder({ parentTurnId: 'test', objective: 'Inspect the binding failure', kind: 'review', profile: 'verifier', scope: { files: [] } })
  assert.throws(() => resolveModelBinding({}, target), error => {
    assert.ok(error instanceof ModelBindingUnavailable)
    assert.equal(error.message, 'provider_deleted', 'machine-readable reason remains compatible')
    const result = workerFailureResult(order, error)
    assert.equal(result.failureReason, 'binding')
    assert.equal(result.terminalFailure, true)
    for (const value of ['custom', 'removed', 'selected', 'config=', 'pid=']) assert.ok(result.summary.includes(value))
    for (const value of ['password', 'gateway.example', 'private-principal']) assert.equal(result.summary.includes(value), false)
    return true
  })
})
