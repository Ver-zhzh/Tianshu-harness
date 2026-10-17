import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerSchema } from '../../config/schema.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder, type WorkOrder } from '../work-order.js'
import { runWorkerSession, type WorkerSessionConfig } from '../worker-session.js'
import { saveWorkerSession, loadWorkerSession } from '../worker-session-persist.js'

/**
 * 端到端：真实 `runWorkerSession` → 真实落盘 → `loadWorkerSession` → 真实 resume。
 * 只 stub `globalThis.fetch`（HTTP 边界），不 mock 任何中间层。
 *
 * 覆盖两条：
 *  1. 契约（happy path）：真实 resume 的首请求以首次 run 的 wire 为前缀，且不 fail-close。
 *  2. 失效路径：落盘 record 的 `prefixProof` 与该会话的 messages 不一致（= field 现场
 *     「快照与实际组装不符」的形态）时，resume 首请求**不得被前缀守卫 fail-close**。
 *
 * 附带的一手观测（本机 1166 条落盘 record）：`messages`（session 投影，无 system）与
 * `prefixProof`（wire 快照，含 system）**从不逐字节相同**——wire 侧首条 user 多出
 * `trailerTextPrefix()`（= live volatileBlock）+ appendix。引擎在 resume 时按 frozen
 * snapshot / 当前 volatileBlock 重新拼 trailer，因此这条路径的稳定性取决于 frozen 覆盖。
 */

const root = mkdtempSync(join(tmpdir(), 'resume-e2e-'))
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
  return {
    order: order(id),
    client: createProviderClient(provider, resolveCapabilities('third-party', provider.capabilities), { apiKey: 'fixture', model: 'exact-main', maxTokens: 4096, reasoningEffort: 'high', singleAttempt: true, credentialScope: 'third-party:default' }),
    promptEngine: new PromptEngine({ model: 'exact-main', maxTokens: 4096, staticCtx: { tools: [], audience: 'subagent' }, volatileCtx: { cwd: root } }),
    toolRegistry: new ToolRegistry(), cwd: root, providerName: provider.name, maxTurns: 2, contextWindow: 64000, compact: { enabled: false, model: 'flash' }, sessionNonce: id,
  }
}
const sse = (text: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } },
)
/** 跑一次真实 worker 并落盘，返回读回的 record。 */
async function runAndPersist(id: string) {
  const first = await runWorkerSession(config(id))
  const messages = first.session.getMessages()
  saveWorkerSession(id, 'code_scout', 'e2e objective', messages, undefined, undefined,
    { prefixProof: first.prefixProof, frozenSnapshot: first.frozenSnapshot }, id)
  const record = loadWorkerSession(id)
  assert.ok(record, 'record must round-trip through disk')
  return { first, messages, record: record! }
}

test('e2e: real resume continues the persisted wire prefix without fail-close', async () => {
  const original = globalThis.fetch, bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(report('e2e-happy')) }
  try {
    const { record } = await runAndPersist('e2e-happy')
    // 一手观测：session 投影与 wire 快照不是同一投影（wire 侧含 system）
    assert.equal(record.prefixProof!.messages[0]!.role, 'system', 'wire snapshot carries the system message')
    assert.notEqual(record.messages[0]!.role, 'system', 'session projection does not')
    assert.ok(record.frozenSnapshot, 'frozen snapshot rides along for resume')

    const resumed = config('e2e-happy')
    resumed.order = { ...resumed.order, objective: 'e2e continuation objective' }
    resumed.priorMessages = record.messages
    resumed.priorPrefixProof = record.prefixProof
    resumed.priorFrozenSnapshot = record.frozenSnapshot
    const second = await runWorkerSession(resumed)
    assert.equal(second.result.status, 'passed', second.result.summary)

    const wireA = bodies[0]!.messages as unknown[], wireB = bodies[1]!.messages as unknown[]
    assert.deepEqual(wireB.slice(0, wireA.length), wireA, 'resume wire must extend the first run wire byte-for-byte')
  } finally { globalThis.fetch = original }
})

test('e2e: resume whose persisted snapshot diverges from the rebuilt wire must not fail-close', async () => {
  const original = globalThis.fetch, bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(report('e2e-stale')) }
  try {
    const { record } = await runAndPersist('e2e-stale')
    // 现场形态：落盘快照与本次重建的 wire 在首条 user 处不一致（注入/装配差异）。
    const snapshot = JSON.parse(JSON.stringify(record.prefixProof))
    snapshot.messages[1] = { ...snapshot.messages[1], hash: 'deadbeef'.repeat(8), chars: 1 }

    const resumed = config('e2e-stale')
    resumed.order = { ...resumed.order, objective: 'e2e continuation objective' }
    resumed.priorMessages = record.messages
    resumed.priorPrefixProof = snapshot
    resumed.priorFrozenSnapshot = record.frozenSnapshot
    let thrown: unknown = null
    try { await runWorkerSession(resumed) } catch (error) { thrown = error }
    assert.equal(thrown, null,
      `resumed worker must not be refused before HTTP when the persisted snapshot no longer matches; got: ${(thrown as Error)?.message}`)
    assert.equal(bodies.length, 2, 'the resumed request must reach HTTP')
  } finally { globalThis.fetch = original }
})
