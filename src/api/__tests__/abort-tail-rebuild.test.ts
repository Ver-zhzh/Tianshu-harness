import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity } from '../execution-continuity.js'
import type { OaiChatRequest, OaiMessage } from '../oai-types.js'

/**
 * 打断后续发的前缀分叉回归测试。
 *
 * 现场（2026-10-16 桌面端，会话 revit-4213e2/2026101609914b2d8192 的 cache-log）：
 * 用户发出消息 → 1 秒后打断 → 再发下一条，报
 * `worker continuation prefix diverged at 193; request not sent`，且重发持续失败（死锁）。
 * 形态：prevCount 194 → newCount 195，分叉在 193（= baseline 最后一条 user 消息），
 * 前次 20518 字符 → 本次 12415 字符，差值 8103 ≈ 当轮 appendix 注入块（8135）——
 * 打断丢弃 partial 输出后，appendix 转移到新的末位消息，旧尾消息被重建。
 *
 * 契约：打断是用户明示的新起点——分叉自 baseline 最后一条 user 消息起时，
 * 开新缓存代次（generationReason = 'abort_tail_rebuild'）放行；
 * 更早的历史改写、以及未发生 abort 的同样分叉，仍 fail-closed。
 * 放宽武装到首次成功发送为止：中间被别的分叉类别（如 tools）拒发不消耗。
 */

const cb = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }
const sse = () => new Response(
  `data: ${JSON.stringify({ id: 'srv', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } },
)
const MODEL = 'deepseek-flash'
/** 主会话形态：非 singleAttempt（loop.ts:813，inputOrigin !== 'worker_task'）。 */
const newClient = () => withExecutionContinuity(
  new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: MODEL, maxTokens: 2048, maxRetries: 0, thinking: 'enabled', thinkingBlockType: 'enabled' }),
  { provider: 'deepseek', model: MODEL },
)
const systemMessage: OaiMessage = { role: 'system', content: '# system\n稳定前缀' }
/** 尾消息携带易变注入块（appendix），打断后随新末位消息转移，旧消息被重建成裸文本。 */
const userWithAppendix = (text: string, seq: number): OaiMessage => ({ role: 'user', content: `${text}\n\n<context-update seq="${seq}">${'x'.repeat(200)}</context-update>` })
const continuedMessages = (): OaiMessage[] => [systemMessage, { role: 'user', content: '这是k' }, userWithAppendix('这是kimi的问题吗', 2)]

async function withFetch(run: (ctx: { bodies: Record<string, unknown>[], hangNext: () => void }) => Promise<void>) {
  const original = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  let hang = false
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (hang) {
      hang = false
      // 挂起到外部 abort：fetch 收到的是 lifecycle.signal，外部 signal abort 时联动（openai-client.ts:940-941, 992）
      await new Promise((_, reject) => {
        const signal = init?.signal
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'))
        else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    return sse()
  }
  try { await run({ bodies, hangNext: () => { hang = true } }) } finally { globalThis.fetch = original }
}

const waitForBodies = async (bodies: unknown[], n: number) => {
  for (let i = 0; i < 200 && bodies.length < n; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(bodies.length, n, `expected ${n} request(s) to reach HTTP`)
}

/** 第一轮在飞时打断，建立「已发送但被 abort」的 baseline。 */
async function abortMidFlight(client: ReturnType<typeof newClient>, bodies: unknown[], hangNext: () => void) {
  const controller = new AbortController()
  hangNext()
  const turn = client.stream({ model: MODEL, prefixProbe: true, messages: [systemMessage, userWithAppendix('这是k', 1)] }, cb, controller.signal)
  await waitForBodies(bodies, 1)
  controller.abort()
  await turn.catch(() => {})
}

test('abort 后续发：尾消息重建开新代次放行，不再 fail-closed', async () => withFetch(async ({ bodies, hangNext }) => {
  const client = newClient()
  await abortMidFlight(client, bodies, hangNext)
  await assert.doesNotReject(
    client.stream({ model: MODEL, prefixProbe: true, messages: continuedMessages() }, cb),
    '打断后的续发必须到达 HTTP，而不是被前缀守卫拦下',
  )
  assert.equal(bodies.length, 2)
  assert.equal(client.getMainPrefixProof?.()?.generationReason, 'abort_tail_rebuild')
}))

test('未打断的同样尾部分叉仍拒发', async () => withFetch(async ({ bodies }) => {
  const client = newClient()
  await client.stream({ model: MODEL, prefixProbe: true, messages: [systemMessage, userWithAppendix('这是k', 1)] }, cb)
  await assert.rejects(
    client.stream({ model: MODEL, prefixProbe: true, messages: continuedMessages() }, cb),
    /continuation prefix diverged at 1/,
  )
  assert.equal(bodies.length, 1, '守卫拒发的请求不得到达 HTTP')
}))

test('打断只放宽尾部分叉：更早历史被改写仍拒发', async () => withFetch(async ({ bodies, hangNext }) => {
  const client = newClient()
  await abortMidFlight(client, bodies, hangNext)
  await assert.rejects(
    client.stream({ model: MODEL, prefixProbe: true, messages: [{ role: 'system', content: '# system\n被改写的历史' }, userWithAppendix('这是k', 1), userWithAppendix('新问题', 2)] }, cb),
    /continuation prefix diverged at 0/,
  )
  assert.equal(bodies.length, 1)
}))

test('abort 放宽武装到首次成功发送：中间被 tools 分叉拒发不消耗', async () => withFetch(async ({ bodies, hangNext }) => {
  const client = newClient()
  await abortMidFlight(client, bodies, hangNext)
  const withTools: OaiChatRequest = { model: MODEL, prefixProbe: true, messages: continuedMessages(),
    tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }] }
  await assert.rejects(client.stream(withTools, cb), /continuation prefix diverged at tools/)
  await assert.doesNotReject(client.stream({ model: MODEL, prefixProbe: true, messages: continuedMessages() }, cb))
  assert.equal(bodies.length, 2)
  assert.equal(client.getMainPrefixProof?.()?.generationReason, 'abort_tail_rebuild')
}))
