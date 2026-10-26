import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersist } from '../session-persist.js'
import { createTelemetryWriter } from '../telemetry-writer.js'
import { observeAgentRuntimeRun } from '../runtime-run-observation.js'
import { beginCallAudit } from '../../api/call-audit.js'
import { runtimeObservation } from '../../utils/runtime-provenance.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import { extractTaskContract } from '../../context/task-contract.js'

test('resumed session persists each run identity without relabeling old telemetry or attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-run-observation-'))
  const oldHome = process.env.RIVET_HOME, oldSessions = process.env.RIVET_SESSION_DIR
  process.env.RIVET_HOME = root; process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  try {
    const persist = new SessionPersist('session', root)
    persist.initMetadata()
    const telemetryWriter = createTelemetryWriter(root, 'session')
    const agent = { config: { sessionId: 'session' }, persist, telemetryWriter } as Pick<AgentLoop, 'config' | 'persist' | 'telemetryWriter'>
    for (const runId of ['first', 'resumed']) await observeAgentRuntimeRun(agent, runId, async () => {
      const audit = beginCallAudit({ sessionId: 'session', purpose: 'main_execution', requestId: runId + '-request', attemptId: runId + '-attempt' })
      audit.finish({ status: 'complete' })
      assert.equal(runtimeObservation().attemptId, runId + '-attempt')
      telemetryWriter.write({ kind: 'phase-source', turn: 1 })
    })
    await persist.flushSessionBuffer(); await telemetryWriter.flush()
    assert.equal(persist.loadMetadata()?.lastRuntimeRun?.runId, 'resumed')
    const rows = readFileSync(join(root, 'sessions', 'session', 'sensorium.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.filter(r => r.kind === 'runtime-run').map(r => r.runId), ['first', 'resumed'])
    assert.deepEqual(rows.filter(r => r.kind === 'phase-source').map(r => r.attemptId), ['first-attempt', 'resumed-attempt'])
    const calls = readFileSync(join(root, 'logs', 'provider-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls[0].runId, 'first'); assert.equal(calls.at(-1).runId, 'resumed')
    assert.ok(calls.every(row => row.runtime.buildId === 'unknown'), 'source mode never invents a build')
  } finally {
    if (oldHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = oldHome
    if (oldSessions === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = oldSessions
    rmSync(root, { recursive: true, force: true })
  }
})

test('the actual AgentLoop run boundary reaches provider callbacks with its observed run id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'actual-runtime-run-'))
  const oldHome = process.env.RIVET_HOME, oldSessions = process.env.RIVET_SESSION_DIR, oldExperiment = process.env.RIVET_READONLY_ADVICE_EXPERIMENT
  process.env.RIVET_HOME = root; process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  process.env.RIVET_READONLY_ADVICE_EXPERIMENT = '1'
  let agent: AgentLoop | undefined
  try {
    const seen: string[] = []
    const engine = new PromptEngine({ model: 'fixture-model', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd: root } })
    agent = new AgentLoop({ sessionId: 'actual-run', promptEngine: engine, toolRegistry: new ToolRegistry(), maxTurns: 3,
      intentRetrievalRouter: { enabled: true, classifier: 'heuristic' },
      contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'fixture' },
      client: { stream: async (_request, callbacks) => {
        assert.equal(runtimeObservation().runId, agent!.getRunId())
        assert.equal(runtimeObservation().sessionId, 'actual-run')
        seen.push(runtimeObservation().runId!)
        callbacks.onContentBlock({ type: 'text', text: 'observed' }); callbacks.onTextDelta('observed')
        callbacks.onStopReason('end_turn', { input_tokens: 10, output_tokens: 1 })
      } },
    }, new SessionContext(), root)
    for (let i = 0; i < 2; i++) await agent.run('只读解释，不修改文件', {
      onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {},
      onApprovalRequired: async () => false, onError: error => { throw error },
    })
    await agent.drainPersistWrites(); await agent.telemetryWriter.flush()
    assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1])
    assert.equal(agent.persist?.loadMetadata()?.lastRuntimeRun?.runId, seen[1])
    assert.equal(agent.workFacts.explicitNoMutation, true, 'trusted human boundary supplies the readonly constraint')
    const explanation = '只读解释 src/agent/loop.ts 的作用'
    agent.taskContract = extractTaskContract(explanation, 1)
    await agent.intentRoute.buildForTurn(explanation, true)
    // Invoke the actual assembled consumer, so dropping the optional getter in
    // loop-factory cannot pass merely because the standalone helper still works.
    const hooks = Reflect.get(agent.runtimeHooks, 'postTurnHooks') as Array<{ name: string; run(ctx: unknown): void }>
    hooks.find(hook => hook.name === 'self-verify')!.run({ snapshot: { ...agent.buildRuntimeSnapshot(), turn: 3,
      recentToolHistory: [{ tool: 'read_file', status: 'success', target: 'a.ts' }] } })
    await agent.telemetryWriter.flush()
    const telemetry = readFileSync(join(root, 'sessions', 'actual-run', 'sensorium.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(telemetry.some(event => event.kind === 'advice-relevance' && event.decision === 'eligible'))
    agent._lastRetrievalRoute = { ...agent._lastRetrievalRoute!, confidence: 0.3 }
    hooks.find(hook => hook.name === 'self-verify')!.run({ snapshot: { ...agent.buildRuntimeSnapshot(), turn: 4,
      recentToolHistory: [{ tool: 'read_file', status: 'success', target: 'a.ts' }] } })
    await agent.telemetryWriter.flush()
    const uncertain = readFileSync(join(root, 'sessions', 'actual-run', 'sensorium.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(uncertain.filter(event => event.kind === 'advice-relevance').at(-1)?.decision, 'unknown', 'low-confidence classification cannot suppress advice')
    await agent.intentRoute.buildForTurn(explanation, true)
    agent.taskContract = undefined
    await agent.intentRoute.buildForTurn('只读运行测试，核实结果', true)
    hooks.find(hook => hook.name === 'self-verify')!.run({ snapshot: { ...agent.buildRuntimeSnapshot(), turn: 5,
      recentToolHistory: [{ tool: 'read_file', status: 'success', target: 'a.ts' }] } })
    await agent.telemetryWriter.flush()
    const after = readFileSync(join(root, 'sessions', 'actual-run', 'sensorium.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(after.filter(event => event.kind === 'advice-relevance').at(-1)?.decision, 'unknown', 'a stale prior route cannot suppress current advice')
  } finally {
    agent?.stopFsWatcher(); agent?.stopConfigWatcher()
    if (oldHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = oldHome
    if (oldSessions === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = oldSessions
    if (oldExperiment === undefined) delete process.env.RIVET_READONLY_ADVICE_EXPERIMENT; else process.env.RIVET_READONLY_ADVICE_EXPERIMENT = oldExperiment
    rmSync(root, { recursive: true, force: true })
  }
})
