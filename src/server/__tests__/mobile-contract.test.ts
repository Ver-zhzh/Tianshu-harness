import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_VERSION, DATA_FORMAT_VERSION, MOBILE_FEATURES, RUNTIME_CAPABILITIES } from '../protocol.js'
import { createHealthSnapshot } from '../health-route.js'

test('mobile contract is additive to the existing sidecar protocol', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(DATA_FORMAT_VERSION, 1)
  assert.equal(RUNTIME_CAPABILITIES.requestLookup, true)
  assert.equal(RUNTIME_CAPABILITIES.schedulePatch, true)
  assert.equal(new Set(MOBILE_FEATURES).size, MOBILE_FEATURES.length)
  assert.ok(MOBILE_FEATURES.length > 0)
  assert.deepEqual(Object.keys(RUNTIME_CAPABILITIES.mobileFeatures ?? {}).sort(), [...MOBILE_FEATURES].sort())
  for (const feature of MOBILE_FEATURES) assert.equal(RUNTIME_CAPABILITIES.mobileFeatures?.[feature], true)
})

test('authenticated health snapshots carry the declared contract even in setup mode', () => {
  const manager = {
    stats: () => ({ sessionCount: 0, runningCount: 0 }),
    getStorageHealth: () => ({ failedSessions: 0, pendingEvents: 0 }),
  } as unknown as Parameters<typeof createHealthSnapshot>[0]
  const health = createHealthSnapshot(manager, Date.now(), '3.37.0', () => true, () => false)()
  assert.equal(health.readiness, 'ready')
  assert.equal(health.configured, false)
  assert.equal(health.ok, false)
  assert.equal(health.protocolVersion, PROTOCOL_VERSION)
  assert.equal(health.dataFormatVersion, DATA_FORMAT_VERSION)
  assert.deepEqual(health.capabilities.mobileFeatures, RUNTIME_CAPABILITIES.mobileFeatures)
})
