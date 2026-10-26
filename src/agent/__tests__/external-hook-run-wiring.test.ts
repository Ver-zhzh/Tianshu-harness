import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { createPerceptionRuntimeHook } from '../hooks/perception-hook.js'
import { createUserHooksBridge } from '../hooks/user-hooks-bridge.js'
import { ExternalHookHost } from '../../hooks/external-hook-host.js'
import type { AgentCallbacks } from '../loop-types.js'

process.env.RIVET_TRUST_PROJECT = '1'
test('AgentLoop consumes one host binding and starts the next stream after external cancellation', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-run-wire-'))
  const host = new ExternalHookHost()
  const events: string[] = []
  let streams = 0, registrations = 0
  let agent: AgentLoop | undefined
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'hook.sh'), '#!/bin/sh\nif [ ! -f ready ]; then\n echo ready > ready\n sleep 5\n echo WRONG >late\nelse\n echo new\nfi\n')
    await chmod(join(cwd, 'hook.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'hook.sh' }] }))
    const registry = new ToolRegistry()
    agent = new AgentLoop({ externalHookHost: { createRuntime(binding) { registrations++; return host.createRuntime(binding) }, shutdown: () => host.shutdown(), forceExit: () => host.forceExit() },
      client: { async stream(_request, cb) { streams++; cb.onTextDelta('new stream'); cb.onContentBlock({ type: 'text', text: 'new stream' }); cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 }) } },
      promptEngine: new PromptEngine({ model: 'fixture', maxTokens: 128, staticCtx: { tools: [] }, volatileCtx: { cwd } }),
      toolRegistry: registry, maxTurns: 1, contextWindow: 100_000, compact: { enabled: false, model: 'fixture', autoThreshold: 90_000, autoFloor: 80_000 },
      fsWatcherEnabled: false, crossSessionEnabled: false,
    }, new SessionContext(), cwd)
    const current = agent
    agent.runtimeHooks = new RuntimeHookPipeline([createPerceptionRuntimeHook(), ...createUserHooksBridge({ cwd,
      runtime: agent.config.externalHookRuntime, getTurn: () => current.session.getTurnCount(), getRunId: () => current.getRunId() })])
    const callbacks: AgentCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
      onAbort: () => { events.push('aborted') }, onError: error => { events.push(error.message) }, onApprovalRequired: async () => true }
    const old = agent.run('old', callbacks)
    const deadline = Date.now() + 3_000
    while (!await readFile(join(cwd, 'ready')).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10))
    }
    agent.abort(); await old
    const previous = agent.getRunId()
    await agent.run('new', callbacks)
    assert.notEqual(agent.getRunId(), previous)
    assert.equal(registrations, 1)
    assert.equal(streams, 1)
    assert.ok(events.includes('aborted'))
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
  } finally {
    agent?.abort(); await host.shutdown(); await agent?.drainPostSession(); await agent?.cancelIdleCompaction()
    agent?.stopConfigWatcher(); await agent?.drainPersistWrites()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
