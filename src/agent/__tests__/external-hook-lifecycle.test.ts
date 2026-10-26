import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalHookHost } from '../../hooks/external-hook-host.js'
import { createUserHooksBridge, runOnErrorHooks } from '../hooks/user-hooks-bridge.js'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../runtime-hooks.js'
import { HookCleanupUnconfirmedError, type ExternalHookRuntime } from '../../hooks/external-hook-types.js'

process.env.RIVET_TRUST_PROJECT = '1'
const posix = { skip: process.platform === 'win32' }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function context(cwd: string, runId: string, turn: number, signal?: AbortSignal) {
  return createRuntimeHookContext({ cwd, runId, turn, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, {}, signal)
}

test('30ms outer budget interrupts a real three-script group and records one timeout', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-outer-'))
  const host = new ExternalHookHost()
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'slow.sh'), '#!/bin/sh\nsleep 0.3\necho late\n')
    await chmod(join(cwd, 'slow.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: Array.from({ length: 3 }, () => ({ event: 'preTurn', script: 'slow.sh' })) }))
    const runtime = host.createRuntime({ cwd }); runtime.beginRun('one')
    const pipeline = new RuntimeHookPipeline(createUserHooksBridge({ cwd, runtime, getRunId: () => 'one', getTurn: () => 1 }), { hookTimeoutMs: 30 })
    let heartbeat = false
    const beat = setTimeout(() => { heartbeat = true }, 10)
    const started = performance.now()
    await pipeline.runPreTurn(context(cwd, 'one', 1))
    clearTimeout(beat)
    assert.ok(performance.now() - started < 350, 'synchronous execution defeated the 30ms budget')
    assert.equal(heartbeat, true)
    assert.equal(pipeline.getStats()[0]?.timeouts, 1)
    assert.equal(pipeline.getStats()[0]?.runs, 1)
    await runtime.barrier()
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})

test('postSession captures the original run and cannot execute after replacement', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-capture-'))
  const host = new ExternalHookHost()
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'write.sh'), '#!/bin/sh\necho WRONG > late\n')
    await chmod(join(cwd, 'write.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'postSession', script: 'write.sh' }] }))
    const emissions: Array<{ turn?: number; runId?: string }> = []
    const runtime = host.createRuntime({ cwd, emitResult: (_results, meta) => emissions.push(meta) })
    runtime.beginRun('old')
    let liveTurn = 1, liveRun = 'old'
    const pipeline = new RuntimeHookPipeline(createUserHooksBridge({ cwd, runtime, getTurn: () => liveTurn, getRunId: () => liveRun }))
    const finalize = pipeline.capturePostSession(context(cwd, 'old', 1))
    liveTurn = 2; liveRun = 'new'; runtime.beginRun('new')
    await finalize()
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
    assert.equal(emissions[0]?.runId, 'old'); assert.equal(emissions[0]?.turn, 1)
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})

test('onError has a tracked budget without a desktop sink and never recursively dispatches', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-error-'))
  const host = new ExternalHookHost()
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'error.sh'), '#!/bin/sh\necho seen > seen\nsleep 5\necho BAD > late\n')
    await chmod(join(cwd, 'error.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'onError', script: 'error.sh' }] }))
    const runtime = host.createRuntime({ cwd }); runtime.beginRun('one')
    const deps = { cwd, runtime, getRunId: () => 'one', getTurn: () => 4, budgetMs: 500 }
    await assert.rejects(runOnErrorHooks(deps, 'fault'), /budget exhausted/)
    await runtime.barrier()
    assert.equal(await readFile(join(cwd, 'seen'), 'utf8'), 'seen\n')
    assert.equal(host.snapshot().timeouts, 1)
    await runOnErrorHooks(deps, 'late fault', { late: true, phase: 'preTurn', hookName: 'test', message: 'late', error: Error('late') })
    assert.equal(host.snapshot().timeouts, 1)
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})

test('cleanup isolation errors escape the pipeline instead of continuing later hooks', async () => {
  let continued = false
  const runtime: ExternalHookRuntime = { runtimeId: 'fixture', beginRun() {}, close: async () => {}, barrier: async () => {},
    execute: () => ({ result: Promise.resolve({ invocationId: 'one', runtimeId: 'fixture', runId: 'one', status: 'skipped',
      results: [], durationMs: 0, queueWaitMs: 0, cleanup: 'unknown' }), reaped: Promise.resolve('unknown'), cancel() {} }) }
  const pipeline = new RuntimeHookPipeline([...createUserHooksBridge({ cwd: '/fixture', runtime, getRunId: () => 'one', getTurn: () => 1 }),
    { phase: 'preTurn', name: 'must-not-continue', run: () => { continued = true } }])
  await assert.rejects(pipeline.runPreTurn(context('/fixture', 'one', 1)), HookCleanupUnconfirmedError)
  assert.equal(continued, false)
  await wait(1)
})

test('parent abort reaches a running script before the independent group budget expires', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-parent-abort-'))
  const host = new ExternalHookHost()
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'hold.sh'), '#!/bin/sh\necho ready >ready\nsleep 5\n')
    await chmod(join(cwd, 'hold.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'hold.sh' }] }))
    const runtime = host.createRuntime({ cwd }); runtime.beginRun('one')
    const controller = new AbortController()
    const pipeline = new RuntimeHookPipeline(createUserHooksBridge({ cwd, runtime, getRunId: () => 'one', getTurn: () => 1 }), { hookTimeoutMs: 5_000 })
    const running = pipeline.runPreTurn(context(cwd, 'one', 1, controller.signal))
    const deadline = Date.now() + 3_000
    while (!await readFile(join(cwd, 'ready')).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline); await wait(10)
    }
    controller.abort(); await running
    await Promise.race([runtime.barrier(), wait(700).then(() => { assert.fail('Parent abort did not reach the owned process') })])
    assert.equal(host.snapshot().running, 0)
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})
