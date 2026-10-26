import { before, after, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { memoryFormationEnabled, resolveMemoryFormation } from '../../memory/formation-policy.js'
import { agentSchema } from '../../config/schema.js'

const auth = { authorization: 'Bearer memory-fixture' }
const previous = { home: process.env.RIVET_HOME, capture: process.env.RIVET_MEMORY_AUTO_CAPTURE, consolidation: process.env.RIVET_MEMORY_CONSOLIDATION }
let home: string, router: ReturnType<typeof createRouter>
before(() => { home = mkdtempSync(join(tmpdir(), 'rivet-memory-config-')); process.env.RIVET_HOME = home; router = createRouter(buildConfigRoutes('memory-fixture')) })
beforeEach(() => {
  delete process.env.RIVET_MEMORY_AUTO_CAPTURE; delete process.env.RIVET_MEMORY_CONSOLIDATION
  writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: { default: 'deepseek', providers: {} }, agent: { dreamEnabled: false } }))
})
after(() => {
  for (const [name, value] of [['RIVET_HOME', previous.home], ['RIVET_MEMORY_AUTO_CAPTURE', previous.capture], ['RIVET_MEMORY_CONSOLIDATION', previous.consolidation]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it('old configurations default to both features disabled', async () => {
  assert.deepEqual(agentSchema.parse({}).memoryFormation, { autoCapture: false, consolidation: false })
  const res = await router('GET', '/config/memory-formation', {}, auth)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { configured: { autoCapture: false, consolidation: false }, effective: { autoCapture: false, consolidation: false }, overrides: { autoCapture: null, consolidation: null }, effectiveAfter: 'new-session' })
})

it('partial updates preserve the other feature and existing agent settings', async () => {
  for (const patch of [{ autoCapture: true }, { consolidation: true }, { autoCapture: false }]) {
    const res = await router('PUT', '/config/memory-formation', patch, auth)
    assert.equal(res.status, 200)
  }
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  assert.deepEqual(saved.agent.memoryFormation, { autoCapture: false, consolidation: true })
  assert.equal(saved.agent.dreamEnabled, false)
  const back = await router('GET', '/config/memory-formation', {}, auth)
  assert.deepEqual((back.body as any).effective, saved.agent.memoryFormation)
})

it('environment overrides are reported independently from saved preferences', async () => {
  process.env.RIVET_MEMORY_AUTO_CAPTURE = 'off'
  process.env.RIVET_MEMORY_CONSOLIDATION = 'on'
  const res = await router('PUT', '/config/memory-formation', { autoCapture: true, consolidation: false }, auth)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, configured: { autoCapture: true, consolidation: false }, effective: { autoCapture: false, consolidation: true }, overrides: { autoCapture: false, consolidation: true }, effectiveAfter: 'new-session' })
})

it('invalid updates and unauthorized reads/writes cannot change persisted data', async () => {
  const original = readFileSync(join(home, 'config.json'), 'utf8')
  for (const bad of [{}, { autoCapture: 1 }, { consolidation: 'true' }, { unknown: true }, { toString: true }, [], null]) {
    const res = await router('PUT', '/config/memory-formation', bad, auth)
    assert.equal(res.status, 400)
  }
  assert.equal((await router('GET', '/config/memory-formation', {}, {})).status, 401)
  assert.equal((await router('PUT', '/config/memory-formation', { autoCapture: true }, {})).status, 401)
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), original)
})

it('configuration storage failure is returned as a failure', async () => {
  const file = join(home, 'config.json')
  rmSync(file); mkdirSync(file)
  try { assert.equal((await router('PUT', '/config/memory-formation', { autoCapture: true }, auth)).status, 500) }
  finally { rmSync(file, { recursive: true, force: true }) }
})

it('only explicit opt-ins enable memory; empty values fall back to config', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(memoryFormationEnabled(value), false)
    assert.equal(memoryFormationEnabled(value, true), true)
  }
  for (const value of ['1', 'on', 'true', ' ON ']) assert.equal(memoryFormationEnabled(value), true)
  for (const value of ['0', 'off', 'false', 'yes', 'unknown']) assert.equal(memoryFormationEnabled(value, true), false)
  assert.deepEqual(resolveMemoryFormation({ autoCapture: true, consolidation: true }, { RIVET_MEMORY_AUTO_CAPTURE: 'unknown' }), { autoCapture: false, consolidation: true })
})
