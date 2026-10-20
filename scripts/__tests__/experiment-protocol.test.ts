import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompletionLedger, checkEvidence, type Stage } from '../experiments/experiment-protocol.js'
import { contract, resolveCapability } from '../experiments/experiment-capabilities.js'
import { deliveryOutcome } from '../experiments/scoped-hook-outcomes.js'

const home = mkdtempSync(join(tmpdir(), 'rivet-protocol-tests-'))
const saved = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
process.env.RIVET_HOME = home; process.env.RIVET_SESSION_DIR = join(home, 'sessions'); writeFileSync(join(home, 'config.json'), '{}')
const { productionClient, productionProfile, streamAttempt, experimentRequest, assistantMessage, qualifyTransport } = await import('../experiments/experiment-stream.js')
const { PromptEngine } = await import('../../src/prompt/engine.js')
const { PROVIDER_PRESETS } = await import('../../src/config/provider-presets.js')
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }; rmSync(home, { recursive: true, force: true }) })

test('full request reservation never shrinks to a tail allowance; reasoning is a subset', () => {
  const l = new CompletionLedger(100, 200)
  assert.equal(l.admit(), true); l.settle({ output_tokens: 80, reasoning_tokens: 70 })
  assert.equal(l.spent, 80); assert.equal(l.admit(), true); l.settle({ output_tokens: 30 })
  assert.equal(l.admit(), false); assert.equal(l.spent, 110); assert.equal(l.requestLimit, 100)
})
test('unknown or estimated usage retains a reservation and blocks another send', () => {
  for (const usage of [undefined, { input_tokens: 2 }, { output_tokens: 1, estimated: true }]) {
    const l = new CompletionLedger(100); l.admit(); l.settle(usage)
    assert.equal(l.reserved, 100); assert.equal(l.uncertain, true); assert.equal(l.admit(), false)
  }
})
test('task outcome contract recognizes timeout and preserves unknown statuses as inconclusive', () => {
  assert.equal(deliveryOutcome('timeout'), 'stopped'); assert.equal(deliveryOutcome('timed_out'), 'stopped')
  assert.equal(deliveryOutcome('committed'), 'success'); assert.equal(deliveryOutcome('unregistered-success-word'), 'unknown')
})
test('unexecuted, skipped and protected changes cannot create complete proof', () => {
  const passed: Stage = { id: 'tests', required: true, executed: true, exit: 0, timedOut: false, output: '', origin: 'candidate', tests: { passed: 1, failed: 0, skipped: 0 } }
  assert.equal(checkEvidence('a', 'a', true, [passed]).passed, true)
  for (const stage of [{ ...passed, executed: false }, { ...passed, tests: { passed: 0, failed: 0, skipped: 1 } }, { ...passed, tests: { passed: 0, failed: 0, skipped: 0 } }]) assert.equal(checkEvidence('a', 'a', true, [stage]).complete, false)
  assert.equal(checkEvidence('a', 'a', false, [passed]).complete, false)
  assert.equal(checkEvidence('a', 'b', true, [passed]).complete, false)
  assert.equal(checkEvidence('a', 'a', true, []).complete, false)
})
test('one path policy permits generated reads and Unicode, rejects writes and symlink escape', () => {
  const root = join(home, 'workspace'); mkdirSync(join(root, '.build'), { recursive: true }); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'))
  const c = contract({ 'src/a.ts': '', 'README.md': '' }, ['.build'])
  writeFileSync(join(root, '.build/a.mjs'), 'generated'); writeFileSync(join(root, 'src/中文 空格.ts'), 'source')
  assert.doesNotThrow(() => resolveCapability(root, '.build/a.mjs', 'read', c))
  assert.equal(resolveCapability(root, '.build/a.mjs', 'read', c).path, '.build/a.mjs')
  assert.equal(resolveCapability(root, 'src/中文 空格.ts', 'read', c).path, 'src/中文 空格.ts')
  assert.throws(() => resolveCapability(root, '.build/a.mjs', 'write', c), /read-only/)
  assert.throws(() => resolveCapability(root, 'src', 'read', c), /directory.*list_files/)
  assert.throws(() => resolveCapability(root, 'src/missing.ts', 'read', c), /does not exist/)
  symlinkSync(home, join(root, 'src/escape')); assert.throws(() => resolveCapability(root, 'src/escape/config.json', 'read', c), /real path leaves/)
  symlinkSync(join(root, '.build/a.mjs'), join(root, 'src/generated-alias'))
  assert.throws(() => resolveCapability(root, 'src/generated-alias', 'write', c), /read-only/)
})

const flush = () => new Promise<void>(r => setImmediate(r))
async function fakeStream(stop: 'stop' | 'length', idle = false, partial = false, cancelled = false, toolsOnStop = false, badName = false) {
  const provider = PROVIDER_PRESETS.deepseek.provider, profile = productionProfile(provider, 'deepseek-flash')
  const { client, policy } = productionClient(provider, 'fixture-only', profile.model, 'fixture-' + stop)
  const ledger = new CompletionLedger(profile.maxTokens)
  let control!: ReadableStreamDefaultController<Uint8Array>, sends = 0, progress = 0
  const encode = (x: unknown) => new TextEncoder().encode('data: ' + JSON.stringify(x) + '\n\n')
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    sends++; assert.equal(JSON.parse(init.body).max_tokens, profile.maxTokens)
    return new Response(new ReadableStream({ start(c) { control = c; init.signal?.addEventListener('abort', () => c.error(new Error('fixture abort')), { once: true }); c.enqueue(encode({ id: 'fixture-response', model: profile.model, choices: [{ delta: { reasoning_content: 'fixture reasoning' } }] })) } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  try {
    const abort = new AbortController()
    const promise = streamAttempt(client, { model: profile.model, max_tokens: profile.maxTokens, messages: [{ role: 'user', content: 'fixture' }], tools: [{ type: 'function', function: { name: 'write_file', description: 'fixture', parameters: { type: 'object', properties: {} } } }], stream: true }, ledger, abort.signal, policy, (e: any) => { if (e.kind === 'stream-progress') progress++ })
    for (let i = 0; i < 30 && !progress; i++) await flush()
    if (!progress) { mock.timers.tick(1_000_000); await flush(); assert.fail('production parser did not receive reasoning: ' + JSON.stringify(await promise)) }
    if (cancelled) { abort.abort(); const result = await promise; assert.equal(sends, 1); return { result, ledger } }
    if (idle) { mock.timers.tick(301_000); await flush() }
    else { mock.timers.tick(60_000); control.enqueue(encode({ choices: [{ delta: { reasoning_content: 'progress' } }] })); await flush(); mock.timers.tick(61_000); await flush() }
    if (!idle) { try { control.enqueue(encode({ choices: [{ delta: { reasoning_content: 'still thinking' } }] })) } catch { assert.fail(JSON.stringify(await promise)) } }
    if (!idle) {
      control.enqueue(encode({ choices: [{ delta: { content: 'answer', tool_calls: stop === 'length' || toolsOnStop ? [{ index: 0, id: 'partial', type: 'function', function: { name: badName ? 'not_a_declared_tool' : 'write_file', arguments: partial ? '{"file_path":' : '{"file_path":"src/a","content":"x"}' } }] : undefined }, finish_reason: stop }], usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } } }))
      control.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); control.close()
    }
    const result = await promise
    assert.equal(sends, 1, 'transport failure must not retry')
    return { result, ledger }
  } finally { mock.timers.reset(); fetchMock.mock.restore() }
}
test('production streaming survives >120s of reasoning, and measured output includes reasoning once', async () => {
  const { result, ledger } = await fakeStream('stop')
  assert.equal(result.status, 'final'); assert.equal(ledger.spent, 20); assert.equal(ledger.uncertain, false)
})
test('a length stop quarantines even syntactically complete tool arguments', async () => {
  for (const partial of [false, true]) { const { result } = await fakeStream('length', false, partial); assert.equal(result.status, 'single-response-limit', JSON.stringify(result)) }
})
test('completed provider tool blocks remain executable even with a stop terminal', async () => {
  const { result } = await fakeStream('stop', false, false, false, true)
  assert.equal(result.status, 'tools'); assert.equal(result.blocks.filter(b => b.type === 'tool_use').length, 1)
})
test('unknown streamed tool names are protocol failures, not network or candidate test failures', async () => {
  const { result, ledger } = await fakeStream('stop', false, false, false, true, true)
  assert.equal(result.status, 'provider-protocol-error'); assert.equal(result.errorName, 'ToolNameProtocolError'); assert.equal(ledger.uncertain, true)
})
test('cancellation reaches the production transport without replay or zero charging', async () => {
  const { result, ledger } = await fakeStream('stop', false, false, true)
  assert.equal(result.status, 'deadline-or-cancelled'); assert.equal(ledger.uncertain, true)
})
test('a genuinely idle stream stops with unknown usage retained and no resend', async () => {
  const { result, ledger } = await fakeStream('stop', true)
  assert.equal(result.status, 'transport-error'); assert.equal(ledger.uncertain, true); assert.equal(ledger.reserved, ledger.requestLimit)
})

test('real renderer and production client accept immutable multi-turn dispatch and reject rewritten history before sending', async () => {
  for (const rewrite of [false, true]) {
    const provider = PROVIDER_PRESETS.deepseek.provider, profile = productionProfile(provider, 'deepseek-flash')
    const { client, policy } = productionClient(provider, 'fixture-only', profile.model, 'multi-turn-' + rewrite)
    const engine = new PromptEngine({ model: profile.model, maxTokens: profile.maxTokens, staticCtx: { modelFamily: 'deepseek', tools: [{ name: 'list_files', description: 'fixture', input_schema: { type: 'object', properties: {} } }] }, volatileCtx: { cwd: home } })
    const built = engine.buildOaiRequest([{ role: 'user', content: 'fixture', origin: 'human' }]), wire = structuredClone(built.messages)
    const bodies: any[] = []
    const fetchMock = mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body))
      const delta = bodies.length === 1 ? { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } : { content: 'done' }
      return new Response('data: ' + JSON.stringify({ id: 'fixture-' + bodies.length, model: profile.model, choices: [{ delta, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const ledger = new CompletionLedger(profile.maxTokens), signal = new AbortController().signal
      const firstRequest = experimentRequest(built, wire, profile.model, profile.maxTokens)
      const first = await streamAttempt(client, firstRequest, ledger, signal, policy)
      assert.equal(first.status, 'tools', JSON.stringify(first)); const originalLength = firstRequest.messages.length
      wire.push(assistantMessage(first.blocks), { role: 'tool', tool_call_id: 'call-fixture', content: 'src/file.ts' })
      if (rewrite) wire[1] = { role: 'user', content: 'rewritten' }
      const second = await streamAttempt(client, experimentRequest(built, wire, profile.model, profile.maxTokens), ledger, signal, policy)
      assert.equal(second.status, rewrite ? 'local-request-rejected' : 'final', JSON.stringify(second))
      assert.equal(bodies.length, rewrite ? 1 : 2)
      assert.equal(firstRequest.messages.length, originalLength, 'a dispatched request array must remain immutable')
      assert.equal(ledger.reserved, 0); assert.equal(ledger.uncertain, false)
      assert.equal(engine.getExecutionSnapshot(), undefined, 'the initial renderer callback must not publish a stale snapshot for appended raw history')
    } finally { fetchMock.mock.restore() }
  }
})
test('startup round trip is qualified offline without exposing provider credentials', async () => {
  const result = await qualifyTransport(PROVIDER_PRESETS.deepseek.provider, 'deepseek-flash')
  assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.sends, 2)
})
