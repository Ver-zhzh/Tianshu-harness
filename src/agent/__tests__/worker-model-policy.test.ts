import { DISABLED_USER_INSTRUCTIONS, createUserInstructionsSnapshot } from '../../prompt/user-instructions.js'
import { DelegationCoordinator } from '../coordinator.js'
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configSchema, providerSchema, type Config, type ProviderConfig, type ModelTarget } from '../../config/schema.js'
import { buildWorkerRuntime, createWorkerRuntimeFactory, type WorkerRuntimeDeps } from '../worker-runtime.js'
import { workerModelPolicy } from '../worker-model-policy.js'
import { resolveModelBinding, modelBindingAvailability, snapshotSessionBinding } from '../../model/model-binding.js'
import { buildModelCards } from '../../model/capability.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder, deriveWorkerSessionId, type WorkOrder } from '../work-order.js'
import { runWorkerSession } from '../worker-session.js'
import { runWorkerSessionOop } from '../worker-process/parent.js'
import { getSessionDir } from '../session-persist.js'
import { OAuthAuth } from '../../auth/oauth-auth.js'
import { mock } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'worker-model-policy-'))
const previousSessionDir = process.env.RIVET_SESSION_DIR
const previousConfigPath = process.env.RIVET_CONFIG_PATH
const calls: { model: string; authorization: string | undefined; path: string | undefined; hasNestedRules: boolean }[] = []
let baseUrl = ''
let currentOrder: WorkOrder
let nestedMode = false
let delegated = false
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  calls.push({ model: input.model, authorization: req.headers.authorization, path: req.url, hasNestedRules: JSON.stringify(input.messages).includes('PINNED_NESTED_RULE') })
  const prompt = input.messages.map((message: { content?: unknown }) => typeof message.content === 'string' ? message.content : '').join('\n')
  const workOrderId = prompt.match(/\u5de5\u5355 ID[^:\uff1a\n]*[:\uff1a]([^\s\n]+)/)?.[1] ?? currentOrder?.id ?? 'test'
  if (nestedMode && input.model === 'other-flash' && !delegated) {
    delegated = true
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'nested-binding', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ objective: 'Check the exact root model binding', kind: 'code_search', profile: 'code_scout' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    return
  }
  const content = JSON.stringify({ workOrderId, status: 'passed', summary: 'Verified model binding', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
})
before(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  process.env.RIVET_CONFIG_PATH = join(dir, 'fixture.json')
})
after(async () => {
  await new Promise<void>(done => server.close(() => done()))
  if (previousSessionDir === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previousSessionDir
  if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previousConfigPath
  rmSync(dir, { recursive: true, force: true })
})

function provider(name = 'third-party', extra: Record<string, unknown> = {}): ProviderConfig {
  return providerSchema.parse({ name, apiKey: 'fixture-main', baseUrl, models: [
    { id: 'other-flash', contextWindow: 64000, maxTokens: 8192 },
    { id: 'exact-main', contextWindow: 200000, maxTokens: 32768 },
  ], ...extra })
}
function deps(configure?: (cfg: Config) => void): WorkerRuntimeDeps {
  const main = provider()
  const cfg = configSchema.parse({ provider: { default: main.name, providers: { [main.name]: main, missing: provider('missing', { apiKey: undefined, apiKeyEnv: 'TIANSHU_FIXTURE_ABSENT' }) } }, workers: { routing: {}, profiles: {} } })
  configure?.(cfg)
  return { getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: cfg, cwd: dir, provider: main, apiKey: 'fixture-main', auth: undefined, currentModelId: 'exact-main', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: ['patcher'] }
}
function order(profile = 'code_scout', target?: ModelTarget): WorkOrder {
  return createReadOnlyWorkOrder({ parentTurnId: `turn-${Math.random()}`, kind: 'doc_research', objective: 'Verify model selection', profile, scope: {}, modelOverride: target })
}
const registry = new ToolRegistry()
function runtime(d: WorkerRuntimeDeps, o = order()) { return buildWorkerRuntime(d, o, buildModelCards(d.provider)[0]!, registry) }
async function send(config: ReturnType<typeof runtime>) {
  currentOrder = config.order
  await config.client.stream({ model: config.promptEngine.getModel(), messages: [{ role: 'user', content: 'fixture' }], tools: [] }, {
    onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error },
  })
  return calls.at(-1)!
}

test('unconfigured roles follow exact root model despite candidate order and tier', async () => {
  for (const profile of ['reviewer', 'adversarial_verifier', 'verifier', 'patcher', 'code_scout', 'doc_scout', 'council_expert']) {
    const d = deps(); d.provider.models.reverse()
    const cfg = runtime(d, order(profile))
    const request = await send(cfg)
    assert.equal(request.model, 'exact-main')
    assert.equal(request.authorization, 'Bearer fixture-main')
    assert.equal(cfg.runtimeDecision?.strategy, 'session')
    assert.equal(cfg.contextWindow, 200000)
  }
})
test('explicit follow bypasses fixed task routes; deleting the override would be wrong', async () => {
  const d = deps(cfg => { cfg.agent.review.profiles.code_scout = { strategy: 'session' }; cfg.workers.routing.repo_summarization = 'legacy'; cfg.workers.profiles.legacy = { provider: 'third-party', model: 'other-flash' } })
  const cfg = runtime(d)
  assert.equal((await send(cfg)).model, 'exact-main')
  assert.equal(cfg.runtimeDecision?.source, 'role')
})
test('invalid explicit targets block before HTTP and never fall back to main', async () => {
  for (const [target, reason] of [
    [{ provider: 'missing', model: 'other-flash' }, 'missing_credentials'],
    [{ provider: 'deleted', model: 'other-flash' }, 'provider_deleted'],
    [{ provider: 'third-party', model: 'deleted' }, 'model_deleted'],
  ] as const) {
    const d = deps(cfg => { cfg.agent.review.profiles.code_scout = target; cfg.workers.defaultStrategy = 'auto' })
    const before = calls.length
    assert.throws(() => runtime(d), new RegExp(reason))
    assert.equal(calls.length, before)
  }
})
test('precedence is order, role, task, default; automatic is an explicit policy', () => {
  const d = deps(cfg => { cfg.workers.defaultStrategy = 'auto'; cfg.workers.routing.repo_summarization = { strategy: 'session' }; cfg.agent.review.profiles.code_scout = { strategy: 'auto' } })
  assert.equal(workerModelPolicy(d.config, order()).source, 'role')
  assert.equal(workerModelPolicy(d.config, order('code_scout', { strategy: 'session' })).source, 'order')
  delete d.config.agent.review.profiles.code_scout
  assert.equal(workerModelPolicy(d.config, order()).source, 'task')
  delete d.config.workers.routing.repo_summarization
  assert.deepEqual(workerModelPolicy(d.config, order()).target, { strategy: 'auto' })
  assert.equal(runtime(d).runtimeDecision?.model, 'other-flash')
})
test('multi-key same-name models preserve exact root ownership and fixed overrides', async () => {
  const d = deps(cfg => { cfg.provider.providers['third-party'] = provider('third-party', { keys: [
    { id: 'account-a', apiKey: 'fixture-a', models: [{ id: 'exact-main', contextWindow: 32000, maxTokens: 2048 }] },
    { id: 'account-b', apiKey: 'fixture-b', models: [{ id: 'exact-main', contextWindow: 150000, maxTokens: 16384 }] },
  ] }) })
  d.provider = d.config.provider.providers['third-party']!; d.apiKey = 'fixture-b'
  const root = runtime(d)
  assert.equal((await send(root)).authorization, 'Bearer fixture-b')
  assert.equal(root.contextWindow, 150000)
  assert.equal(root.runtimeDecision?.keyId, 'account-b')
  const fixed = runtime(d, order('code_scout', { provider: 'third-party', model: 'exact-main', keyId: 'account-a' }))
  assert.equal((await send(fixed)).authorization, 'Bearer fixture-a')
  assert.equal(fixed.contextWindow, 32000)
})
test('keyless, env credentials, cross-provider names and OAuth readiness use shared resolver', () => {
  const d = deps()
  d.config.provider.providers.local = provider('local', { apiKey: undefined, baseUrl: 'http://localhost:11434/v1' })
  assert.equal(resolveModelBinding(d.config.provider.providers, { provider: 'local', model: 'exact-main' }).apiKey, '')
  process.env.TIANSHU_MODEL_FIXTURE = 'fixture-env'
  try {
    d.config.provider.providers.env = provider('env', { apiKey: undefined, apiKeyEnv: 'TIANSHU_MODEL_FIXTURE' })
    assert.equal(resolveModelBinding(d.config.provider.providers, { provider: 'env', model: 'exact-main' }).apiKey, 'fixture-env')
  } finally { delete process.env.TIANSHU_MODEL_FIXTURE }
  d.config.provider.providers.oauth = provider('oauth', { apiKey: undefined, auth: { type: 'oauth', provider: 'codex' } })
  const oauth = mock.method(OAuthAuth.prototype, 'isAuthenticated', () => false)
  try {
    assert.equal(modelBindingAvailability(d.config.provider.providers, { provider: 'oauth', model: 'exact-main' }).reason, 'oauth_not_authenticated')
    oauth.mock.mockImplementation(() => true)
    assert.ok(resolveModelBinding(d.config.provider.providers, { provider: 'oauth', model: 'exact-main' }).auth)
  } finally { oauth.mock.restore() }
})
test('dispatch snapshot pins retries; later dispatch reads changed model and saved strategy', () => {
  const d = deps(), factory = createWorkerRuntimeFactory(() => d), first = order()
  assert.equal(factory.selectModel(first)?.model, 'exact-main')
  d.currentModelId = 'other-flash'; d.config.workers.defaultStrategy = 'auto'
  assert.equal(factory.runtimeFactory(first, buildModelCards(d.provider)[0]!, registry).runtimeDecision?.model, 'exact-main')
  const next = order()
  assert.equal(factory.selectModel(next), undefined)
  d.config.workers.defaultStrategy = 'session'
  assert.equal(factory.selectModel(order())?.model, 'other-flash')
})
test('root unavailable fails closed rather than choosing another model', () => {
  const d = deps(); d.currentModelId = 'deleted'
  assert.throws(() => runtime(d), /model_deleted/)
})
test('nested follow uses root snapshot even when parent worker is fixed to another model', async () => {
  const d = deps(), root = snapshotSessionBinding(d.provider, 'exact-main', d.apiKey)
  d.currentModelId = 'other-flash'; d.rootSessionBinding = root
  assert.equal((await send(runtime(d))).model, 'exact-main')
})
test('actual worker request and persisted metadata use final decision', async () => {
  const cfg = runtime(deps(), order('code_scout', { provider: 'third-party', model: 'exact-main' }))
  cfg.maxTurns = 1; cfg.sessionNonce = 'policytest'; currentOrder = cfg.order
  await runWorkerSession(cfg)
  assert.equal(calls.at(-1)?.model, 'exact-main')
  const meta = JSON.parse(readFileSync(join(getSessionDir(dir), `${deriveWorkerSessionId(cfg.order.id, cfg.sessionNonce)}.meta.json`), 'utf8'))
  assert.equal(meta.model, 'exact-main')
  assert.equal(meta.modelSelection.fallbackReason, undefined)
  assert.equal(meta.modelSelection.strategy, 'fixed')
})
test('real isolated worker reconstructs root binding instead of global default', async () => {
  const d = deps(); d.config.provider.default = 'missing'
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const cfg = runtime(d); cfg.maxTurns = 1; cfg.sessionNonce = 'isolated'; currentOrder = cfg.order
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.at(-1)?.model, 'exact-main')
  assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-main')
  assert.notEqual(result.result.failureReason, 'worker_crash')
})

test('coordinator dispatch reports actual model and bypasses tier recommendation for follow', async () => {
  const d = deps(cfg => { cfg.agent.review.profiles.code_scout = { strategy: 'session' }; cfg.workers.escalationCap = 'strong' })
  const factory = createWorkerRuntimeFactory(() => d)
  const coordinator = new DelegationCoordinator({
    modelCards: buildModelCards(d.provider), baseToolRegistry: registry, maxWorkers: 1,
    runtimeFactory: factory.runtimeFactory, selectModel: factory.selectModel,
    runWorker: async cfg => {
      currentOrder = cfg.order
      cfg.maxTurns = 1
      const result = await runWorkerSession(cfg)
      cfg.onActivity?.('lifecycle', 'selected')
      return result
    },
  })
  const activities: { model?: string; provider?: string }[] = []
  try {
    const run = await coordinator.delegate({ parentTurnId: 'routing-coordinator', kind: 'code_search', profile: 'code_scout', objective: 'Verify the exact main model binding through dispatch', scope: {}, tierFloor: 'strong', onActivity: event => activities.push(event) })
    assert.equal(run.selectedModel, 'exact-main')
    assert.equal(run.results[0]?.model, 'exact-main')
    assert.equal(activities[0]?.model, 'exact-main')
    assert.equal(calls.at(-1)?.model, 'exact-main')
  } finally { coordinator.shutdown() }
})
test('real nested delegation from isolated fixed worker still follows root user session', async () => {
  const d = deps(); d.config.provider.default = 'missing'
  const instructions = createUserInstructionsSnapshot('PINNED_NESTED_RULE: preserve archives.')
  d.getUserInstructions = () => instructions
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const parentRegistry = new ToolRegistry()
  parentRegistry.register({ definition: { name: 'delegate_task', description: 'Nested binding fixture', input_schema: { type: 'object', properties: {} } }, requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true, execute: async () => ({ content: '' }) })
  const parentOrder = order('code_scout', { provider: 'third-party', model: 'other-flash' })
  parentOrder.allowedTools = ['delegate_task']
  const cfg = buildWorkerRuntime(d, parentOrder, buildModelCards(d.provider)[0]!, parentRegistry)
  cfg.maxTurns = 2; cfg.sessionNonce = 'nested'; currentOrder = cfg.order
  const start = calls.length; nestedMode = true; delegated = false
  try {
    await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000, entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
    assert.ok(delegated)
    const requests = calls.slice(start)
    assert.equal(requests[0]?.model, 'other-flash')
    assert.ok(requests.some(request => request.model === 'exact-main'), 'real nested client must call root model')
    assert.ok(requests.filter(request => request.model === 'exact-main').every(request => request.authorization === 'Bearer fixture-main'))
    assert.ok(requests.every(request => request.hasNestedRules), 'parent and real nested HTTP requests must share the user rules')
  } finally { nestedMode = false }
})

test('legacy profile names resembling policy sentinels remain fixed bindings', async () => {
  const d = deps(cfg => {
    cfg.workers.routing.repo_summarization = '__session__'
    cfg.workers.profiles.__session__ = { provider: 'third-party', model: 'other-flash' }
  })
  const cfg = runtime(d)
  assert.equal(cfg.runtimeDecision?.strategy, 'fixed')
  assert.equal((await send(cfg)).model, 'other-flash')
})
test('deleted named task binding blocks without falling back or choosing a candidate', async () => {
  const d = deps(cfg => { cfg.workers.routing.repo_summarization = 'removed'; cfg.workers.defaultStrategy = 'auto' })
  const before = calls.length
  assert.throws(() => runtime(d), /route_deleted/)
  assert.equal(calls.length, before)
})

test('fixed keyless endpoint is an actual client binding, not a missing-key fallback', async () => {
  const d = deps(cfg => { cfg.provider.providers.local = provider('local', { apiKey: undefined }) })
  const cfg = runtime(d, order('code_scout', { provider: 'local', model: 'other-flash' }))
  const request = await send(cfg)
  assert.equal(cfg.runtimeDecision?.providerName, 'local')
  assert.equal(cfg.runtimeDecision?.fallbackReason, undefined)
  assert.equal(request.model, 'other-flash')
  assert.notEqual(request.authorization, 'Bearer fixture-main')
})
test('deleted main key slot fails closed while another same-model key is still available', () => {
  const d = deps(cfg => { cfg.provider.providers['third-party'] = provider('third-party', { keys: [
    { id: 'first', apiKey: 'fixture-first', models: [{ id: 'exact-main' }] },
    { id: 'main', apiKey: 'fixture-main', models: [{ id: 'exact-main' }] },
  ] }) })
  d.provider = d.config.provider.providers['third-party']!
  d.rootSessionBinding = snapshotSessionBinding(d.provider, d.currentModelId, d.apiKey)
  d.config.provider.providers['third-party']!.keys!.pop()
  assert.throws(() => runtime(d), /model_deleted/)
})
