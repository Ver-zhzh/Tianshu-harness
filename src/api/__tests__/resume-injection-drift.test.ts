import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { validateExecutionHistory, withExecutionContinuity } from '../execution-continuity.js'
import type { OaiChatRequest, OaiMessage } from '../oai-types.js'

/**
 * worker resume 的注入漂移回归测试。
 *
 * 现场（2026-10-14 桌面端）：`worker continuation prefix diverged at 1; request not sent`，
 * 4 次落在 2 个接力会话（`.rivet/scratch/prefix-diverged-evidence/`）。
 *
 * 结构根因（本机落盘实证）：worker 落盘 record 里
 *   - `messages`     是 session 投影（无 system）
 *   - `prefixProof`  是 wire 快照（含 system）
 * 二者不是同一投影：234 条含 prefixProof 的 record 100% 满足
 * `proof.messages == [system] + messages[:k]`，且 index 1（首条 user）**32/32 内容不同**
 * ——差值正是引擎在 wire 阶段注入的 appendix/context-update 等易变内容。
 *
 * resume 时（coordinator → worker-session）`priorMessages = record.messages` 与
 * `priorPrefixProof = record.prefixProof` 被同时消费：前者重建会话，后者经
 * `restoreExecutionSnapshot` 设为比对基线。首请求由引擎**重新组装**，一旦重新注入的内容
 * 与快照不一致，`beforeSend` 即在 index 1 分叉 → fail-closed 拒发、worker 接力死锁。
 *
 * 契约：resume 首请求的 baseline 是上一次 run 的 wire 快照，与本次重注入本就可能不同——
 * 此时应开新缓存代次继续，而不是拒发。同一 run 内的追加式请求仍严格比对。
 */

const cb = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(e: Error) { throw e } }
const sse = () => new Response(
  `data: ${JSON.stringify({ id: 'srv', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } },
)
async function withFetch(run: (bodies: Record<string, unknown>[]) => Promise<void>) {
  const original = globalThis.fetch, bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse() }
  try { await run(bodies) } finally { globalThis.fetch = original }
}
/** 生产路径：worker-session 用 withExecutionContinuity 包裹 client，比对发生在 beforeSend。 */
const newClient = () => withExecutionContinuity(
  new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'deepseek-flash', maxTokens: 2048, thinking: 'enabled', thinkingBlockType: 'enabled' }),
  { provider: 'deepseek', model: 'deepseek-flash', singleAttempt: true },
)
const systemMessage: OaiMessage = { role: 'system', content: '# system\n稳定前缀' }
/** 首条 user 携带引擎注入的易变块——真实形态里是 appendix/context-update，随组装时刻变化。 */
const firstUser = (seq: number): OaiMessage => ({ role: 'user', content: `目标：侦察调用链\n\n<context-update seq="${seq}">${'x'.repeat(200)}</context-update>` })
const continuation = (snapshot: unknown): OaiChatRequest['diagnostics'] =>
  ({ purpose: 'worker_execution', continuationSource: 'explicit_resume', priorPrefix: snapshot as never })

/** 建立 baseline 并返回 wire 快照（等价于落盘 record.prefixProof）。 */
async function baseline() {
  const c = newClient()
  await c.stream({ model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(1)] }, cb)
  return JSON.parse(JSON.stringify(c.getMainPrefixProof?.()))
}

test('resume control: identical regenerated injection keeps the persisted wire snapshot', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = newClient()
  resumed.restoreExecutionSnapshot!(snapshot)
  await assert.doesNotReject(
    resumed.stream({ model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(1), { role: 'user', content: '继续' }], diagnostics: continuation(snapshot) }, cb),
    'same injection must continue the same prefix',
  )
  assert.equal(bodies.length, 2)
}))

test('resume contract: a regenerated injection must not fail-close the first request', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = newClient()
  resumed.restoreExecutionSnapshot!(snapshot)
  // 同一逻辑历史，但引擎本次组装重新注入了 seq=2（appendix 漂移，真实场景常态）
  await assert.doesNotReject(
    resumed.stream({ model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(2), { role: 'user', content: '继续' }], diagnostics: continuation(snapshot) }, cb),
    'resumed worker whose engine regenerated volatile injection must start a new cache generation, not be refused before HTTP',
  )
  assert.equal(bodies.length, 2, 'the resumed request must reach HTTP, not be blocked by the prefix guard')
}))

// ── 主会话（非 singleAttempt）的 resume 首请求 ─────────────────────────────
// 2026-10-16 现场（revit-4213e2/2026101609914b2d8192）：打断标记原位改写了已发送的
// 尾消息，resume 回来 baseline 与历史永久错位；而 10-14 的放宽只覆盖 worker
// （singleAttempt），主会话 resume 照抛 → 会话砖死。放宽推广到所有 restored
// 首请求；model 档 binding 同放宽（换模型=换缓存命名空间，开新代次是诚实语义），
// provider/endpoint/凭证仍恒 fail-closed（信任边界）。
const newMainClient = (model = 'deepseek-flash') => withExecutionContinuity(
  new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model, maxTokens: 2048, thinking: 'enabled', thinkingBlockType: 'enabled' }),
  { provider: 'deepseek', model },  // 主会话形态：非 singleAttempt（loop.ts:813）
)

test('dry history validation preserves the signal that authorizes a later abort-tail rebuild', async () => withFetch(async bodies => {
  const client = newMainClient()
  const controller = new AbortController()
  const request: OaiChatRequest = { model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(1)] }
  await client.stream(request, cb, controller.signal)
  const proof = client.getMainPrefixProof!()
  await validateExecutionHistory(client, request)
  assert.equal(bodies.length, 1)
  assert.deepEqual(client.getMainPrefixProof!(), proof)
  controller.abort()
  await client.stream({ ...request, messages: [systemMessage, firstUser(2)] }, cb)
  assert.equal(bodies.length, 2)
  assert.equal(client.getMainPrefixProof!()!.generationReason, 'abort_tail_rebuild')
}))

test('main-session resume: injection drift on the restored first request opens a new generation', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = newMainClient()
  resumed.restoreExecutionSnapshot!(snapshot)
  await assert.doesNotReject(
    resumed.stream({ model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(2), { role: 'user', content: '继续' }] }, cb),
    'main-session resume must unbrick on legitimate first-request drift, not refuse',
  )
  assert.equal(bodies.length, 2)
  assert.equal(resumed.getMainPrefixProof?.()?.generationReason, 'resume_prefix_drift')
}))

test('main-session resume: model-only binding drift opens a new generation', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = newMainClient('deepseek-flash-pro')
  resumed.restoreExecutionSnapshot!(snapshot)
  await assert.doesNotReject(
    resumed.stream({ model: 'deepseek-flash-pro', prefixProbe: true, messages: [systemMessage, firstUser(1), { role: 'user', content: '继续' }] }, cb),
    'resume with an explicit model switch must start a new cache namespace, not refuse',
  )
  assert.equal(bodies.length, 2)
  assert.equal(resumed.getMainPrefixProof?.()?.generationReason, 'resume_model_switch')
}))

test('main-session resume: a model switch with simultaneous injection drift is labelled model_switch', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = newMainClient('deepseek-flash-pro')
  resumed.restoreExecutionSnapshot!(snapshot)
  // 两个原因并存：既换了模型（缓存命名空间必变），消息也漂移。
  // 标签取 model_switch——换模型是更强的因果，运维按它筛会话时不能漏。
  await assert.doesNotReject(
    resumed.stream({ model: 'deepseek-flash-pro', prefixProbe: true, messages: [systemMessage, firstUser(2), { role: 'user', content: '继续' }] }, cb),
    'model switch accompanied by injection drift must still open the new namespace',
  )
  assert.equal(bodies.length, 2)
  assert.equal(resumed.getMainPrefixProof?.()?.generationReason, 'resume_model_switch')
}))

for (const singleAttempt of [false, true]) {
  test(`resume cannot send an unselected model (worker=${singleAttempt})`, async () => withFetch(async bodies => {
    const snapshot = await baseline()
    const resumed = withExecutionContinuity(
      new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'deepseek-flash', maxTokens: 2048, thinking: 'enabled', thinkingBlockType: 'enabled' }),
      { provider: 'deepseek', model: 'deepseek-flash', singleAttempt },
    )
    resumed.restoreExecutionSnapshot!(snapshot)
    await assert.rejects(resumed.stream({ model: 'never-selected-model', prefixProbe: true, messages: [systemMessage, firstUser(1)] }, cb), /prefix diverged at binding/)
    assert.equal(bodies.length, 1, '未选择的模型不得到达 HTTP')
  }))
}

test('worker resume retains its fixed model even when the replacement client selects another model', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = withExecutionContinuity(
    new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'deepseek-flash-pro', maxTokens: 2048, thinking: 'enabled', thinkingBlockType: 'enabled' }),
    { provider: 'deepseek', model: 'deepseek-flash-pro', singleAttempt: true },
  )
  resumed.restoreExecutionSnapshot!(snapshot)
  await assert.rejects(resumed.stream({ model: 'deepseek-flash-pro', prefixProbe: true, messages: [systemMessage, firstUser(1)] }, cb), /prefix diverged at binding/)
  assert.equal(bodies.length, 1)
}))

test('main-session resume: provider/credential drift stays fail-closed', async () => withFetch(async bodies => {
  const snapshot = await baseline()
  const resumed = withExecutionContinuity(
    new OpenAIClient({ providerName: 'other-provider', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'deepseek-flash', maxTokens: 2048, thinking: 'enabled', thinkingBlockType: 'enabled' }),
    { provider: 'other-provider', model: 'deepseek-flash' },
  )
  resumed.restoreExecutionSnapshot!(snapshot)
  await assert.rejects(
    resumed.stream({ model: 'deepseek-flash', prefixProbe: true, messages: [systemMessage, firstUser(1), { role: 'user', content: '继续' }] }, cb),
    /continuation prefix diverged at binding/,
  )
  assert.equal(bodies.length, 1, 'provider 变化不得借 resume 放行')
}))
