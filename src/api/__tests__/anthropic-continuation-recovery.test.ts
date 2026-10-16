import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicClient, type AnthropicClientConfig } from '../anthropic-client.js'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity, currentExecutionScope, type ContinuityClientOptions } from '../execution-continuity.js'
import * as executionContinuity from '../execution-continuity.js'
import { isRewindGenerationAuthorization, proveCanonicalSource, proveRewindHistory } from '../continuation-prefix.js'
import { createProviderClient } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import { providerSchema } from '../../config/schema.js'
import { fetchWithTimeout } from '../fetch-timeout.js'
import { FallbackStreamClient } from '../fallback-client.js'
import { classifyApiError } from '../error-classifier.js'
import { RetryBudget } from '../retry-budget.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { StreamCallbacks } from '../stream-client.js'

const directory = mkdtempSync(join(tmpdir(), 'tianshu-anthropic-continuation-'))
process.env.RIVET_HOME = join(directory, 'home')
process.env.RIVET_SESSION_DIR = join(directory, 'sessions')

const baseUrl = 'https://anthropic-continuation.fixture.invalid'
const model = 'fixture-model'
const callbacks: StreamCallbacks = {
  onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {},
  onError(error) { throw error },
}
type NativeMessage = { role: string; content: Array<Record<string, unknown>> }
type NativeBody = { messages: NativeMessage[]; [key: string]: unknown }

function makeClient(overrides: Partial<AnthropicClientConfig> = {}, policy: Partial<ContinuityClientOptions> = {}) {
  const config: AnthropicClientConfig = { baseUrl, apiKey: 'fixture-key', model, maxTokens: 2048,
    maxRetries: 0, effortFormat: 'output_config', reasoningEffort: 'high', temperature: 0.25, ...overrides }
  return { config, client: withExecutionContinuity(new AnthropicClient(config), {
    provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default', ...policy,
  }) }
}

function request(): OaiChatRequest {
  return { model, prefixProbe: true, max_tokens: 2048,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'ready', tool_calls: [
        { id: 'call-fixture', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call-fixture', content: 'old tool result' },
      { role: 'user', content: [
        { type: 'text', text: 'old published text' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,b2xk' } },
      ] },
    ],
  }
}

function response(): Response {
  const events = [
    { type: 'message_start', message: { id: 'fixture-response', usage: { input_tokens: 100, cache_read_input_tokens: 80 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function withHttp(run: (bodies: NativeBody[]) => Promise<void>, reply: () => Response = response, endpoint = '/v1/messages') {
  const original = globalThis.fetch
  const bodies: NativeBody[] = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${baseUrl}${endpoint}`, 'no non-fixture HTTP is permitted')
    assert.equal(init?.method, 'POST')
    bodies.push(JSON.parse(String(init.body)))
    return reply()
  }
  try { await run(bodies) } finally { globalThis.fetch = original }
}

test('real Anthropic transport accepts repeated appended users while preserving every old native block', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  const saved = structuredClone(original)
  await client.stream(original, callbacks)
  assert.deepEqual(bodies[0]!.messages.at(-1)!.content, [
    { type: 'tool_result', tool_use_id: 'call-fixture', content: 'old tool result' },
    { type: 'text', text: 'old published text' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b2xk' } },
  ])
  const generation = client.getMainPrefixProof!()!.cacheGenerationId
  let continued = original
  for (const text of ['继续', '再继续']) {
    const previous = bodies.at(-1)!
    continued = { ...continued, messages: [...continued.messages, { role: 'user', content: text }] }
    await assert.doesNotReject(client.stream(continued, callbacks))
    const current = bodies.at(-1)!
    assert.deepEqual(current.messages.slice(0, -1), previous.messages.slice(0, -1))
    const oldBlocks = previous.messages.at(-1)!.content
    assert.equal(JSON.stringify(current.messages.at(-1)!.content.slice(0, oldBlocks.length)), JSON.stringify(oldBlocks))
    assert.deepEqual(current.messages.at(-1)!.content.at(-1), { type: 'text', text })
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, generation)
  }
  assert.equal(bodies.length, 3)
  assert.deepEqual(original, saved)
}))

test('coalescing the first user rolls owned BP3 to its actual folded tail without changing content', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = { ...request(), messages: [{ role: 'user' as const, content: 'first published user' }] }
  await client.stream(original, callbacks)
  await assert.doesNotReject(client.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks))
  assert.deepEqual(bodies[1]!.messages, [{ role: 'user', content: [
    { type: 'text', text: 'first published user' },
    { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } },
  ] }])
  assert.equal(client.getMainPrefixProof!()!.nativeCacheLayout![0]!.blockIndex, 1)
}))

test('owned BP3 keeps the original folded-tail cache strategy beyond twenty blocks without an assistant', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = { ...request(), messages: Array.from({ length: 24 }, (_, index) => ({ role: 'user' as const, content: `initial ${index}` })) }
  let continued = original
  const withoutCache = (blocks: NativeMessage['content']) => blocks.map(({ cache_control: _owned, ...block }) => block)
  let generation: string | undefined
  for (let turn = 0; turn < 3; turn++) {
    if (turn) continued = { ...continued, messages: [...continued.messages, ...Array.from({ length: 24 }, (_, index) => ({ role: 'user' as const, content: `${turn}:${index}` }))] }
    await client.stream(continued, callbacks)
    const blocks = bodies.at(-1)!.messages[0]!.content
    assert.deepEqual(blocks.flatMap((block, index) => block.cache_control ? [index] : []), [blocks.length - 1])
    if (turn) assert.deepEqual(withoutCache(blocks.slice(0, bodies[turn - 1]!.messages[0]!.content.length)), withoutCache(bodies[turn - 1]!.messages[0]!.content))
    const proof = client.getMainPrefixProof!()!
    assert.equal(proof.nativeCacheLayout![0]!.blockIndex, blocks.length - 1)
    generation ??= proof.cacheGenerationId
    assert.equal(proof.cacheGenerationId, generation)
  }
  assert.equal(bodies.length, 3)
}))

test('the old native tail may grow before newly appended assistant and user turns', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  await client.stream({ ...original, messages: [...original.messages,
    { role: 'user', content: 'continue' }, { role: 'assistant', content: 'new answer' }, { role: 'user', content: 'next' },
  ] }, callbacks)
  assert.equal(bodies[1]!.messages.length, bodies[0]!.messages.length + 2)
  assert.deepEqual(bodies[1]!.messages[2]!.content.slice(0, 3), bodies[0]!.messages[2]!.content)
}))

for (const changed of ['text', 'image', 'tool_result', 'source_only', 'source_boundary'] as const) {
  test(`published ${changed} changes fail before HTTP and retain the original proof`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    if (changed === 'source_only') {
      original.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `https://image.fixture.invalid/${'x'.repeat(60)}old` } }]
    }
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    const next = structuredClone(original)
    if (changed === 'tool_result') next.messages[3]!.content = 'changed tool result'
    if (changed === 'text') next.messages.at(-1)!.content = 'changed text'
    if (changed === 'image') next.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,bmV3' } }]
    if (changed === 'source_only') next.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `https://image.fixture.invalid/${'x'.repeat(60)}new` } }]
    if (changed === 'source_boundary') {
      next.messages.splice(3, 2, { role: 'user', content: [
        { type: 'text', text: 'old tool result' }, { type: 'text', text: 'old published text' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,b2xk' } },
      ] })
    }
    next.messages.push({ role: 'user', content: 'continue' })
    await assert.rejects(client.stream(next, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
    await client.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'valid continue' }] }, callbacks)
    assert.equal(bodies.length, 2)
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
  }))
}

for (const changed of ['model', 'credentials', 'endpoint', 'options', 'tools'] as const) {
  test(`coalescing never unlocks the ${changed} binding`, async () => withHttp(async bodies => {
    const { client, config } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    const next = { ...original, messages: [...original.messages, { role: 'user' as const, content: 'continue' }] }
    if (changed === 'model') next.model = 'other-model'
    if (changed === 'credentials') config.apiKey = 'other-fixture-key'
    if (changed === 'endpoint') config.baseUrl = `${baseUrl}/other-endpoint`
    if (changed === 'options') next.reasoning_effort = 'low'
    if (changed === 'tools') next.tools = []
    await assert.rejects(client.stream(next, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
  }))
}

for (const restore of ['method', 'constructor'] as const) {
  test(`serialized ${restore} restoration retains append-only coalescing evidence`, async () => withHttp(async bodies => {
    const original = request()
    const { client } = makeClient()
    await client.stream(original, callbacks)
    const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
    const restored = makeClient({}, restore === 'constructor' ? { prior: saved } : {}).client
    if (restore === 'method') restored.restoreExecutionSnapshot!(saved)
    await restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks)
    assert.deepEqual(bodies[1]!.messages[2]!.content.slice(0, 3), bodies[0]!.messages[2]!.content)
    assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
    const evidence = { canonicalSource: saved.canonicalSource, nativeTail: saved.nativeTail }
    assert.ok(evidence.canonicalSource?.length)
    assert.ok(evidence.nativeTail?.blockCount)
    for (const text of ['stable system', 'old published text', 'old tool result', 'b2xk', 'fixture-key']) {
      assert.ok(!JSON.stringify(evidence).includes(text))
    }
  }))
}

for (const missing of ['canonicalSource', 'nativeTail'] as const) {
  for (const singleAttempt of [false, true]) {
    test(`restored ${singleAttempt ? 'worker' : 'main'} without ${missing} proves complete source boundaries without starting cold`, async () => withHttp(async bodies => {
      const { client } = makeClient()
      const original = request()
      await client.stream(original, callbacks)
      const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
      delete saved[missing]
      const restored = makeClient({}, { singleAttempt }).client
      restored.restoreExecutionSnapshot!(saved)
      await assert.doesNotReject(restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks))
      assert.equal(bodies.length, 2)
      assert.deepEqual(bodies[1]!.messages.at(-1)!.content.slice(0, 3), bodies[0]!.messages.at(-1)!.content)
      assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
    }))
  }
}

test('an interrupted dispatch still seals its source and native prefix', async () => {
  let replies = 0
  await withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await assert.rejects(client.stream(original, callbacks), /fixture interrupted/)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    assert.ok(saved)
    await client.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks)
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1]!.messages[2]!.content.slice(0, 3), bodies[0]!.messages[2]!.content)
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
  }, () => {
    if (replies++ === 0) throw new DOMException('fixture interrupted', 'AbortError')
    return response()
  })
})

test('owned BP4 removal across the lookback threshold composes with a proven user append', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const generation = client.getMainPrefixProof!()!.cacheGenerationId
  await assert.doesNotReject(client.stream({ ...original, messages: [...original.messages, { role: 'user', content:
    Array.from({ length: 20 }, (_, index) => ({ type: 'text' as const, text: `new block ${index}` })),
  }] }, callbacks))
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0]!.messages[1]!.content.at(-1)!.cache_control, { type: 'ephemeral' })
  assert.equal(bodies[1]!.messages[1]!.content.at(-1)!.cache_control, undefined)
  assert.deepEqual(bodies[1]!.messages[2]!.content.slice(0, 3), bodies[0]!.messages[2]!.content)
  assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, generation)
}))

test('single-attempt Anthropic workers never retry a failed coalesced dispatch', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const restored = makeClient({ maxRetries: 8 }, { singleAttempt: true }).client
  restored.restoreExecutionSnapshot!(JSON.parse(JSON.stringify(client.getMainPrefixProof!()!)))
  const next = { ...original, messages: [...original.messages, { role: 'user' as const, content: 'continue' }] }
  await assert.rejects(restored.stream(next, callbacks), /503/)
  await assert.rejects(restored.stream(next, callbacks), /503/)
  assert.equal(bodies.length, 2)
}, (() => {
  let calls = 0
  return () => ++calls === 1 ? response() : new Response('fixture unavailable', { status: 503 })
})()))

test('source-only rewrites cannot hide behind identical native bytes even without an append', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  const urlPrefix = `https://image.fixture.invalid/${'x'.repeat(60)}`
  original.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `${urlPrefix}old` } }]
  await client.stream(original, callbacks)
  const next = structuredClone(original)
  next.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `${urlPrefix}new` } }]
  await assert.rejects(client.stream(next, callbacks), /prefix diverged at source/)
  assert.equal(bodies.length, 1)
}))

test('resegmenting source users is not an append even when native blocks are identical', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = { ...request(), messages: [
    { role: 'user' as const, content: 'first task' },
    { role: 'assistant' as const, content: 'answer' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'one' }, { type: 'text' as const, text: 'two' }] },
  ] }
  await client.stream(original, callbacks)
  const next: OaiChatRequest = { ...original, messages: [...original.messages.slice(0, -1),
    { role: 'user', content: 'one' }, { role: 'user', content: 'two' },
  ] }
  await assert.rejects(client.stream(next, callbacks), /prefix diverged at source/)
  assert.equal(bodies.length, 1)
}))

const sparseSource: string[] = []
sparseSource.length = 5
const malformedEvidence: Array<[string, unknown]> = [
  ['canonicalSource', null], ['canonicalSource', {}], ['canonicalSource', ['bad-hash']],
  ['canonicalSource', []], ['canonicalSource', sparseSource],
  ['nativeTail', null], ['nativeTail', []], ['nativeTail', { blockCount: 0, hash: 'a'.repeat(64) }],
  ['nativeTail', { blockCount: 1.5, hash: 'a'.repeat(64) }],
  ['nativeTail', { blockCount: Number.MAX_SAFE_INTEGER + 1, hash: 'a'.repeat(64) }],
  ['nativeTail', { blockCount: 3, hash: 'bad-hash' }],
  ['nativeTail', { blockCount: 3, hash: 'a'.repeat(64), content: 'unexpected plaintext' }],
  ['nativeCacheLayout', null], ['nativeCacheLayout', {}],
  ['nativeCacheLayout', [{ kind: 4, messageIndex: -1, blockIndex: 0, valueHash: 'a'.repeat(64) }]],
  ['nativeCacheLayout', Array.from({ length: 5 }, () => ({ kind: 4, messageIndex: 2, blockIndex: 0, valueHash: 'a'.repeat(64) }))],
]
for (const [index, [field, value]] of malformedEvidence.entries()) {
  test(`malformed evidence ${index} is rejected at restoration, constructor and live consumption`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    Object.assign(saved, { [field]: value })
    const restored = makeClient().client
    assert.throws(() => restored.restoreExecutionSnapshot!(saved), /snapshot/)
    const constructed = makeClient({}, { prior: saved }).client
    await assert.rejects(constructed.stream(original, callbacks), /snapshot/)
    Object.assign(client.getMainPrefixProof!()!, { [field]: value })
    await assert.rejects(client.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks), /snapshot/)
    assert.equal(bodies.length, 1)
  }))
}

for (const changed of ['count', 'hash'] as const) {
  test(`well-shaped but incorrect native tail ${changed} cannot authorize coalescing`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    assert.ok(saved.nativeTail)
    if (changed === 'count') saved.nativeTail.blockCount = 2
    else saved.nativeTail.hash = 'a'.repeat(64)
    const restored = makeClient().client
    restored.restoreExecutionSnapshot!(saved)
    await assert.rejects(restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
  }))
}

test('source proof captures the dispatched prefix rather than a later append to the caller array', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  const pending = client.stream(original, callbacks)
  original.messages.push({ role: 'user', content: 'arrived while preparing HTTP' })
  await pending
  assert.equal(bodies[0]!.messages.at(-1)!.content.length, 3)
  await assert.doesNotReject(client.stream(original, callbacks))
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1]!.messages.at(-1)!.content.slice(0, 3), bodies[0]!.messages.at(-1)!.content)
}))

test('side paths cannot replace the serialized proof committed for the main request', async () => withHttp(async bodies => {
  const { client } = makeClient()
  let saved: ReturnType<NonNullable<typeof client.getMainPrefixProof>>
  const original = request()
  original.onExecutionSnapshot = proof => { saved = JSON.parse(JSON.stringify(proof)) }
  await client.stream(original, callbacks)
  assert.ok(saved!)
  await client.stream({ model, messages: [{ role: 'user', content: 'side question' }], diagnostics: { purpose: 'side_question' } }, callbacks)
  assert.deepEqual(client.getMainPrefixProof!(), saved!)
  const restored = makeClient().client
  restored.restoreExecutionSnapshot!(saved!)
  await restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks)
  assert.equal(bodies.length, 3)
}))

test('the actual provider factory consumes continuation evidence and keeps optional methods available', async () => withHttp(async bodies => {
  const provider = providerSchema.parse({ name: 'unrelated-provider-alias', protocol: 'anthropic', baseUrl,
    maxRetries: 0, models: [{ id: model, maxTokens: 2048 }] })
  const client = createProviderClient(provider, resolveCapabilities(provider.name), {
    apiKey: 'fixture-key', model, maxTokens: 2048, credentialScope: 'fixture:default',
  })
  assert.equal(typeof client.restoreExecutionSnapshot, 'function')
  const original = request()
  await client.stream(original, callbacks)
  const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
  const restored = createProviderClient(provider, resolveCapabilities(provider.name), {
    apiKey: 'fixture-key', model, maxTokens: 2048, credentialScope: 'fixture:default', priorExecution: saved,
  })
  await restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks)
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1]!.messages.at(-1)!.content.slice(0, 3), bodies[0]!.messages.at(-1)!.content)
  assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
}))

test('send-time image eviction is not mistaken for append-only user coalescing', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  original.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(16_384)}` } }]
  const savedSource = structuredClone(original)
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  config.maxBodyBytes = 2048
  await assert.rejects(client.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.deepEqual(client.getMainPrefixProof!(), saved)
  assert.deepEqual(original, savedSource)
}))

test('a native assistant rewrite cannot cold-start a restored worker lacking new evidence', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = { ...request(), messages: request().messages.slice(0, 3) }
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  delete saved.canonicalSource
  delete saved.nativeTail
  const restored = makeClient({}, { singleAttempt: true }).client
  restored.restoreExecutionSnapshot!(saved)
  const changed = structuredClone(original)
  changed.messages[2]!.content = 'unpublished assistant rewrite'
  await assert.rejects(restored.stream({ ...changed, messages: [...changed.messages, { role: 'user', content:
    Array.from({ length: 20 }, (_, index) => ({ type: 'text' as const, text: `new block ${index}` })),
  }] }, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
}))

test('a worker scope still rejects a second real Anthropic dispatch inside one stream', async () => withHttp(async bodies => {
  const transport = new AnthropicClient({ baseUrl, apiKey: 'fixture-key', model, maxTokens: 2048, maxRetries: 0 })
  const adapter = { async stream(original: OaiChatRequest, observer: StreamCallbacks, signal?: AbortSignal) {
    await transport.stream(original, observer, signal)
    await transport.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'second send' }] }, observer, signal)
  } }
  const client = withExecutionContinuity(adapter, { provider: 'unrelated-provider-alias', model, singleAttempt: true })
  await assert.rejects(client.stream(request(), callbacks), /already sent/)
  assert.equal(bodies.length, 1)
}))

test('a legacy v2 proof lacking both new fields recovers repeated continuations without changing generation', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
  delete saved.canonicalSource
  delete saved.nativeTail
  const restored = makeClient({}, { prior: saved }).client
  let continued = original
  for (const text of ['continue', 'continue again']) {
    continued = { ...continued, messages: [...continued.messages, { role: 'user', content: text }] }
    await assert.doesNotReject(restored.stream(continued, callbacks))
    assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
  }
  assert.equal(bodies.length, 3)
  assert.deepEqual(bodies[2]!.messages.at(-1)!.content.slice(0, 3), bodies[0]!.messages.at(-1)!.content)
}))

for (const added of ['text', 'image'] as const) {
  test(`legacy recovery cannot cut inside an existing source user to hide an appended ${added} part`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
    delete saved.canonicalSource
    delete saved.nativeTail
    const restored = makeClient({}, { prior: saved }).client
    const next = structuredClone(original)
    const last = next.messages.at(-1)!
    assert.ok(last.role === 'user' && Array.isArray(last.content))
    last.content.push(added === 'text' ? { type: 'text', text: 'illegally appended old content' }
      : { type: 'image_url', image_url: { url: 'data:image/png;base64,bmV3' } })
    next.messages.push({ role: 'user', content: 'a legitimate new user does not excuse the old edit' })
    await assert.rejects(restored.stream(next, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
  }))
}

test('an adapter without actual conversion boundaries cannot infer legacy recovery from the provider alias', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  delete saved.canonicalSource
  delete saved.nativeTail
  const converter = new AnthropicClient(config)
  const adapter = { async stream(next: OaiChatRequest) {
    await fetchWithTimeout(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': config.apiKey },
      body: JSON.stringify(converter.buildRequestBodyForTest(next)),
    })
  } }
  const restored = withExecutionContinuity(adapter, { provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default', prior: saved })
  await assert.rejects(restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.deepEqual(restored.getMainPrefixProof!(), saved)
}))

test('legacy recovery hashes a long folded native tail at complete source boundaries', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  original.messages.push(...Array.from({ length: 128 }, (_, index) => ({ role: 'user' as const, content: `${index}:${'old'.repeat(1024)}` })))
  await client.stream(original, callbacks)
  const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
  delete saved.canonicalSource
  delete saved.nativeTail
  const restored = makeClient({}, { prior: saved }).client
  await restored.stream({ ...original, messages: [...original.messages, { role: 'user', content: 'continue' }] }, callbacks)
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1]!.messages.at(-1)!.content.slice(0, 131), bodies[0]!.messages.at(-1)!.content)
  assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
}))

for (const metadata of ['reasoning_content', 'providerMetadata'] as const) {
  test(`real OpenAI ignores changed stripped ${metadata} when the complete wire is identical`, async () => withHttp(async bodies => {
    const client = withExecutionContinuity(new OpenAIClient({ providerName: 'fixture-openai', baseUrl,
      apiKey: 'fixture-key', model, maxTokens: 2048, maxRetries: 0, thinking: 'disabled' }), {
      provider: 'fixture-openai', model, credentialScope: 'fixture:default',
    })
    const original = request()
    const assistant = original.messages[2]!
    assert.ok(assistant.role === 'assistant' && assistant.tool_calls)
    assistant.tool_calls[0]!.providerMetadata = { gemini: { thoughtSignature: 'old-local-signature' } }
    assistant.reasoning_content = 'old stripped reasoning'
    await client.stream(original, callbacks)
    assert.ok(!JSON.stringify(bodies[0]!).includes('reasoning_content'))
    assert.ok(!JSON.stringify(bodies[0]!).includes('providerMetadata'))
    const next = structuredClone(original)
    if (metadata === 'reasoning_content') {
      const changed = next.messages[2]!
      assert.ok(changed.role === 'assistant')
      changed.reasoning_content = 'new stripped reasoning'
    } else {
      const changed = next.messages[2]!
      assert.ok(changed.role === 'assistant' && changed.tool_calls)
      changed.tool_calls[0]!.providerMetadata = { gemini: { thoughtSignature: 'new-local-signature' } }
    }
    await assert.doesNotReject(client.stream(next, callbacks))
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1]!.messages, bodies[0]!.messages)
    assert.equal(client.getMainPrefixProof!()!.canonicalSource, undefined)
    assert.equal(client.getMainPrefixProof!()!.nativeTail, undefined)
  }, () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), '/chat/completions'))
}

test('a source-protected snapshot cannot silently lose native conversion capability on an identical wire', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  const converter = new AnthropicClient(config)
  const restored = withExecutionContinuity({ async stream(next: OaiChatRequest) {
    const reply = await fetchWithTimeout(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': config.apiKey },
      body: JSON.stringify(converter.buildRequestBodyForTest(next)),
    })
    await reply.text()
  } }, { provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default', prior: saved })
  await assert.rejects(restored.stream(original, callbacks), /native.*evidence|native.*capability/i)
  assert.equal(bodies.length, 1)
  assert.deepEqual(restored.getMainPrefixProof!(), saved)
}))

function legacyBp3Fixture(closed: boolean): { original: OaiChatRequest; body: NativeBody } {
  const original: OaiChatRequest = { model, prefixProbe: true, max_tokens: 2048, messages: [
    { role: 'user', content: 'legacy anchor' },
    { role: 'user', content: [
      { type: 'text', text: 'legacy task' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,b2xk' } },
    ] },
    ...(closed ? [{ role: 'assistant' as const, content: 'legacy answer' }, { role: 'user' as const, content: 'legacy tail' }] : []),
  ] }
  const body: NativeBody = { model, max_tokens: 2048, stream: true, output_config: { effort: 'high' }, messages: [
    { role: 'user', content: [
      { type: 'text', text: 'legacy anchor' },
      { type: 'text', text: 'legacy task' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b2xk' }, cache_control: { type: 'ephemeral' } },
    ] },
    ...(closed ? [
      { role: 'assistant', content: [{ type: 'text', text: 'legacy answer', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'legacy tail' }] },
    ] : []),
  ] }
  return { original, body }
}

async function publishLegacyBp3(closed: boolean) {
  const fixture = legacyBp3Fixture(closed)
  const publisher = withExecutionContinuity({ async stream() {
    const reply = await fetchWithTimeout(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'fixture-key' },
      body: JSON.stringify(fixture.body),
    })
    await reply.text()
  } }, { provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default' })
  await publisher.stream(fixture.original, callbacks)
  const saved = structuredClone(publisher.getMainPrefixProof!()!)
  delete saved.canonicalSource
  delete saved.nativeTail
  return { ...fixture, saved }
}

for (const closed of [false, true]) {
  test(`genuine legacy folded-first-user BP3 survives repeated continuation and fresh restore (${closed ? 'closed' : 'tail'})`, async () => withHttp(async bodies => {
    const { original, body, saved } = await publishLegacyBp3(closed)
    assert.deepEqual(bodies[0], body)
    let client = makeClient({}, { prior: saved }).client
    let continued = original
    for (const text of ['continue', 'continue again', 'after fresh restore']) {
      continued = { ...continued, messages: [...continued.messages, { role: 'user', content: text }] }
      await assert.doesNotReject(client.stream(continued, callbacks))
      const firstUser = bodies.at(-1)!.messages[0]!
      const withoutCache = (blocks: NativeMessage['content']) => blocks.map(({ cache_control: _owned, ...block }) => block)
      assert.deepEqual(withoutCache(firstUser.content.slice(0, 3)), withoutCache(body.messages[0]!.content))
      assert.deepEqual(firstUser.content.flatMap((block, index) => block.cache_control ? [index] : []), [firstUser.content.length - 1])
      const snapshot = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
      assert.equal(snapshot.cacheGenerationId, saved.cacheGenerationId)
      client = makeClient({}, { prior: snapshot }).client
    }
    assert.equal(bodies.length, 4)
  }))
}

for (const changed of ['text', 'image', 'internal_boundary'] as const) {
  test(`genuine legacy BP3 cannot conceal a changed historical ${changed}`, async () => withHttp(async bodies => {
    const { original, saved } = await publishLegacyBp3(false)
    const client = makeClient({}, { prior: saved }).client
    const next = structuredClone(original)
    const user = next.messages[1]!
    assert.ok(user.role === 'user' && Array.isArray(user.content))
    if (changed === 'text') user.content[0] = { type: 'text', text: 'rewritten legacy task' }
    if (changed === 'image') user.content[1] = { type: 'image_url', image_url: { url: 'data:image/png;base64,bmV3' } }
    if (changed === 'internal_boundary') user.content.push({ type: 'text', text: 'not a new source message' })
    next.messages.push({ role: 'user', content: 'continue' })
    await assert.rejects(client.stream(next, callbacks), /prefix diverged|cache.*anchor/)
    assert.equal(bodies.length, 1)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
  }))
}

test('owned BP4 relocation preserves the entire old prefix and survives a fresh snapshot restore', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const generation = client.getMainPrefixProof!()!.cacheGenerationId
  const next: OaiChatRequest = { ...original, messages: [...original.messages,
    { role: 'user', content: Array.from({ length: 20 }, (_, index) => ({ type: 'text', text: `new block ${index}` })) },
    { role: 'assistant', content: 'new rolling cache anchor' }, { role: 'user', content: 'continue' },
  ] }
  await assert.doesNotReject(client.stream(next, callbacks))
  assert.equal(bodies[1]!.messages[1]!.content.at(-1)!.cache_control, undefined)
  assert.deepEqual(bodies[1]!.messages[3]!.content.at(-1)!.cache_control, { type: 'ephemeral' })
  assert.deepEqual(bodies[1]!.messages[2]!.content.slice(0, 3), bodies[0]!.messages[2]!.content)
  const saved = JSON.parse(JSON.stringify(client.getMainPrefixProof!()!))
  const restored = makeClient({}, { prior: saved }).client
  await restored.stream({ ...next, messages: [...next.messages, { role: 'user', content: 'after resume' }] }, callbacks)
  assert.equal(bodies.length, 3)
  assert.equal(restored.getMainPrefixProof!()!.cacheGenerationId, generation)
}))

for (const changed of ['assistant', 'tool_result', 'image'] as const) {
  test(`BP4 rotation cannot excuse a simultaneous ${changed} rewrite`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    const next = structuredClone(original)
    if (changed === 'assistant') next.messages[2]!.content = 'rewritten historical assistant'
    if (changed === 'tool_result') next.messages[3]!.content = 'rewritten historical tool result'
    if (changed === 'image') next.messages[4]!.content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,bmV3' } }]
    next.messages.push({ role: 'user', content: Array.from({ length: 20 }, (_, index) => ({ type: 'text', text: `new block ${index}` })) })
    await assert.rejects(client.stream(next, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
  }))
}

for (const forged of ['bp3_position', 'bp4_position', 'duplicate', 'unknown_value'] as const) {
  test(`a well-shaped forged ${forged} layout cannot authorize a historical rewrite`, async () => withHttp(async bodies => {
    const { client } = makeClient()
    const original = request()
    await client.stream(original, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    assert.ok(saved.nativeCacheLayout)
    const bp3 = saved.nativeCacheLayout.find(entry => entry.kind === 3)!
    const bp4 = saved.nativeCacheLayout.find(entry => entry.kind === 4)!
    if (forged === 'bp3_position') bp3.blockIndex = 1
    if (forged === 'bp4_position') bp4.blockIndex = 0
    if (forged === 'duplicate') saved.nativeCacheLayout.push({ ...bp4 })
    if (forged === 'unknown_value') bp4.valueHash = 'a'.repeat(64)
    const restored = makeClient().client
    if (forged === 'duplicate' || forged === 'unknown_value') assert.throws(() => restored.restoreExecutionSnapshot!(saved), /snapshot/)
    else {
      restored.restoreExecutionSnapshot!(saved)
      await assert.rejects(restored.stream({ ...original, messages: [...original.messages, { role: 'user', content:
        Array.from({ length: 20 }, () => ({ type: 'text', text: 'new' })),
      }] }, callbacks), /prefix diverged|cache.*anchor/)
    }
    assert.equal(bodies.length, 1)
  }))
}

test('a non-converter cannot manufacture ownership by copying valid-looking native source and cache fields', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  const converter = new AnthropicClient(config)
  const adapter = withExecutionContinuity({ async stream(next: OaiChatRequest) {
    currentExecutionScope()!.nativeSourceBoundaries = { source: proveCanonicalSource(next.messages), cacheLayout: structuredClone(saved.nativeCacheLayout!), boundaries: [
      { messageIndex: 1, blockCount: 1, sourceCount: 2 },
      { messageIndex: 3, blockCount: 1, sourceCount: 4 },
      { messageIndex: 3, blockCount: 3, sourceCount: 5 },
    ] }
    await fetchWithTimeout(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': config.apiKey },
      body: JSON.stringify(converter.buildRequestBodyForTest(next)),
    })
  } }, { provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default', prior: saved })
  await assert.rejects(adapter.stream(original, callbacks), /native.*evidence/i)
  assert.equal(bodies.length, 1)
  assert.deepEqual(adapter.getMainPrefixProof!(), saved)
}))

test('source-identical image eviction plus owned BP4 rotation fails the combined complete-prefix proof', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  original.messages.at(-1)!.content = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(16_384)}` } }]
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  config.maxBodyBytes = 2048
  await assert.rejects(client.stream({ ...original, messages: [...original.messages, { role: 'user', content:
    Array.from({ length: 20 }, () => ({ type: 'text', text: 'new' })),
  }] }, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.deepEqual(client.getMainPrefixProof!(), saved)
}))

test('durable generation reasons remain an explicit three-value whitelist', async () => withHttp(async () => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const prior = structuredClone(client.getMainPrefixProof!()!)
  const authorization = { version: 1, cacheGenerationId: 'explicit-new-generation', model, history: proveRewindHistory(original.messages), prior }
  for (const reason of ['explicit_user_rewind', 'context_limit', 'explicit_user_compact']) assert.equal(isRewindGenerationAuthorization({ ...authorization, reason }), true)
  for (const reason of ['prefix_error', 'retry', '', 'context_limit_fallback']) assert.equal(isRewindGenerationAuthorization({ ...authorization, reason }), false)
}))

for (const omitted of ['all', 'bp3'] as const) test(`an omitted owned ${omitted} cache marker cannot hide in an otherwise identical snapshot`, async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  saved.nativeCacheLayout = omitted === 'all' ? [] : saved.nativeCacheLayout!.filter(entry => entry.kind !== 3)
  const restored = makeClient({}, { prior: saved }).client
  await assert.rejects(restored.stream(original, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 1)
}))

test('dry validation reaches the genuine legacy serializer without HTTP, snapshot commit or baseline changes', async () => withHttp(async bodies => {
  const { original, saved } = await publishLegacyBp3(true)
  const client = makeClient({}, { prior: saved }).client
  const before = structuredClone(client.getMainPrefixProof!()!)
  let commits = 0
  const next = { ...original, onExecutionSnapshot() { commits++ }, messages: [...original.messages, { role: 'user' as const, content: 'continue' }] }
  await assert.doesNotReject(executionContinuity.validateExecutionHistory(client, next))
  assert.equal(bodies.length, 1)
  assert.equal(commits, 0)
  assert.deepEqual(client.getMainPrefixProof!(), before)
  await client.stream(next, callbacks)
  assert.equal(bodies.length, 2)
  assert.equal(commits, 1)
}))

for (const changed of ['history', 'model', 'options', 'tools'] as const) {
  test(`dry validation rejects unknown ${changed} without washing the legacy proof`, async () => withHttp(async bodies => {
    const { original, saved } = await publishLegacyBp3(true)
    const client = makeClient({}, { prior: saved }).client
    const next = structuredClone(original)
    if (changed === 'history') next.messages[1]!.content = 'unpublished old-history change'
    if (changed === 'model') next.model = 'other-model'
    if (changed === 'options') next.max_tokens = 1024
    if (changed === 'tools') next.tools = request().tools
    let commits = 0
    next.onExecutionSnapshot = () => { commits++ }
    await assert.rejects(executionContinuity.validateExecutionHistory(client, next), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.equal(commits, 0)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
  }))
}

test('dry validation does not poison a single-attempt worker after either acceptance or rejection', async () => withHttp(async bodies => {
  const { client } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  const saved = structuredClone(client.getMainPrefixProof!()!)
  const worker = makeClient({}, { prior: saved, singleAttempt: true }).client
  const changed = structuredClone(original)
  changed.messages[3]!.content = 'unknown tool result'
  await assert.rejects(executionContinuity.validateExecutionHistory(worker, changed), /prefix diverged/)
  await executionContinuity.validateExecutionHistory(worker, original)
  assert.equal(bodies.length, 1)
  assert.deepEqual(worker.getMainPrefixProof!(), saved)
  await worker.stream(original, callbacks)
  assert.equal(bodies.length, 2)
}))

test('dry validation of a restored legacy OpenAI worker cannot spend its first-restore drift authorization', async () => withHttp(async bodies => {
  const makeOpenAI = (singleAttempt = false) => withExecutionContinuity(new OpenAIClient({ providerName: 'fixture-openai', baseUrl,
    apiKey: 'fixture-key', model, maxTokens: 2048, maxRetries: 0, thinking: 'disabled' }), {
    provider: 'fixture-openai', model, credentialScope: 'fixture:default', singleAttempt,
  })
  const original = request()
  const publisher = makeOpenAI()
  await publisher.stream(original, callbacks)
  const saved = structuredClone(publisher.getMainPrefixProof!()!)
  assert.equal(saved.version, 2)
  assert.equal(saved.canonicalSource, undefined)
  assert.equal(saved.nativeTail, undefined)
  const worker = makeOpenAI(true)
  worker.restoreExecutionSnapshot!(saved)
  let commits = 0
  const changed = { ...original, messages: structuredClone(original.messages), onExecutionSnapshot() { commits++ } }
  changed.messages[1]!.content = 'legacy restored user drift'
  await assert.rejects(executionContinuity.validateExecutionHistory(worker, changed), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.equal(commits, 0)
  assert.deepEqual(worker.getMainPrefixProof!(), saved)
  await executionContinuity.validateExecutionHistory(worker, original)
  assert.equal(bodies.length, 1)
  assert.deepEqual(worker.getMainPrefixProof!(), saved)
  await worker.stream(changed, callbacks)
  assert.equal(bodies.length, 2)
  assert.equal(commits, 1)
  assert.notEqual(worker.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
  assert.equal(worker.getMainPrefixProof!()!.generationReason, 'resume_prefix_drift')
}, () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
  headers: { 'content-type': 'text/event-stream' },
}), '/chat/completions'))

test('dry validation traverses every nested guard and also works through a stream-only forwarding wrapper', async () => withHttp(async bodies => {
  const { original, saved } = await publishLegacyBp3(true)
  const child = makeClient({}, { prior: saved, expectedPrincipal: 'wrong-principal' }).client
  const parent = withExecutionContinuity({ stream: child.stream.bind(child) }, {
    provider: 'unrelated-provider-alias', model, credentialScope: 'fixture:default', prior: saved,
  })
  await assert.rejects(executionContinuity.validateExecutionHistory(parent, original), /credential owner/)
  assert.deepEqual(parent.getMainPrefixProof!(), saved)
  assert.deepEqual(child.getMainPrefixProof!(), saved)
  const actual = makeClient({}, { prior: saved }).client
  const forwarding = { stream: actual.stream.bind(actual) }
  await executionContinuity.validateExecutionHistory(forwarding, original)
  assert.deepEqual(actual.getMainPrefixProof!(), saved)
  assert.equal(bodies.length, 1)
}))

test('dry validation of a bare transport fails before HTTP rather than treating missing guards as success', async () => withHttp(async bodies => {
  const raw = new AnthropicClient({ baseUrl, apiKey: 'fixture-key', model, maxTokens: 2048, maxRetries: 0 })
  await assert.rejects(executionContinuity.validateExecutionHistory(raw, request()), /protected.*boundary|baseline|guard/)
  assert.equal(bodies.length, 0)
}))

test('dry validation crosses the real fallback wrapper as a non-retryable policy without changing its active client', async () => withHttp(async bodies => {
  const { original, saved } = await publishLegacyBp3(true)
  const budget = new RetryBudget({ maxAttempts: 5 })
  let fallbackCreates = 0
  let fallbackEvents = 0
  let commits = 0
  const primary = makeClient({ maxRetries: 5, retryBudget: () => budget }, { prior: saved }).client
  const failures: Array<{ retryable: boolean; category: string }> = []
  const forwarding = new Proxy(primary, { get(target, property) {
    if (property === 'stream') return async (...args: Parameters<typeof primary.stream>) => {
      try { await primary.stream(...args) } catch (error) {
        const classified = classifyApiError(error)
        failures.push({ retryable: classified.retryable, category: classified.category })
        throw error
      }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const fallback = new FallbackStreamClient(forwarding, 'primary', [{ name: 'must-not-create', create() {
    fallbackCreates++
    throw new Error('dry validation must not switch model')
  } }], () => { fallbackEvents++ })
  const next = { ...original, onExecutionSnapshot() { commits++ }, messages: [...original.messages,
    { role: 'user' as const, content: Array.from({ length: 20 }, () => ({ type: 'text' as const, text: 'continue' })) },
  ] }
  await executionContinuity.validateExecutionHistory(fallback, next)
  const changed = { ...next, messages: structuredClone(next.messages) }
  changed.messages[1]!.content = 'unknown historical rewrite'
  await assert.rejects(executionContinuity.validateExecutionHistory(fallback, changed), /prefix diverged/)
  assert.equal(bodies.length, 1)
  assert.equal(commits, 0)
  assert.equal(budget.remaining(), 5)
  assert.equal(fallbackCreates, 0)
  assert.equal(fallbackEvents, 0)
  assert.deepEqual(failures, Array.from({ length: 2 }, () => ({ retryable: false, category: 'request_invariant' })))
  assert.deepEqual(primary.getMainPrefixProof!(), saved)
  assert.deepEqual(fallback.getMainPrefixProof!(), saved)
  await fallback.stream(next, callbacks)
  assert.equal(bodies.length, 2)
  assert.equal(commits, 1)
  assert.equal(fallback.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
}))

test('dry validation cannot bless a protected client without a previously published baseline', async () => withHttp(async bodies => {
  const { client } = makeClient()
  await assert.rejects(executionContinuity.validateExecutionHistory(client, request()), /baseline/)
  assert.equal(bodies.length, 0)
  assert.equal(client.getMainPrefixProof!(), undefined)
  await client.stream(request(), callbacks)
  assert.equal(bodies.length, 1)
}))

test('dry validation does not consume the real Anthropic private body-guard notice state', async () => withHttp(async bodies => {
  const { client, config } = makeClient()
  const original = request()
  await client.stream(original, callbacks)
  config.maxBodyBytes = Buffer.byteLength(JSON.stringify(bodies[0])) + 10
  const before = structuredClone(client.getMainPrefixProof!()!)
  await executionContinuity.validateExecutionHistory(client, original)
  assert.equal(bodies.length, 1)
  assert.deepEqual(client.getMainPrefixProof!(), before)
  const notices: string[] = []
  await client.stream(original, { ...callbacks, onBodyGuard(notice) { notices.push(notice.kind) } })
  assert.deepEqual(notices, ['near-limit'])
  assert.equal(bodies.length, 2)
}))

test('dry validation through real OpenAI fallback leaves its private attempt audit unchanged', async () => {
  let responses = 0
  await withHttp(async bodies => {
    const budget = new RetryBudget({ maxAttempts: 5 })
    const primary = withExecutionContinuity(new OpenAIClient({ providerName: 'fixture-openai', baseUrl,
      apiKey: 'fixture-key', model, maxTokens: 2048, maxRetries: 5, thinking: 'disabled', retryBudget: () => budget }), {
      provider: 'fixture-openai', model, credentialScope: 'fixture:default',
    })
    const fallback = new FallbackStreamClient(primary, 'primary', [{ name: 'must-not-create', create() {
      assert.fail('validation must not activate fallback')
    } }])
    const original = request()
    await fallback.stream(original, callbacks)
    const before = structuredClone(primary.getMainPrefixProof!()!)
    const auditPath = join(process.env.RIVET_HOME!, 'logs', 'provider-calls.jsonl')
    const audit = readFileSync(auditPath, 'utf8')
    const initial = audit.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.requestId === before.requestId)
    assert.deepEqual(initial.map(row => [row.phase, row.status]), [['started', undefined], ['finished', 'complete']])
    let commits = 0
    const next = { ...original, onExecutionSnapshot() { commits++ } }
    await executionContinuity.validateExecutionHistory(fallback, next)
    const changed = { ...next, messages: structuredClone(next.messages) }
    changed.messages[1]!.content = 'unknown old user'
    await assert.rejects(executionContinuity.validateExecutionHistory(fallback, changed), /prefix diverged/)
    assert.equal(bodies.length, 1)
    assert.equal(commits, 0)
    assert.equal(budget.remaining(), 5)
    assert.deepEqual(primary.getMainPrefixProof!(), before)
    assert.equal(readFileSync(auditPath, 'utf8'), audit)
    const forgedFlags = { ...next, validationOnly: true, validateOnly: true }
    await fallback.stream(forgedFlags, callbacks)
    assert.equal(bodies.length, 2)
    assert.equal(commits, 1)
    assert.equal(primary.getMainPrefixProof!()!.cacheGenerationId, before.cacheGenerationId)
    const successAudit = readFileSync(auditPath, 'utf8')
    const success = successAudit.slice(audit.length).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(success.map(row => [row.phase, row.status]), [['started', undefined], ['finished', 'complete']])
    await assert.rejects(fallback.stream(original, callbacks), /401/)
    assert.equal(bodies.length, 3)
    assert.equal(commits, 1)
    assert.equal(budget.remaining(), 5)
    const failed = readFileSync(auditPath, 'utf8').slice(successAudit.length).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(failed.map(row => [row.phase, row.status]), [['started', undefined], ['finished', 'failed']])
  }, () => ++responses === 3 ? new Response('fixture denied', { status: 401 }) : new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), '/chat/completions')
})
