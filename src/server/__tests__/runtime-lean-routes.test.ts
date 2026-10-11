import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfigRoutes } from '../config-routes.js'
import { createRouter } from '../index.js'
import { RuntimeSessionManager } from '../session-manager.js'

test('runtime-lean saves global and domain settings with an additive restart notice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-lean-route-'))
  const previous = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  let manager: RuntimeSessionManager | undefined
  let finishRun: (() => void) | undefined
  let sessionId: string | undefined
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ runtime: { lean: false } }))
    let startedRun!: () => void
    const started = new Promise<void>(resolve => { startedRun = resolve })
    let interruptions = 0
    manager = new RuntimeSessionManager({ externalScanMs: 0, idleAgentTtlMs: 0, createAgent: () => ({
      run: () => new Promise<void>(resolve => { finishRun = resolve; startedRun() }),
      abort: () => { interruptions++ }, shutdown: () => { interruptions++ },
      listArtifacts: () => [], readArtifact: async () => null, getMessages: () => [],
      replaceMessages: () => {}, rewindToMessages: () => {},
    }) })
    sessionId = manager.createSession({ cwd: home, prompt: 'hold this run while settings are saved' }).id
    await started
    const router = createRouter(buildConfigRoutes('lean-route-test'))
    const headers = { authorization: 'Bearer lean-route-test' }
    for (const patch of [{ lean: true, maxLoadedSessions: 8 }, { domains: { taiyi: { idleAgentTtlMs: 1000 } } }]) {
      const result = await router('PUT', '/config/runtime-lean', patch, headers)
      assert.equal(result.status, 200)
      const body = result.body as { ok: boolean; effectiveAfterRestart?: boolean; lean: boolean; maxLoadedSessions: number; domains?: unknown }
      assert.equal(body.ok, true, 'legacy clients still receive the existing success field')
      assert.equal(body.effectiveAfterRestart, true)
      assert.equal(body.lean, true)
      assert.equal(body.maxLoadedSessions, 8)
      assert.equal(manager.stats().runningCount, 1, 'saving config must not stop a live run')
      assert.equal(interruptions, 0)
    }
    const disk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(disk.runtime.maxLoadedSessions, 8)
    assert.equal(disk.runtime.domains.taiyi.idleAgentTtlMs, 1000)
    assert.equal(disk.runtime.effectiveAfterRestart, undefined, 'response metadata is not persisted as config')
    const invalid = await router('PUT', '/config/runtime-lean', { maxLoadedSessions: 0 }, headers)
    assert.equal(invalid.status, 400)
    assert.equal((invalid.body as Record<string, unknown>).effectiveAfterRestart, undefined)
  } finally {
    finishRun?.()
    if (manager && sessionId) await manager.waitForRunSettled(sessionId)
    await manager?.shutdownAll()
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
