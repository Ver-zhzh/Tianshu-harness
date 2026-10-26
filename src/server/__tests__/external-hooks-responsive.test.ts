import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExternalHookHost } from '../../hooks/external-hook-host.js'
import { createUserHooksBridge } from '../../agent/hooks/user-hooks-bridge.js'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../../agent/runtime-hooks.js'
import { startServer } from '../index.js'
import { RuntimeSessionManager } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { buildHealthRoute } from '../health-route.js'
import { ServerEventBus } from '../server-event-bus.js'
import { buildServerEventsRoute } from '../server-events-route.js'
import { SseConnectionRegistry } from '../sse-registry.js'

const auth = 'fictional-hook-fixture'
const headers = { authorization: `Bearer ${auth}` }
process.env.RIVET_TRUST_PROJECT = '1'
test('real pipeline scripts do not block authenticated HTTP, SSE, heartbeat or another session', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-http-'))
  const host = new ExternalHookHost()
  const manager = new RuntimeSessionManager({ createAgent: () => { throw new Error('fixture does not request a model') }, defaultCwd: cwd })
  const bus = new ServerEventBus(), registry = new SseConnectionRegistry()
  const server = await startServer(0, { ...buildSessionRoutes(manager, auth),
    ...buildHealthRoute(manager, Date.now(), 'fixture', auth, undefined, undefined, undefined, undefined, undefined, () => host.snapshot()),
    ...buildServerEventsRoute(bus, auth, { healthSnapshot: () => ({ ok: true }) as never }, registry) }, auth)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'slow.sh'), '#!/bin/sh\necho ready >ready\nsleep 5\necho LATE >late\n')
    await chmod(join(cwd, 'slow.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'slow.sh' }] }))
    const response = await fetch(`http://127.0.0.1:${server.port}/events`, { headers })
    reader = response.body!.getReader(); await reader.read()
    const runtime = host.createRuntime({ cwd }); runtime.beginRun('run')
    const outcomes: string[] = []
    const pipeline = new RuntimeHookPipeline(createUserHooksBridge({ cwd, runtime, getTurn: () => 1, getRunId: () => 'run' }),
      { hookTimeoutMs: 2_000, onRun: event => outcomes.push(event.outcome) })
    const signal = new AbortController()
    const ctx = createRuntimeHookContext({ cwd, runId: 'run', turn: 1, recentToolHistory: [], sensorium: null,
      strategy: null, vigor: null, gitChangeRate: 0, season: null }, {}, signal.signal)
    let finished = false, beats = 0
    heartbeat = setInterval(() => beats++, 10)
    const running = pipeline.runPreTurn(ctx).finally(() => { finished = true })
    const deadline = Date.now() + 3_000
    while (!await readFile(join(cwd, 'ready')).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10))
    }
    const health = await fetch(`http://127.0.0.1:${server.port}/health`, { headers })
    assert.equal(health.status, 200)
    assert.equal(((await health.json()) as { externalHooks: { running: number } }).externalHooks.running, 1)
    const created = await fetch(`http://127.0.0.1:${server.port}/sessions`, { method: 'POST', headers, body: '{}' })
    assert.equal(created.status, 201); await created.text()
    bus.publish('sessions_changed', 'other')
    const chunk = await reader.read()
    assert.match(new TextDecoder().decode(chunk.value), /sessions_changed/)
    assert.equal(finished, false, 'HTTP/SSE must progress before the slow hook completes')
    assert.ok(beats >= 1)
    signal.abort(); await running
    await runtime.barrier()
    assert.equal(outcomes.at(-1), 'skipped')
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
  } finally {
    clearInterval(heartbeat); await reader?.cancel().catch(() => {})
    registry.closeAll(); bus.close(); await host.shutdown(); await manager.shutdownAll()
    server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(cwd, { recursive: true, force: true })
  }
})
