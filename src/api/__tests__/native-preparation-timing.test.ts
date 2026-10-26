import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResponsesClient } from '../responses-client.js'
import { CodexClient } from '../codex-client.js'
import { AnthropicClient } from '../anthropic-client.js'
import { GeminiClient } from '../gemini-client.js'
import { readCallAudit } from '../call-audit.js'
import { TokenBucket, resetRateLimiterRegistry } from '../rate-limiter.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { StreamCallbacks, StreamClient } from '../stream-client.js'
import type { AuthProvider } from '../../auth/types.js'

const request: OaiChatRequest = { model: 'fixture', messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 64 }
const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'native-preparation-')), old = process.env.RIVET_HOME
  process.env.RIVET_HOME = root
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
  const proxyEnv = proxyKeys.map(key => [key, process.env[key]] as const)
  for (const key of proxyKeys) delete process.env[key]
  process.env.RIVET_NO_SYSTEM_PROXY = '1'
  let clock = 100
  t.mock.method(performance, 'now', () => clock)
  t.mock.method(TokenBucket.prototype, 'acquire', async (signal?: AbortSignal) => { signal?.throwIfAborted(); clock += 40 })
  t.after(() => {
    resetRateLimiterRegistry()
    if (old === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = old
    for (const [key, value] of proxyEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value
    rmSync(root, { recursive: true, force: true })
  })
  return { advance: (ms: number) => { clock += ms } }
}

function auth(getHeaders: AuthProvider['getHeaders']): AuthProvider {
  return { getHeaders, isAuthenticated: () => true, authenticate: async () => {}, dispose() {} }
}

function response(kind: string): Response {
  const frames = kind === 'anthropic' ? [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : kind === 'gemini' ? [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }]
    : [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 1 } } }]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

for (const kind of ['responses', 'codex', 'anthropic', 'gemini'] as const) {
  test(`${kind} measures body preparation and queueing before fetch without changing bytes`, async t => {
    const clock = setup(t)
    const config = { baseUrl: `https://${kind}.fixture.invalid`, apiKey: 'fixture', model: 'fixture', maxTokens: 64, maxRetries: 0,
      retry: { rateLimit: { requestsPerSecond: 1 } }, auth: auth(async () => { clock.advance(30); return {} }) }
    const client: StreamClient = kind === 'responses' ? new ResponsesClient(config) : kind === 'codex' ? new CodexClient(config)
      : kind === 'anthropic' ? new AnthropicClient(config) : new GeminiClient(config)
    const internal = client as unknown as { buildRequestBody(request: OaiChatRequest): object }
    const build = internal.buildRequestBody.bind(client), expected = JSON.stringify(build(request))
    t.mock.method(internal, 'buildRequestBody', (...args: [OaiChatRequest]) => { clock.advance(25); return build(...args) })
    let actual = ''
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { actual = String(init.body); clock.advance(10); return response(kind) })
    await client.stream(request, callbacks)
    const row = readCallAudit().calls[0]!
    assert.ok(row, 'native preparation must produce a correlated audit record')
    assert.equal(actual, expected)
    assert.equal(row.bodyPreparationMs, 25)
    assert.equal(row.rateLimitWaitMs, 40)
    assert.equal(row.authenticationMs, kind === 'responses' || kind === 'codex' ? 30 : undefined)
    assert.equal(row.requestPreparationMs, kind === 'responses' || kind === 'codex' ? 95 : 65)
    assert.equal(row.firstTextMs, row.requestPreparationMs! + 10)
    assert.equal(row.requestBodyBytes, Buffer.byteLength(actual))
    assert.equal(row.model, 'fixture')
    assert.equal(row.provider, `${kind}.fixture.invalid`)
    assert.ok(row.configFingerprint)
    assert.equal(row.status, 'complete')
  })
}

for (const cancelled of [false, true]) test(`pre-fetch authentication ${cancelled ? 'cancellation' : 'failure'} retains attempt timings`, async t => {
  const clock = setup(t), abort = new AbortController()
  const client = new ResponsesClient({ baseUrl: 'https://failure.fixture.invalid', apiKey: '', model: 'fixture', maxTokens: 64, maxRetries: 0,
    auth: auth(async () => { clock.advance(30); if (cancelled) abort.abort(); throw cancelled ? abort.signal.reason : new Error('authentication unavailable') }) })
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('failed preparation must not send HTTP') })
  await assert.rejects(client.stream(request, callbacks, abort.signal))
  const row = readCallAudit().calls[0]!
  assert.ok(row, 'pre-fetch failure must retain an audit record')
  assert.equal(row.authenticationMs, 30)
  assert.equal(row.status, cancelled ? 'aborted' : 'failed')
  assert.equal(row.requestDurationMs, 30)
  assert.equal(row.requestBodyBytes, undefined)
})

test('native retry attempts have separate preparation clocks and identities', async t => {
  const clock = setup(t)
  const client = new ResponsesClient({ baseUrl: 'https://retry.fixture.invalid', apiKey: '', model: 'fixture', maxTokens: 64, maxRetries: 1,
    retry: { backoff: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, overrides: { overloaded: { retryDelayMs: 0 } } },
    auth: auth(async () => { clock.advance(30); return {} }) })
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => { clock.advance(10); return ++attempts === 1 ? new Response('unavailable', { status: 503 }) : response('responses') })
  await client.stream(request, callbacks)
  const rows = readCallAudit().calls
  assert.equal(rows.length, 2)
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1)
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 2)
  assert.deepEqual(rows.map(row => row.authenticationMs), [30, 30])
  assert.deepEqual(rows.map(row => row.requestPreparationMs), [30, 30])
  assert.deepEqual(rows.map(row => row.requestDurationMs), [40, 40])
})

test('request preparation timing preserves the same logical wire body across retries', async t => {
  setup(t)
  const client = new ResponsesClient({ baseUrl: 'https://frozen.fixture.invalid', apiKey: '', model: 'fixture', maxTokens: 64, maxRetries: 1,
    reasoningEffort: 'high', retry: { backoff: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
  const bodies: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    client.setReasoningEffort('low')
    return bodies.length === 1 ? new Response('unavailable', { status: 503 }) : response('responses')
  })
  await client.stream(request, callbacks)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1], bodies[0], 'an in-flight config change must not alter a retried request')
})
