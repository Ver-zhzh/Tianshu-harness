import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity } from '../execution-continuity.js'
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
