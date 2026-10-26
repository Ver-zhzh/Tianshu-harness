import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestObservation, measureRequestImages } from '../request-observability.js'
import { ProviderToolProgress, ToolInputProgressEmitter, type ToolInputProgress } from '../tool-input-progress.js'
import { OpenAIClient } from '../openai-client.js'

test('reasoning, first text and tool input have independent monotonic milestones', () => {
  let time = 100
  const observation = new RequestObservation(() => time)
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aaaa' } }] }] }
  const serialized = JSON.stringify(body)
  time = 110; observation.sent(serialized, body)
  time = 120; observation.output('thinking')
  time = 450; observation.output('tool')
  time = 800; observation.output('text')
  time = 900; observation.output('text')
  assert.deepEqual(observation.snapshot(), { requestPreparationMs: 10, requestBodyBytes: Buffer.byteLength(serialized),
    imageCount: 1, imageBytes: 26, firstOutputMs: 20, firstToolInputMs: 350, firstTextMs: 700, requestDurationMs: 800 })
  assert.equal(JSON.stringify(body), serialized)
  const retry = new RequestObservation(() => time)
  assert.deepEqual(retry.snapshot(), { requestDurationMs: 0 })
})

test('all native image shapes count encoded bytes without recording payloads', () => {
  assert.deepEqual(measureRequestImages({ messages: [{ source: { type: 'base64', data: 'aaaa' }, type: 'image' }],
    contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'bbbb' } }] }] }), { imageCount: 2, imageBytes: 8 })
})

test('real OpenAI parser publishes progress before arguments become valid JSON', () => {
  const client = new OpenAIClient({ baseUrl: 'https://fixture.invalid/v1', model: 'test', apiKey: 'fixture' } as never)
  const events: ToolInputProgress[] = [], blocks: unknown[] = []
  const cb = { onToolInputProgress: (p: ToolInputProgress) => events.push(p), onContentBlock: (b: unknown) => blocks.push(b) }
  client.processDelta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'write_file', arguments: '{"content":"' } }] }, finish_reason: null }] }, cb)
  assert.equal(events[0]?.toolName, 'write_file')
  assert.equal(events[0]?.state, 'generating')
  assert.equal(events[0]?.argumentBytes, 12)
  assert.equal(blocks.length, 0, 'incomplete inputs must never become executable blocks')
  client.processDelta({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '你好"}' } }] }, finish_reason: 'tool_calls' }] }, cb)
  assert.equal(events.at(-1)?.state, 'complete')
  assert.equal(events.at(-1)?.argumentBytes, Buffer.byteLength('{"content":"你好"}'))
  assert.equal(blocks.length, 1)
  assert.ok(events.every(p => !JSON.stringify(p).includes('content')))
})

test('progress coalesces to 100ms and terminals supersede queued progress', () => {
  let time = 0
  const events: ToolInputProgress[] = []
  const emitter = new ToolInputProgressEmitter(p => events.push(p), () => time)
  const base = { toolCallId: 't', attemptId: 'a', toolName: 'bash', state: 'generating' as const }
  emitter.push({ ...base, argumentBytes: 1, raw: 'must not leak' } as ToolInputProgress)
  for (let i = 2; i <= 100; i++) emitter.push({ ...base, argumentBytes: i })
  assert.equal(events.length, 1)
  time = 100; emitter.push({ ...base, argumentBytes: 101 })
  assert.equal(events.length, 2)
  emitter.push({ ...base, argumentBytes: 102, state: 'aborted' })
  emitter.flush(); emitter.close()
  assert.equal(events.length, 3)
  assert.equal(events.at(-1)?.state, 'aborted')
  assert.doesNotMatch(JSON.stringify(events), /must not leak|raw/)
})

test('Responses item identity joins argument deltas and completion', () => {
  const counter = new ProviderToolProgress({ attemptId: 'a' }), events: ToolInputProgress[] = []
  const emit = (p: ToolInputProgress) => events.push(p)
  counter.responses({ type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'bash' } }, emit)
  counter.responses({ type: 'response.function_call_arguments.delta', item_id: 'item', delta: '{' }, emit)
  counter.responses({ type: 'response.output_item.done', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'bash', arguments: '{}' } }, emit)
  assert.deepEqual(events.map(e => e.toolCallId), ['call', 'call', 'call'])
  assert.deepEqual(events.map(e => e.argumentBytes), [0, 1, 2])
})

test('a new tool reusing a completed slot starts independent byte counters', () => {
  const counter = new ProviderToolProgress(), events: ToolInputProgress[] = []
  const emit = (p: ToolInputProgress) => events.push(p)
  counter.update('0', undefined, undefined, '{', emit)
  assert.equal(events.length, 0, 'a provisional slot must not create a different UI identity')
  counter.update('0', 'first', 'bash', '}', emit, 'complete')
  counter.update('0', 'second', 'write_file', '{', emit)
  assert.equal(events.at(-1)?.argumentBytes, 1)
  assert.equal(events.at(-1)?.toolCallId, 'second')
})

test('Responses deltas identified only by output index use the original call identity', () => {
  const counter = new ProviderToolProgress(), events: ToolInputProgress[] = []
  const emit = (p: ToolInputProgress) => events.push(p)
  counter.responses({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'item2', call_id: 'call2', name: 'bash' } }, emit)
  counter.responses({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a":1}' }, emit)
  assert.deepEqual(events.map(e => e.toolCallId), ['call2', 'call2'])
  assert.equal(events.at(-1)?.toolName, 'bash')
})

test('an earlier timer cannot flush a newly queued update within 100ms of an immediate update', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const events: Array<{ at: number; bytes: number }> = []
  const emitter = new ToolInputProgressEmitter(p => events.push({ at: Date.now(), bytes: p.argumentBytes }))
  t.after(() => emitter.close())
  const send = (bytes: number) => emitter.push({ toolCallId: 't', toolName: 'bash', argumentBytes: bytes, state: 'generating' })
  send(1)
  t.mock.timers.tick(1); send(2) // A timer is now due at 101ms.
  t.mock.timers.setTime(100); send(3) // A late timer has not run yet; the update is immediate.
  send(4)
  t.mock.timers.tick(1)
  assert.deepEqual(events, [{ at: 0, bytes: 1 }, { at: 100, bytes: 3 }])
  t.mock.timers.tick(99)
  assert.deepEqual(events.at(-1), { at: 200, bytes: 4 })
})
