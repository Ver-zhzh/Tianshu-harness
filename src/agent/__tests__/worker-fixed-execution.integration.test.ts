import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerSchema, configSchema } from '../../config/schema.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder, type WorkOrder } from '../work-order.js'
import { runWorkerSession, type WorkerSessionConfig } from '../worker-session.js'
import { SessionPersist, getSessionDir } from '../session-persist.js'
import { WorkerTerminalPolicy } from '../worker-terminal-policy.js'
import { createOopRunnerWithFallback } from '../worker-process/parent.js'
import { createWorkerRuntimeFactory } from '../worker-runtime.js'
import { DelegationCoordinator } from '../coordinator.js'
import { profileRegistry } from '../profile-registry.js'
import { buildModelCards } from '../../model/capability.js'
import { createHeadlessCoordinator } from '../headless-coordinator.js'

const root = mkdtempSync(join(tmpdir(), 'fixed-execution-integration-'))
process.env.RIVET_HOME = join(root, 'home')
process.env.RIVET_SESSION_DIR = join(root, 'sessions')
mkdirSync(process.env.RIVET_HOME, { recursive: true })
writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
const provider = providerSchema.parse({ name: 'third-party', apiKey: 'fixture', capabilities: { effortFormat: 'reasoning_effort', thinkingBlock: 'enabled' }, baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'exact-main', maxTokens: 4096, contextWindow: 64000 }] })
const report = (id: string) => JSON.stringify({ workOrderId: id, status: 'passed', summary: 'captured report', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' })
function order(id: string): WorkOrder {
  return createReadOnlyWorkOrder({ id, parentTurnId: id, profile: 'code_scout', kind: 'code_search', objective: `Inspect the fixed execution boundary for ${id}`, scope: {}, budget: { maxTurns: 2, maxRetries: 20, timeoutMs: 60_000 } })
}
function config(id: string): WorkerSessionConfig {
  const registry = new ToolRegistry()
  return { order: order(id), client: createProviderClient(provider, resolveCapabilities('third-party', provider.capabilities), { apiKey: 'fixture', model: 'exact-main', maxTokens: 4096, reasoningEffort: 'high', singleAttempt: true, credentialScope: 'third-party:default' }),
    promptEngine: new PromptEngine({ model: 'exact-main', maxTokens: 4096, staticCtx: { tools: [], audience: 'subagent' }, volatileCtx: { cwd: root } }),
    toolRegistry: registry, cwd: root, providerName: provider.name, maxTurns: 2, contextWindow: 64000, compact: { enabled: false, model: 'flash' }, sessionNonce: id,
  }
}
function response(text: string, tool = false): Response {
  const delta = tool ? { tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a.ts"}' } }] } : { content: text }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
async function fetched(run: (calls: Record<string, unknown>[]) => Promise<void>, answer: (call: Record<string, unknown>) => Response | Promise<Response>) {
  const original = globalThis.fetch, calls: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); calls.push(body); return answer(body) }
  try { await run(calls) } finally { globalThis.fetch = original }
}

for (const status of [429, 500, 503, 400]) {
  test(`real worker HTTP ${status}: one send, no report repair, retained terminal metadata`, async () => fetched(async calls => {
    const c = config(`http-${status}`)
    let repairs = 0
    c.reportRepairClient = { stream: async () => { repairs++ } }
    const run = await runWorkerSession(c)
    assert.equal(calls.length, 1)
    assert.equal(repairs, 0)
    assert.equal(run.result.terminalFailure, true)
    assert.equal(run.result.status, 'blocked')
    assert.deepEqual(run.usage.observation?.fields, {})
    const meta = new SessionPersist(`worker-${c.order.id}-${c.sessionNonce}`, root).loadMetadata()
    assert.equal(meta?.status, 'completed')
    assert.ok(run.prefixProof?.options)
  }, () => new Response('fixture failure', { status })))
}

test('real worker network exception retains partial transcript and never re-enters model execution', async () => fetched(async calls => {
  const run = await runWorkerSession(config('network-failure'))
  assert.equal(calls.length, 1)
  assert.equal(run.result.terminalFailure, true)
  assert.ok(run.transcript.errors.some(error => /network/i.test(error)))
}, () => { throw new TypeError('fixture network failure') }))

test('headless dispatch checks the latest root credential principal at the actual HTTP boundary', async () => fetched(async calls => {
  let reads = 0
  const cfg = configSchema.parse({ provider: { default: provider.name, providers: { 'third-party': provider } } })
  const coordinator = createHeadlessCoordinator({ toolRegistry: new ToolRegistry(), provider, providerName: provider.name, currentModelId: 'exact-main',
    config: cfg, apiKey: 'fixture', cwd: root, sessionId: 'headless-root', getRootCredentialPrincipal: () => { reads++; return 'different-root-principal' } })
  try {
    const run = await coordinator.delegate({ parentTurnId: 'headless-task', objective: 'Inspect the exact credential owner inherited from the root headless session', kind: 'code_search', profile: 'code_scout', scope: {} })
    assert.equal(calls.length, 0, 'changed root account must fail before any HTTP')
    assert.equal(reads, 1)
    assert.equal(run.results[0]?.terminalFailure, true)
    assert.equal(run.results[0]?.failureStage, 'continuity')
  } finally { coordinator.shutdown() }
}, () => response(report('headless-task'))))

// Anonymized counts from the nine audited continuations. Requests use tiny synthetic messages.
for (const [index, misses] of [53785, 51890, 38304, 35488, 38391, 79149, 80256, 55704, 68825].entries()) {
  test(`continuation sample ${index + 1} (${misses} historical misses): budget failure sends no continuation`, async () => fetched(async calls => {
    const c = config(`budget-${index}`)
    c.order = { ...c.order, budget: { ...c.order.budget, maxTurns: 1 } }
    c.toolRegistry.register({ definition: { name: 'read_file', description: 'fixture read', input_schema: { type: 'object', properties: {} } }, execute: async () => ({ content: 'partial evidence' }), requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true })
    c.promptEngine.updateTools(c.toolRegistry.getDefinitions())
    const run = await runWorkerSession(c)
    assert.equal(calls.length, 1, 'no closing, repair or budget continuation HTTP')
    assert.equal(run.result.terminalFailure, true)
    assert.ok(['max_turns', 'stalled'].includes(run.result.failureReason ?? ''))
    assert.ok(run.transcript.toolResults.length > 0, 'completed evidence retained')
  }, () => response('', true)))
}

test('explicit successful continuation restores actual effort and full wire prefix', async () => fetched(async calls => {
  const c = config('manual-continuation')
  const first = await runWorkerSession(c)
  assert.equal(first.result.status, 'passed')
  const restored = config('manual-continuation')
  restored.client.setReasoningEffort?.('low')
  restored.order = { ...restored.order, objective: 'Explicitly inspect one additional call site' }
  restored.priorMessages = first.session.getMessages()
  restored.priorFrozenSnapshot = first.frozenSnapshot
  restored.priorPrefixProof = first.prefixProof
  const second = await runWorkerSession(restored)
  assert.equal(second.result.status, 'passed', second.result.summary)
  assert.equal(calls.length, 2)
  const previous = calls[0]!.messages as unknown[]
  assert.deepEqual((calls[1]!.messages as unknown[]).slice(0, previous.length), previous)
  assert.deepEqual(calls[1]!.tools, calls[0]!.tools)
  assert.equal(calls[1]!.reasoning_effort, calls[0]!.reasoning_effort)
}, () => response(report('manual-continuation'))))

test('terminal task survives coordinator recreation and changed nonce/model request; siblings remain independent', () => {
  const original = order('failed-node')
  const first = new WorkerTerminalPolicy('root-user-session')
  const release = first.begin(original)
  first.finish(original, [{ workOrderId: original.id, status: 'failed', summary: 'fixture validation failed', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'failed' }])
  release()
  const restored = new WorkerTerminalPolicy('root-user-session')
  assert.throws(() => restored.begin({ ...original, id: 'new-nonce', parentTurnId: 'new-dispatch', modelOverride: { provider: 'third-party', model: 'other-model' } }), /terminal/)
  restored.begin(order('independent-sibling'))()
})

test('isolated entry unavailable never falls back to in-process worker', async () => fetched(async calls => {
  await assert.rejects(createOopRunnerWithFallback({ entryOverride: null, getMemoryBlock: () => undefined })(config('missing-isolated-entry')))
  assert.equal(calls.length, 0)
}, () => response('unused')))

test('fixed unavailable binding is blocked before worker startup; no recommendation or HTTP', async () => fetched(async calls => {
  const cfg = configSchema.parse({ provider: { providers: { [provider.name]: provider }, default: provider.name }, agent: { review: { profiles: { code_scout: { provider: 'deleted-provider', model: 'deleted-model' } } } } })
  const runtime = createWorkerRuntimeFactory(() => ({ config: cfg, cwd: root, provider, apiKey: 'fixture', auth: undefined, currentModelId: 'exact-main', rootSessionId: 'blocked-binding', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [] }))
  const registry = new ToolRegistry()
  for (const name of profileRegistry.get('code_scout')!.allowedTools) registry.register({ definition: { name, description: 'fixture', input_schema: { type: 'object', properties: {} } }, execute: async () => ({ content: '' }), requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true })
  let starts = 0
  const coordinator = new DelegationCoordinator({ baseToolRegistry: registry, modelCards: buildModelCards(provider), maxWorkers: 1, selectModel: runtime.selectModel, runtimeFactory: runtime.runtimeFactory, runWorker: async () => { starts++; throw new Error('must not start') } })
  const run = await coordinator.delegate({ parentTurnId: 'blocked-preflight', profile: 'code_scout', kind: 'code_search', objective: 'Inspect a fixed unavailable binding without automatic selection', scope: {} })
  assert.equal(starts, 0)
  assert.equal(calls.length, 0)
  assert.equal(run.results[0]?.status, 'blocked')
  assert.match(run.results[0]!.summary, /provider_deleted/)
  coordinator.shutdown()
}, () => response('unused')))

test('actual coordinator starts a failed worker once; new nonce cannot repeat it while a sibling remains independent', async () => fetched(async calls => {
  const cfg = configSchema.parse({ provider: { providers: { [provider.name]: provider }, default: provider.name } })
  const rootSessionId = 'single-start-parent'
  const runtime = createWorkerRuntimeFactory(() => ({ config: cfg, cwd: root, provider, apiKey: 'fixture', auth: undefined, currentModelId: 'exact-main', rootSessionId, listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [] }))
  const registry = new ToolRegistry()
  for (const name of profileRegistry.get('code_scout')!.allowedTools) registry.register({ definition: { name, description: 'fixture', input_schema: { type: 'object', properties: {} } }, execute: async () => ({ content: '' }), requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true })
  let starts = 0
  const coordinator = new DelegationCoordinator({ baseToolRegistry: registry, modelCards: buildModelCards(provider), maxWorkers: 1, sessionId: rootSessionId, selectModel: runtime.selectModel, runtimeFactory: runtime.runtimeFactory, runWorker: async config => { starts++; return runWorkerSession(config) } })
  const base = { parentTurnId: 'first', profile: 'code_scout', kind: 'code_search' as const, objective: 'Inspect the exact same task under terminal failure protection', scope: {}, budget: { maxRetries: 20 } }
  const first = await coordinator.delegate(base)
  assert.equal(first.results[0]?.terminalFailure, true)
  assert.equal(starts, 1)
  assert.equal(calls.length, 1)
  await coordinator.delegate({ ...base, parentTurnId: 'changed-nonce', modelOverride: { provider: provider.name, model: 'exact-main' } })
  assert.equal(starts, 1)
  assert.equal(calls.length, 1)
  await coordinator.delegate({ ...base, parentTurnId: 'sibling', objective: 'Inspect a different independent task without reusing the failed task' })
  assert.equal(starts, 2)
  assert.equal(calls.length, 2)
  coordinator.shutdown()
}, () => new Response('fixture failure', { status: 500 })))

test('interrupted durable task lease blocks redispatch even without a failure receipt', () => {
  const failed = order('interrupted-node')
  const original = new WorkerTerminalPolicy('interrupted-parent')
  const release = original.begin(failed)
  release() // Simulate a crashed owner: no successful receipt was committed.
  const restarted = new WorkerTerminalPolicy('interrupted-parent')
  assert.throws(() => restarted.begin({ ...failed, id: 'changed-id' }), /terminal/)
})

test('resume recovers complete diagnostic snapshot; incomplete legacy evidence blocks', async () => fetched(async () => {
  const c = config('snapshot-recovery'), completed = await runWorkerSession(c)
  const persist = new SessionPersist('snapshot-recovery-main', root)
  const frozen = { ...completed.frozenSnapshot!, executionSnapshot: undefined }
  persist.writeFrozenSnapshot(frozen)
  const logDir = join(getSessionDir(root), 'snapshot-recovery-main')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'cache-log.jsonl'), JSON.stringify({ status: 'complete', executionSnapshot: completed.prefixProof }) + '\n')
  assert.deepEqual(persist.readFrozenSnapshot()?.executionSnapshot, completed.prefixProof)
  writeFileSync(join(logDir, 'cache-log.jsonl'), '{"input":100,"wire":{"options":{"reasoning_effort":"high"}}}\n')
  assert.throws(() => persist.readFrozenSnapshot(), /禁止静默冷启动/)
  await persist.appendOaiWithChecksum({ role: 'assistant', content: 'previous response' })
  await persist.flushSessionBuffer()
  writeFileSync(join(logDir, 'cache-log.jsonl'), '')
  assert.throws(() => persist.readFrozenSnapshot(), /禁止静默冷启动/, 'lost usage logs are not proof that no request was ever sent')
  const empty = new SessionPersist('empty-main', root)
  empty.appendModelSwitch({ to: 'exact-main' })
  await empty.flushSessionBuffer()
  assert.equal(empty.readFrozenSnapshot(), undefined, 'a model selection alone is not an already-sent conversation')
}, () => response(report('snapshot-recovery'))))

test('cold-start consent bypasses the evidence gate; env var covers CLI; without consent it stays fail-closed', async () => fetched(async () => {
  const c = config('cold-start-consent'), completed = await runWorkerSession(c)
  // 证据不完整（executionSnapshot 缺）+ 有请求史 → 门 fail-closed
  const persist = new SessionPersist('cold-start-main', root)
  persist.writeFrozenSnapshot({ ...completed.frozenSnapshot!, executionSnapshot: undefined })
  const logDir = join(getSessionDir(root), 'cold-start-main')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'cache-log.jsonl'), '{"input":100}\n')
  assert.throws(() => persist.readFrozenSnapshot(), /禁止静默冷启动/)
  // 用户显式确认（meta.coldStartConsentAt）→ 门绕行，返回 undefined = 全新装配
  persist.initMetadata()
  persist.markColdStartConsent()
  assert.equal(persist.hasColdStartConsent(), true)
  assert.equal(persist.readFrozenSnapshot(), undefined, '同意后证据门必须绕行')
  // env 逃生通道（CLI/TUI 无按钮可点）
  const noConsent = new SessionPersist('cold-start-env', root)
  noConsent.writeFrozenSnapshot({ ...completed.frozenSnapshot!, executionSnapshot: undefined })
  const envLogDir = join(getSessionDir(root), 'cold-start-env')
  mkdirSync(envLogDir, { recursive: true })
  writeFileSync(join(envLogDir, 'cache-log.jsonl'), '{"input":100}\n')
  assert.throws(() => noConsent.readFrozenSnapshot(), /禁止静默冷启动/)
  const saved = process.env.RIVET_ALLOW_COLD_START
  process.env.RIVET_ALLOW_COLD_START = '1'
  try {
    assert.equal(noConsent.readFrozenSnapshot(), undefined, 'RIVET_ALLOW_COLD_START 必须绕行')
  } finally {
    if (saved === undefined) delete process.env.RIVET_ALLOW_COLD_START
    else process.env.RIVET_ALLOW_COLD_START = saved
  }
}, () => response(report('cold-start-consent'))))
