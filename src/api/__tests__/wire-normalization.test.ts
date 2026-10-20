import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity } from '../execution-continuity.js'
import { normalizeWireMessages, OPENAI_WIRE_TRANSFORM_VERSION } from '../wire-normalization.js'
import { sanitizeMessageContent } from '../../utils/sanitize.js'
import type { OaiChatRequest, OaiMessage } from '../oai-types.js'
import { isCompleteExecutionSnapshot } from '../continuation-prefix.js'

const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }
const unicode = ['ASCII', '中文', 'é', 'e\u0301', 'a\u0308\u0301', '\x00\x85', '\uD800', '😀']

test('copy-on-write shares clean branches, preserves frozen inputs and is idempotent', () => {
  const clean = Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: '中文😀é' }]), count: NaN })
  assert.equal(sanitizeMessageContent(clean), clean)
  const dirty = Object.freeze({ clean, text: 'e\u0301\x00' })
  const normalized = sanitizeMessageContent(dirty)
  assert.notEqual(normalized, dirty)
  assert.equal(normalized.clean, clean)
  assert.equal(normalized.text, 'é ')
  assert.equal(dirty.text, 'e\u0301\x00')
  assert.equal(sanitizeMessageContent(normalized), normalized)
  const special = JSON.parse('{"__proto__":"e\\u0301"}')
  assert.equal(Object.getOwnPropertyDescriptor(sanitizeMessageContent(special), '__proto__')!.value, 'é')
  assert.equal(Object.getPrototypeOf(sanitizeMessageContent(special)), Object.prototype)
})

for (const declared of [false, true]) test(`configured retries retain canonical messages after echo recovery, image stripping and 500 (preserved=${declared})`, async t => {
  const client = new OpenAIClient({ apiKey: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', maxTokens: 4096,
    thinking: 'enabled', preservedThinkingProtocol: declared, maxRetries: 4,
    retry: { overrides: { image_strip: { maxRetries: 3 } }, backoff: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
  const bodies: Array<{ messages: OaiMessage[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) return Response.json({ error: { message: 'reasoning_content must be passed back in thinking mode' } }, { status: 400 })
    if (bodies.length === 2) return Response.json({ error: { message: 'Could not process image' } }, { status: 400 })
    if (bodies.length === 3) return new Response('temporarily unavailable', { status: 500 })
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const request: OaiChatRequest = { model: 'fixture', messages: [
    { role: 'system', content: 'system e\u0301' },
    { role: 'user', content: [{ type: 'text', text: 'page e\u0301\x00' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: '', reasoning_content: 'reason e\u0301', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'result' },
  ] }
  const original = structuredClone(request)
  let echoed = 0, stripped = 0
  await client.stream(request, { ...callbacks, onReasoningEchoRecovered() { echoed++ }, onImageStripped() { stripped++ } })
  assert.equal(bodies.length, 4)
  assert.equal(echoed, 1); assert.equal(stripped, 1)
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.messages[0]!.content, bodies[0]!.messages[0]!.content, 'system suffix is present exactly once even after reconstruction')
    const assistant = body.messages.find(message => message.role === 'assistant')!
    assert.equal(assistant.role === 'assistant' && assistant.reasoning_content, declared || index > 0 ? 'reason é' : undefined)
    assert.equal(JSON.stringify(body.messages), JSON.stringify(sanitizeMessageContent(body.messages)))
  }
  for (const body of bodies.slice(2)) assert.doesNotMatch(JSON.stringify(body.messages), /image_url|data:image/)
  assert.deepEqual(request, original)
})

test('partial reasoning appended during retry is normalized without rerunning stripping transforms', async t => {
  const client = new OpenAIClient({ apiKey: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', maxTokens: 4096,
    thinking: 'enabled', maxRetries: 1, retry: { backoff: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
  const bodies: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const frame = bodies.length === 1
      ? `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'partial e\u0301\x00' } }] })}\n\n`
      : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    return new Response(frame, { headers: { 'content-type': 'text/event-stream' } })
  })
  await client.stream({ model: 'fixture', messages: [{ role: 'user', content: 'task' }] }, callbacks)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1]!.messages.at(-1)!.reasoning_content, 'partial é ')
})

for (const content of unicode) test(`normalization scans and reports content changes without retaining text (${JSON.stringify(content)})`, () => {
  const input: OaiMessage[] = [{ role: 'user', content }]
  const output = normalizeWireMessages(input)
  assert.equal(output.messages[0]!.content, sanitizeMessageContent(content))
  assert.equal(output.normalization.version, OPENAI_WIRE_TRANSFORM_VERSION)
  assert.equal(output.normalization.changedMessages, content === sanitizeMessageContent(content) ? 0 : 1)
  assert.equal(output.normalization.deltaChars, JSON.stringify(output.messages[0]).length - JSON.stringify(input[0]).length)
  if (output.normalization.changedMessages) {
    assert.equal(output.normalization.firstChangedMessage, 0)
    assert.equal(typeof output.normalization.firstChangedOffset, 'number')
  } else assert.equal(output.messages, input)
  assert.equal(normalizeWireMessages(output.messages).messages, output.messages)
})

for (const size of [6_000, 150_000, 999_999, 1_000_001]) test(`preview, side paths, rebuilt arrays and reentry share canonical wire history (${size})`, async t => {
  const raw = new OpenAIClient({ apiKey: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1',
    thinking: 'enabled', preservedThinkingProtocol: true, maxRetries: 0, maxTokens: 4096 })
  const client = withExecutionContinuity(raw, { provider: 'fixture', model: 'fixture' })
  const bodies: Array<{ messages: OaiMessage[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const request: OaiChatRequest = { model: 'fixture', prefixProbe: true, continuityEvidence: { sourcePrefix: 'same', renderPrefix: 'same' },
    messages: [{ role: 'system', content: 'system e\u0301' }, { role: 'user', content: unicode.join(' ') + 'x'.repeat(size) }] }
  const original = structuredClone(request)
  const preview = client.previewContextRequest!(request)
  assert.deepEqual(client.previewContextRequest!(request), preview)
  assert.equal(client.getMainPrefixProof!(), undefined)
  await client.stream(request, callbacks)
  assert.deepEqual(bodies[0]!.messages, preview.messages)
  assert.equal(String(bodies[0]!.messages[0]!.content).split('请在内部思考链中使用中文进行推理').length, 2, 'the stable suffix is present exactly once')
  const baseline = client.getMainPrefixProof!()
  assert.equal(baseline!.wireTransformVersion, OPENAI_WIRE_TRANSFORM_VERSION)
  const legacy = structuredClone(baseline!)
  delete legacy.wireTransformVersion
  assert.equal(isCompleteExecutionSnapshot(legacy), true, 'legacy evidence stays readable without a transform version')
  assert.equal(isCompleteExecutionSnapshot({ ...legacy, wireTransformVersion: null }), false)
  await client.stream({ ...request, prefixProbe: false, messages: [{ role: 'user', content: 'side path e\u0301' }] }, callbacks)
  assert.equal(client.getMainPrefixProof!(), baseline)
  await client.stream(request, callbacks)
  const next = { ...request, messages: [...structuredClone(request.messages), { role: 'assistant' as const, content: 'ok' }] }
  client.previewContextRequest!(next)
  await client.stream(next, callbacks)
  assert.deepEqual(bodies[2]!.messages, bodies[0]!.messages)
  assert.deepEqual(bodies[3]!.messages.slice(0, request.messages.length), bodies[0]!.messages)
  assert.deepEqual(request, original)
  for (const body of bodies) assert.doesNotMatch(JSON.stringify(body), /continuityEvidence|wireTransformVersion|firstChangedOffset/)
})
