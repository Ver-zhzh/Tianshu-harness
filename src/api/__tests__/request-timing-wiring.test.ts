import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAIClient } from '../openai-client.js'
import { readCallAudit } from '../call-audit.js'

test('real streaming HTTP records attempt timings and exact outgoing bytes without content', async t => {
  const root = mkdtempSync(join(tmpdir(), 'request-timing-')), old = process.env.RIVET_HOME
  process.env.RIVET_HOME = root
  t.after(() => { if (old === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = old; rmSync(root, { recursive: true, force: true }) })
  let sent = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = String(init.body)
    const frames = [
      { choices: [{ delta: { reasoning_content: 'private reasoning' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'private answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const client = new OpenAIClient({ baseUrl: 'https://timing.fixture.invalid/v1', apiKey: '', providerName: 'timing-fixture', model: 'm', maxTokens: 64, maxRetries: 0 })
  await client.stream({ model: 'm', messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 64 }, {
    onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { throw error },
  })
  const row = readCallAudit({ model: 'm' }).calls[0]!
  assert.equal(row.requestBodyBytes, Buffer.byteLength(sent))
  assert.ok(row.firstTextMs! >= row.firstOutputMs!)
  assert.ok(row.firstTextMs! >= row.requestPreparationMs!)
  assert.ok(row.requestDurationMs! >= row.firstTextMs!)
  assert.equal(row.firstToolInputMs, undefined)
  assert.doesNotMatch(readFileSync(join(root, 'logs/provider-calls.jsonl'), 'utf8'), /private prompt|private reasoning|private answer/)
})
