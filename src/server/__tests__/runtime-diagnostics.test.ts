import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordRuntimeDiagnostic, recentRuntimeDiagnostics, drainRuntimeDiagnostics } from '../../utils/runtime-diagnostics.js'
import { buildHealthRoute } from '../health-route.js'
import type { RuntimeSessionManager } from '../session-manager.js'

test('bounded diagnostic projection reaches authenticated health without raw tool arguments', async () => {
  for (let i = 0; i < 210; i++) recordRuntimeDiagnostic({ kind: 'delivery_stage', phase: 'commit:await', correlationId: 'call-' + i,
    elapsedMs: i, ...{ command: 'must never appear', message: 'must never appear' } })
  const recent = recentRuntimeDiagnostics()
  assert.equal(recent.length, 20)
  assert.equal(recent.at(-1)?.correlationId, 'call-209')
  const manager = { stats: () => ({ sessionCount: 1, runningCount: 1 }), getStorageHealth: () => undefined } as unknown as RuntimeSessionManager
  const routes = buildHealthRoute(manager, Date.now(), 'fixture', 'fixture')
  const response = await routes['GET /health']!({}, {}, { authorization: 'Bearer fixture' })
  assert.deepEqual((response.body as Record<string, unknown>).recentDiagnostics, recent)
  assert.ok(!JSON.stringify(response.body).includes('must never appear'))
  const anonymous = await routes['GET /health']!({}, {}, {})
  assert.deepEqual(anonymous.body, { ok: true })
  await drainRuntimeDiagnostics()
})
