import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import { RuntimeHookPipeline, type RuntimeHook, type RuntimeHookContext } from '../runtime-hooks.js'
import { createPerceptionRuntimeHook } from '../hooks/perception-hook.js'
import type { AgentCallbacks } from '../loop-types.js'
import type { StreamClient } from '../../api/stream-client.js'
import { createRuntimeHooksPipeline } from '../loop-factory.js'
import type { Tool } from '../../tools/types.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

// A deadlock fails explicitly; successful tests advance via barriers, not sleeps.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('run lifecycle barrier timed out')), 3_000)
    })])
  } finally { clearTimeout(timer) }
}

function callbacks(events: string[]): AgentCallbacks {
  return {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {},
    onTurnComplete: (_usage, _turn, final) => { events.push(final ? 'final' : 'intermediate') },
    onError: error => { events.push(`error:${error.message}`) },
    onAbort: () => { events.push('abort') },
    onApprovalRequired: async () => true,
  }
}

function makeAgent(t: TestContext, hooks: RuntimeHook[], onStream: () => void | Promise<void> = () => {}, withTools = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-run-lifecycle-'))
  const session = new SessionContext()
  const registry = new ToolRegistry()
  const tool: Tool = { definition: { name: 'probe', description: 'Read-only probe', input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: 'ok' }), requiresApproval: () => false, isConcurrencySafe: () => false, isEnabled: () => true }
  if (withTools) registry.register(tool)
  let streams = 0
  const client: StreamClient = {
    async stream(_request, cb) {
      await onStream()
      if (withTools && ++streams <= 2) {
        cb.onContentBlock({ type: 'tool_use', id: `probe-${streams}`, name: 'probe', input: {} })
        cb.onStopReason('tool_use', { input_tokens: 3, output_tokens: 2 })
        return
      }
      cb.onTextDelta('Hello.')
      cb.onContentBlock({ type: 'text', text: 'Hello.' })
      cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
    },
  }
  const agent = new AgentLoop({
    client, runtimeHooks: new RuntimeHookPipeline([createPerceptionRuntimeHook(), ...hooks]),
    toolRegistry: registry, maxTurns: 3, contextWindow: 1_000_000,
    promptEngine: new PromptEngine({ model: 'test-model', maxTokens: 1024, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd } }),
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'test-model' },
    fsWatcherEnabled: false, crossSessionEnabled: false,
  }, session, cwd)
  t.after(async () => {
    agent.abort()
    await agent.cancelIdleCompaction()
    await agent.drainPostSession(1_000)
    agent.stopConfigWatcher()
    agent.flushStigmergySync()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { agent, session }
}

for (const phase of ['preTurn', 'afterPerception', 'postTool', 'postTurn'] as const) {
  it(`${phase}: aborted hooks cannot write after the next run completes`, async t => {
    const entered = barrier(), release = barrier(), returned = barrier()
    t.after(release.release)
    let first = true
    let oldContext: RuntimeHookContext | undefined
    let followingHooks = 0
    const { agent, session } = makeAgent(t, [
      { phase, name: 'delayed-old-run', async run(ctx: RuntimeHookContext) {
        if (!first) return
        first = false
        oldContext = ctx
        const inject = ctx.effects.injectUserMessage
        const setStrategy = ctx.effects.setStrategy
        const setVigor = ctx.effects.setVigor
        entered.release()
        await release.promise // deliberately ignores cancellation
        inject('OLD_RUN_INJECTION')
        if (ctx.snapshot.strategy) setStrategy({ ...ctx.snapshot.strategy, reasoningEffort: 'high' })
        if (ctx.snapshot.vigor) setVigor({ ...ctx.snapshot.vigor, tonic: 0 })
        returned.release()
      } },
      { phase, name: 'must-not-follow-cancelled-hook', run() { followingHooks++ } },
    ], () => {}, phase === 'postTool')
    const firstEvents: string[] = [], secondEvents: string[] = []
    const firstRun = agent.run('Hello', callbacks(firstEvents))
    await bounded(entered.promise)
    agent.abort()
    await bounded(firstRun)
    await bounded(agent.run('Hello again', callbacks(secondEvents)))
    const messages = structuredClone(session.getMessages())
    const sensorium = agent.sensorium
    const strategy = agent.strategy
    const vigor = agent.vigorState
    release.release()
    await bounded(returned.promise)
    await nextTick()
    assert.equal(oldContext?.signal?.aborted, true, 'the original hook must see its run cancellation')
    assert.deepEqual(session.getMessages(), messages, 'late hook writes must not alter conversation history')
    assert.equal(agent.sensorium, sensorium, 'late perception must not overwrite the next run state')
    assert.equal(agent.strategy, strategy)
    assert.equal(agent.vigorState, vigor)
    assert.equal(followingHooks, 1, 'only the second run may execute the remaining hooks')
    assert.deepEqual(firstEvents, ['abort'])
    assert.deepEqual(secondEvents, phase === 'postTool' ? ['intermediate', 'final'] : ['final'])
  })
}

it('a completed run cannot publish its late initialization query into the next run', async t => {
  const release = barrier()
  t.after(release.release)
  const { agent } = makeAgent(t, [])
  let queries = 0
  t.mock.method(agent.stigmergyStore, 'query', async () => {
    if (++queries === 1) await release.promise
    return []
  })
  await bounded(agent.run('Hello', callbacks([])))
  await bounded(agent.run('Hello again', callbacks([])))
  const current = agent.loadedPheromones
  release.release()
  await nextTick()
  assert.equal(agent.loadedPheromones, current)
})

it('an abandoned request builder cannot prepare a request or clear the next run decisions', async t => {
  const entered = barrier(), release = barrier()
  const secondStarted = barrier(), releaseSecond = barrier()
  t.after(release.release)
  t.after(releaseSecond.release)
  const { agent } = makeAgent(t, [], async () => { secondStarted.release(); await releaseSecond.promise })
  let refreshes = 0, preparations = 0, discarded = 0
  t.mock.method(agent.config.promptEngine, 'refreshGitContextIfNeeded', async () => {
    if (++refreshes === 1) { entered.release(); await release.promise }
  })
  const prepare = agent.prepareBudgetedRequest.bind(agent)
  t.mock.method(agent, 'prepareBudgetedRequest', (...args: Parameters<typeof prepare>) => { preparations++; return prepare(...args) })
  const firstEvents: string[] = []
  const firstRun = agent.run('Hello', callbacks(firstEvents))
  await bounded(entered.promise)
  agent.abort()
  await bounded(firstRun)
  const secondRun = agent.run('Hello again', callbacks([]))
  try {
    await bounded(secondStarted.promise)
    t.mock.method(agent.decisionShifts, 'discard', () => { discarded++ })
    release.release()
    await nextTick()
    assert.equal(preparations, 1, 'only the new run may prepare a model request')
    assert.equal(discarded, 0, 'old finally must not clear new decision cards')
    assert.deepEqual(firstEvents, ['abort'])
  } finally {
    releaseSecond.release()
    await bounded(secondRun)
  }
})

for (const mode of ['natural', 'max-turns'] as const) it(`abort during ${mode} finalization keeps one finalizer and starts the next stream immediately`, async t => {
  const entered = barrier(), release = barrier(), secondStream = barrier()
  t.after(release.release)
  let finalizers = 0, streams = 0
  const { agent } = makeAgent(t, [{
    phase: 'postSession', name: 'slow-finalizer', async run() {
      if (++finalizers === 1) { entered.release(); await release.promise }
    },
  }], () => { if (++streams === 2) secondStream.release() }, mode === 'max-turns')
  if (mode === 'max-turns') agent.config.maxTurns = 1
  const firstEvents: string[] = [], secondEvents: string[] = []
  const firstRun = agent.run('Hello', callbacks(firstEvents))
  await bounded(entered.promise)
  agent.abort()
  await bounded(firstRun)
  const firstExpected = mode === 'max-turns' ? ['intermediate', 'abort'] : ['abort']
  assert.deepEqual(firstEvents, firstExpected)
  assert.equal(await agent.drainPostSession(0), false, 'the original finalizer remains tracked')
  const secondRun = agent.run('Hello again', callbacks(secondEvents))
  await bounded(secondStream.promise) // old finalizer is still blocked here
  assert.equal(finalizers, 1, 'abort must not schedule a duplicate finalizer')
  release.release()
  await bounded(secondRun)
  assert.equal(await agent.drainPostSession(1_000), true)
  await nextTick()
  assert.equal(finalizers, 2, 'each of the two runs finalizes exactly once')
  assert.deepEqual(firstEvents, firstExpected, 'no late final event after abort')
  assert.deepEqual(secondEvents, mode === 'max-turns' ? ['intermediate', 'final'] : ['final'])
})

it('production finalizers keep the old transcript while the next run starts', async t => {
  const gateEntered = barrier(), releaseGate = barrier(), nextStream = barrier()
  t.after(releaseGate.release)
  let streams = 0
  const { agent } = makeAgent(t, [], () => { if (++streams === 2) nextStream.release() })
  const previousSessionDir = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(agent.cwd, 'sessions')
  t.after(() => {
    if (previousSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = previousSessionDir
  })
  const prompts: string[] = []
  // Build the real production hook wiring without creating a persisted agent session.
  agent.config.sessionId = 'run-lifecycle-snapshot-probe'
  agent.config.dreamEnabled = false
  agent.config.memoryFormation = { autoCapture: false, consolidation: true }
  agent.config.compactClient = { async stream(request, cb) {
    const prompt = String(request.messages[0]?.content ?? '')
    prompts.push(prompt)
    if (prompts.length === 1) { gateEntered.release(); await releaseGate.promise }
    cb.onTextDelta('{}') // no knowledge is admitted or written by the fake model
    cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
  } }
  agent.knowledgeCandidates.push({ text: 'FIRST_RUN_CANDIDATE', kind: 'finding', confidence: 0.8, origin: 'observation' })
  agent.runtimeHooks = createRuntimeHooksPipeline(agent)
  const oldEvents: string[] = [], newEvents: string[] = []
  const firstRun = agent.run('Hello. FIRST_RUN_MARKER ' + 'a'.repeat(250), callbacks(oldEvents))
  await bounded(gateEntered.promise)
  agent.abort()
  await bounded(firstRun)
  const secondRun = agent.run('Hello again. SECOND_RUN_MARKER', callbacks(newEvents))
  await bounded(nextStream.promise)
  agent.knowledgeCandidates.push({ text: 'SECOND_RUN_CANDIDATE', kind: 'finding', confidence: 0.8, origin: 'observation' })
  releaseGate.release()
  await bounded(secondRun)
  await agent.drainPostSession()
  const summaries = prompts.filter(prompt => prompt.includes('会话整理器'))
  assert.equal(summaries.length, 2)
  assert.ok(summaries[0]?.includes('FIRST_RUN_MARKER'))
  assert.ok(!summaries[0]?.includes('SECOND_RUN_MARKER'), 'old consolidation cannot consume the new run transcript')
  assert.ok(summaries[1]?.includes('SECOND_RUN_MARKER'))
  assert.deepEqual(oldEvents, ['abort'])
  assert.deepEqual(newEvents, ['final'])
})
