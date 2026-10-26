import { it } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTick } from 'node:timers/promises'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../runtime-hooks.js'
import { createStigmergyRuntimeHook } from '../hooks/stigmergy-hook.js'
import { createKickRuntimeHook } from '../hooks/kick-hook.js'
import { createDeadEndDetectorHook } from '../hooks/dead-end-detector.js'
import { createAutoCaptureHooks } from '../hooks/auto-capture-hook.js'
import { createAdvisoryReadbackHooks } from '../hooks/advisory-readback-hook.js'
import { createRecallEfficacyHook } from '../hooks/recall-efficacy-hook.js'
import { createWalkthroughRecorderHooks } from '../hooks/walkthrough-recorder.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import { AdvisoryBus } from '../advisory-bus.js'
import { getRecallTracker, releaseRecallTracker } from '../../memory/recall-efficacy.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function context(signal?: AbortSignal) {
  return createRuntimeHookContext({ cwd: '/tmp', turn: 5, recentToolHistory: [],
    sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, {}, signal)
}

it('a cancelled stigmergy query cannot update the next run through its dependency closure', async () => {
  const entered = barrier(), release = barrier()
  const abort = new AbortController()
  let writes = 0
  const hook = createStigmergyRuntimeHook({
    deposit: async () => {}, getEvidenceState: () => ({ verifications: [] }),
    query: async () => { entered.release(); await release.promise; return [] },
    setLoadedPheromones: () => { writes++ },
  })
  const pending = new RuntimeHookPipeline([hook]).runPostTool(context(abort.signal), { name: 'read_file', success: true })
  await entered.promise
  abort.abort()
  release.release()
  await pending
  await nextTick()
  assert.equal(writes, 0)
})

it('a cancelled kick cannot submit late advice after a deposit finishes', async () => {
  const entered = barrier(), release = barrier(), abort = new AbortController()
  const bus = new AdvisoryBus()
  let submissions = 0
  const submit = bus.submit.bind(bus)
  bus.submit = advice => { submissions++; submit(advice) }
  const hook = createKickRuntimeHook({ advisoryBus: bus, deposit: async () => { entered.release(); await release.promise } })
  const ctx = context(abort.signal)
  ctx.snapshot.sensorium = { momentum: 0.1, pressure: 0.3, confidence: 0.5, complexity: 0.4, freshness: 0.5, stability: 0.2 }
  ctx.snapshot.recentToolHistory = [{ tool: 'edit_file', status: 'failed', target: 'src/a.ts' }]
  const pending = new RuntimeHookPipeline([hook]).runPreTurn(ctx)
  await entered.promise
  abort.abort()
  release.release()
  await pending
  await nextTick()
  assert.equal(submissions, 0)
})

it('an old verification cannot clear dead-end observations accumulated by a new run', async () => {
  const entered = barrier(), release = barrier(), abort = new AbortController()
  const hook = createDeadEndDetectorHook({ advisoryBus: { submit() {} }, deposit: async () => { entered.release(); await release.promise } })
  const edit = { name: 'edit_file', success: true, input: { file_path: 'src/old.ts' } }
  await hook.run(context(), edit)
  const pending = new RuntimeHookPipeline([hook]).runPostTool(context(abort.signal), { name: 'run_tests', success: true })
  await entered.promise
  abort.abort()
  await hook.run(context(), { ...edit, input: { file_path: 'src/new.ts' } })
  await hook.run(context(), { name: 'run_tests', success: false, isError: true })
  assert.equal(hook.getCycleCount('src/new.ts'), 1)
  release.release()
  await pending
  await nextTick()
  assert.equal(hook.getCycleCount('src/new.ts'), 1)
})

it('auto-capture snapshots its buffer before later tools append new candidates', async () => {
  const prompts: string[] = []
  const pair = createAutoCaptureHooks({ cwd: '/tmp', enabled: true, complete: async prompt => { prompts.push(prompt); return '[]' } })
  const pipeline = new RuntimeHookPipeline([pair.postTool, pair.postSession])
  await pipeline.runPostTool(context(), { name: 'write_file', success: true, target: 'src/old.ts' })
  const oldFinalize = pipeline.capturePostSession(context())
  await pipeline.runPostTool(context(), { name: 'write_file', success: true, target: 'src/new.ts' })
  await oldFinalize()
  await pipeline.runPostSession(context())
  assert.equal(prompts.length, 2)
  assert.ok(prompts[0]?.includes('src/old.ts') && !prompts[0]?.includes('src/new.ts'))
  assert.ok(prompts[1]?.includes('src/new.ts') && !prompts[1]?.includes('src/old.ts'))
})

it('old advisory finalization cannot consume new pending expectations', async () => {
  const readback = new AdvisoryReadback()
  const track = (key: string) => readback.track([{ key, category: 'discipline', expect: { kind: 'tool_appears', tools: ['grep'], withinTurns: 3 } }], 5)
  const pipeline = new RuntimeHookPipeline(createAdvisoryReadbackHooks({ readback }))
  track('old')
  const oldFinalize = pipeline.capturePostSession(context())
  track('new')
  await oldFinalize()
  assert.equal(readback.hasPending('old'), false)
  assert.equal(readback.hasPending('new'), true)
})

it('old recall finalization cannot release the next run tracker', async t => {
  const sessionId = 'hook-run-isolation-recall'
  t.after(() => releaseRecallTracker(sessionId))
  const oldTracker = getRecallTracker(sessionId)
  oldTracker.record('old', [])
  let observedRecalls = 0
  t.mock.method(oldTracker, 'finalize', () => { observedRecalls = oldTracker.recallCount; return null })
  const pipeline = new RuntimeHookPipeline([createRecallEfficacyHook({ cwd: '/tmp', sessionId, getAssistantText: () => '' })])
  const oldFinalize = pipeline.capturePostSession(context())
  const newTracker = getRecallTracker(sessionId)
  newTracker.record('new', [])
  await oldFinalize()
  assert.equal(observedRecalls, 1)
  assert.notEqual(newTracker, oldTracker)
  assert.equal(getRecallTracker(sessionId), newTracker)
  assert.equal(newTracker.recallCount, 1)
})

it('walkthrough finalization captures steps before the next run adds more', async () => {
  const saved: string[] = []
  const hooks = createWalkthroughRecorderHooks({ getArtifactStore: () => ({ save: async input => { saved.push(input.rawContent); return 'saved' } }) })
  const pipeline = new RuntimeHookPipeline(hooks)
  const step = (url: string) => ({ name: 'browser_debug', success: true, input: { action: 'navigate', url } })
  await pipeline.runPostTool(context(), step('https://old.example'))
  const oldFinalize = pipeline.capturePostSession(context())
  await pipeline.runPostTool(context(), step('https://new.example'))
  await oldFinalize()
  assert.equal(saved.length, 1)
  assert.ok(saved[0]?.includes('old.example') && !saved[0]?.includes('new.example'))
})
