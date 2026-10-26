import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { createAgentConfig, createMainAgentConfigInput } from '../create-agent-config.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createRuntimeHookContext } from '../runtime-hooks.js'

it('schema config reaches real hook registration and new sessions keep independent settings', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-memory-wiring-'))
  const env = { home: process.env.RIVET_HOME, capture: process.env.RIVET_MEMORY_AUTO_CAPTURE, consolidation: process.env.RIVET_MEMORY_CONSOLIDATION }
  process.env.RIVET_HOME = cwd
  delete process.env.RIVET_MEMORY_AUTO_CAPTURE; delete process.env.RIVET_MEMORY_CONSOLIDATION
  const agents: AgentLoop[] = []
  t.after(async () => {
    for (const agent of agents) { agent.stopConfigWatcher(); await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }
    for (const [key, value] of [['RIVET_HOME', env.home], ['RIVET_MEMORY_AUTO_CAPTURE', env.capture], ['RIVET_MEMORY_CONSOLIDATION', env.consolidation]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const config = structuredClone(DEFAULT_CONFIG)
  let requests = 0
  const received: AbortSignal[] = []
  const make = (worker = false, origin = false) => {
    const input = createMainAgentConfigInput({ toolPreset: 'minimal',
      config, cwd, sessionId: worker ? 'worker-memory-fixture' : `memory-fixture-${agents.length}`,
      model: { id: 'test-model', maxTokens: 128, contextWindow: 100_000 }, toolDefinitions: [],
      apiKey: 'fixture', provider: config.provider.providers.deepseek!, userInstructions: DISABLED_USER_INSTRUCTIONS,
    })
    const built = createAgentConfig(input)
    assert.deepEqual(built.memoryFormation, config.agent.memoryFormation)
    const agent = new AgentLoop({ ...built, sessionId: undefined, maxTurns: 1, compact: { ...built.compact, enabled: false }, toolRegistry: new ToolRegistry(), fsWatcherEnabled: false,
      inputOrigin: origin ? 'worker_task' : undefined }, new SessionContext(), cwd)
    // Install the production wiring with a session id after construction, to avoid test persistence.
    agent.config.sessionId = input.sessionId
    agent.config.compactClient = { async stream(_request, cb, signal) { requests++; assert.ok(signal); received.push(signal); cb.onTextDelta('[]'); cb.onStopReason('end_turn', { input_tokens: 1 }) } }
    agents.push(agent)
    return agent
  }
  const { createRuntimeHooksPipeline } = await import('../loop-factory.js')
  const names = (agent: AgentLoop) => { agent.runtimeHooks = createRuntimeHooksPipeline(agent); return agent.runtimeHooks.getManifest().map(h => h.id) }
  const off = make()
  assert.ok(!names(off).includes('memory-auto-capture'))
  assert.ok(!names(off).includes('session-consolidation'))
  config.agent.memoryFormation = { autoCapture: true, consolidation: false }
  const capture = make(); assert.ok(names(capture).includes('memory-auto-capture')); assert.ok(!names(capture).includes('session-consolidation'))
  config.agent.memoryFormation = { autoCapture: false, consolidation: true }
  const consolidation = make(); assert.ok(names(consolidation).includes('session-consolidation')); assert.ok(!names(consolidation).includes('memory-auto-capture'))
  assert.ok(capture.runtimeHooks.getManifest().some(h => h.id === 'memory-auto-capture'), 'saved changes cannot alter existing sessions')
  process.env.RIVET_MEMORY_AUTO_CAPTURE = 'on'; process.env.RIVET_MEMORY_CONSOLIDATION = 'on'
  assert.ok(!names(make(true)).includes('memory-auto-capture'))
  assert.ok(!names(make(false, true)).includes('session-consolidation'))
  const ctx = createRuntimeHookContext(capture.buildRuntimeSnapshot())
  await capture.runtimeHooks.runPostTool(ctx, { name: 'write_file', success: true, target: 'src/a.ts' })
  await capture.runtimeHooks.runPostSession(ctx)
  assert.equal(requests, 1)
  assert.equal(received[0]?.aborted, true, 'the hook lifetime reaches the actual production stream')
  await off.runtimeHooks.runPostTool(createRuntimeHookContext(off.buildRuntimeSnapshot()), { name: 'write_file', success: true, target: 'src/a.ts' })
  await off.runtimeHooks.runPostSession(createRuntimeHookContext(off.buildRuntimeSnapshot()))
  assert.equal(requests, 1, 'disabled production wiring cannot call a memory model')
  for (const agent of [capture, consolidation]) {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let transportSignal: AbortSignal | undefined
    agent.config.compactClient!.stream = async (_request, cb, signal) => {
      transportSignal = signal; entered(); await gate
      cb.onTextDelta('[]'); cb.onStopReason('end_turn', { input_tokens: 1 })
    }
    const parent = new AbortController()
    const ctx = createRuntimeHookContext(agent.buildRuntimeSnapshot(), {}, parent.signal)
    if (agent === capture) await agent.runtimeHooks.runPostTool(ctx, { name: 'write_file', success: true, target: 'src/b.ts' })
    else agent.session.addUserMessage('A controlled transcript for session consolidation. '.repeat(8))
    const pending = agent.runtimeHooks.runPostSession(ctx)
    await started
    parent.abort()
    await pending
    const cancelled = transportSignal?.aborted
    release()
    assert.equal(cancelled, true, 'parent cancellation must reach the actual memory transport before it returns')
  }
})
