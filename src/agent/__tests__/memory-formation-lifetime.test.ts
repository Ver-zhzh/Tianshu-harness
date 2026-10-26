import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { createAutoCaptureHooks } from '../hooks/auto-capture-hook.js'
import { createSessionConsolidationHook } from '../hooks/session-consolidation-hook.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type PostSessionRuntimeHook } from '../runtime-hooks.js'
import { runGateCompletion, type GateCompletionClient } from '../gate-completion.js'
import { readMemoryEntries } from '../../memory/unified-memory.js'

function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function context(cwd: string, signal?: AbortSignal) {
  return createRuntimeHookContext({ cwd, turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, {}, signal)
}
const outputs = {
  capture: '[{"index":0,"worth":true,"summary":"Preserve verified request identity across retries in this project.","kind":"decision","confidence":0.9}]',
  consolidation: '{"summary":"This task verified request identity and completed the relevant regression tests.","procedures":[]}',
}
function fixture(t: TestContext, kind: keyof typeof outputs, complete: (prompt: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>, enabled = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-memory-lifetime-'))
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const deps = { cwd, sessionId: 'fixture-session', enabled, complete, timeoutMs: 25 }
  let hook: PostSessionRuntimeHook
  if (kind === 'capture') {
    const pair = createAutoCaptureHooks(deps)
    pair.postTool.run(context(cwd), { name: 'write_file', success: true, target: 'src/a.ts', resultContent: 'written' })
    hook = pair.postSession
  } else hook = createSessionConsolidationHook({ ...deps, getTranscript: () => 'A controlled task transcript with verified engineering evidence. '.repeat(6) })
  return { cwd, hook, memoryPath: join(cwd, '.rivet/knowledge/memory.jsonl') }
}

for (const kind of ['capture', 'consolidation'] as const) {
  it(`${kind}: valid output before the deadline writes memory`, async t => {
    const f = fixture(t, kind, async (_prompt, budget, signal) => {
      assert.equal(budget, 25)
      assert.ok(signal && !signal.aborted)
      return outputs[kind]
    })
    await new RuntimeHookPipeline([f.hook]).runPostSession(context(f.cwd))
    assert.equal(readMemoryEntries(f.cwd).length, 1)
    assert.equal(f.hook.budgetMs, 5_025)
  })

  for (const end of ['outer-timeout', 'parent-cancel', 'late-rejection'] as const) it(`${kind}: ${end} revokes direct memory writes`, async t => {
    const entered = barrier<void>(), late = barrier<string>()
    let received: AbortSignal | undefined
    const f = fixture(t, kind, async (_prompt, _budget, signal) => { received = signal; entered.resolve(); return late.promise })
    const parent = new AbortController()
    f.hook.budgetMs = 10
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pipeline = new RuntimeHookPipeline([f.hook])
    const pending = pipeline.runPostSession(context(f.cwd, parent.signal))
    await entered.promise
    if (end === 'parent-cancel') parent.abort()
    else t.mock.timers.tick(10)
    await pending
    assert.ok(received?.aborted)
    if (end === 'late-rejection') late.reject(new Error('controlled late failure'))
    else late.resolve(outputs[kind])
    await nextTick()
    assert.equal(existsSync(f.memoryPath), false, 'a late completion must never create memory')
    assert.equal(pipeline.getStats()[0]?.timeouts, end === 'parent-cancel' ? 0 : 1)
  })

  it(`${kind}: inner timeout aborts a non-cooperative client and leaves no memory`, async t => {
    const entered = barrier<void>(), late = barrier<void>()
    let received: AbortSignal | undefined
    const client: GateCompletionClient = { async stream(_request, cb, signal) {
      received = signal; entered.resolve(); await late.promise
      cb.onTextDelta(outputs[kind]); cb.onStopReason('end_turn', { input_tokens: 1 })
    } }
    const f = fixture(t, kind, (prompt, timeout, signal) => runGateCompletion(client, () => {}, prompt, timeout, signal))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pipeline = new RuntimeHookPipeline([f.hook])
    const pending = pipeline.runPostSession(context(f.cwd))
    await entered.promise
    t.mock.timers.tick(25)
    await pending
    late.resolve(); await nextTick()
    assert.ok(received?.aborted)
    assert.equal(pipeline.getStats()[0]?.timeouts, 0, 'inner fail-closed completes before the outer guard')
    assert.equal(existsSync(f.memoryPath), false)
  })

  it(`${kind}: disabled hooks do not call a model or maintain the memory store`, async t => {
    let calls = 0
    const f = fixture(t, kind, async () => { calls++; return outputs[kind] }, false)
    if (kind === 'capture') {
      const pair = createAutoCaptureHooks({ cwd: f.cwd, enabled: false, complete: async () => '' })
      assert.doesNotThrow(() => pair.postTool.run(context(f.cwd), {
        get name(): string { throw new Error('disabled capture must not inspect or buffer candidates') }, success: true,
      }))
    }
    mkdirSync(join(f.cwd, '.rivet/knowledge'), { recursive: true })
    const sentinel = JSON.stringify({ id: 'sentinel', text: 'An expired observation that must remain untouched while disabled.', source: 'consolidation', status: 'expired', validTo: 1, ts: 1 }) + '\n'
    writeFileSync(f.memoryPath, sentinel)
    await new RuntimeHookPipeline([f.hook]).runPostSession(context(f.cwd))
    assert.equal(calls, 0)
    assert.equal(readFileSync(f.memoryPath, 'utf8'), sentinel)
  })
}

it('production hook budgets preserve 12/15 second requests with five seconds of headroom', () => {
  const complete = async () => ''
  assert.equal(createAutoCaptureHooks({ cwd: '/tmp', complete }).postSession.budgetMs, 17_000)
  assert.equal(createSessionConsolidationHook({ cwd: '/tmp', complete, getTranscript: () => '' }).budgetMs, 20_000)
})

it('transport cancellation returns without a cooperative client and still records late usage', async () => {
  const parent = new AbortController(), entered = barrier<void>(), late = barrier<void>()
  const usage: number[] = []
  let received: AbortSignal | undefined
  const pending = runGateCompletion({ async stream(_request, cb, signal) {
    received = signal; entered.resolve(); await late.promise
    cb.onTextDelta('must be discarded')
    cb.onStopReason('end_turn', { input_tokens: 7 })
    throw new Error('late transport rejection')
  } }, (_kind, value) => { usage.push(value.input_tokens ?? 0) }, 'fixture', 60_000, parent.signal)
  await entered.promise
  parent.abort()
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await nextTick()
  const settledBeforeRelease = settled, cancelledBeforeRelease = received?.aborted
  late.resolve()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(settledBeforeRelease, true, 'cancellation must settle without waiting for the client')
  assert.equal(cancelledBeforeRelease, true)
  await nextTick()
  assert.deepEqual(usage, [7], 'cancelling a result must not hide the provider bill')
})

it('already cancelled requests never reach the client', async () => {
  let calls = 0
  const parent = new AbortController(); parent.abort()
  await assert.rejects(runGateCompletion({ async stream() { calls++ } }, () => {}, 'fixture', 100, parent.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
})
