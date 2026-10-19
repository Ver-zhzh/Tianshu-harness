import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OaiMessage, OaiChatRequest } from '../../api/oai-types.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import { currentExecutionScope } from '../../api/execution-continuity.js'
import { providerSchema } from '../../config/schema.js'
import { estimateBudgetInput } from '../../context/request-budget.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createAgentConfig } from '../create-agent-config.js'
import { SessionContext } from '../context.js'
import { AgentLoop, type AgentCallbacks } from '../loop.js'
import { SessionPersist } from '../session-persist.js'
import { serializeOaiSessionMessage } from '../session-message-serialization.js'
import { MAX_SESSION_MESSAGE_JSON_CHARS } from '../../compact/constants.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'

const summary = JSON.stringify({ version: 1, summary: 'Prior project inspection is complete; preserve the current human request.', facts: [], requirements: [], pendingApprovals: [] })

async function fixture(context: TestContext, baseUrl: string, contextWindow = 1_000_000) {
  const cwd = mkdtempSync(join(tmpdir(), 'deepseek-context-recovery-'))
  const previous = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
  process.env.RIVET_HOME = join(cwd, 'home')
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  mkdirSync(process.env.RIVET_HOME, { recursive: true })
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  const model = { id: 'deepseek-v4-pro', contextWindow, maxTokens: 256_000 }
  const provider = providerSchema.parse({ name: 'deepseek', baseUrl, protocol: 'openai', maxRetries: 0, models: [model] })
  const config = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS,
    provider, model, apiKey: 'fixture-placeholder', sessionId: 'context-recovery', cwd,
    compact: { enabled: true, model: model.id }, toolDefinitions: [], agentReconnect: { enabled: false, maxAttempts: 0 } })
  const session = new SessionContext()
  const persist = new SessionPersist('context-recovery', cwd)
  const agent = new AgentLoop({ ...config, toolRegistry: new ToolRegistry(), headless: true, maxTurns: 1,
    sessionPersist: persist, interruptMarker: false }, session, cwd)
  const errors: Error[] = []
  const callbacks: AgentCallbacks = {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {},
    onError: error => { errors.push(error) }, onApprovalRequired: async () => false,
  }
  context.after(async () => {
    await agent.cancelIdleCompaction()
    await agent.drainPostSession()
    await agent.drainPersistWrites().catch(() => {})
    await persist.drainFrozenSnapshots()
    agent.stopFsWatcher()
    agent.stopConfigWatcher()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { agent, session, persist, errors, callbacks }
}

function response(content: string, finishReason = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } })
}

function history(length = 40): OaiMessage[] {
  return Array.from({ length }, (_, index): OaiMessage => index % 2 === 0
    ? { role: 'user', origin: 'human', content: `Inspect project section ${index}; preserve all changes.` }
    : { role: 'assistant', content: `Project details ${index}: ${'project data. '.repeat(4000)}` })
}

for (const baseUrl of ['https://api.deepseek.com/v1', 'https://relay.fixture.test/v1']) {
  test(`a million-token history compacts and continues without switching models: ${baseUrl}`, async context => {
    const { agent, session, persist, errors, callbacks } = await fixture(context, baseUrl)
    session.replaceMessages(history(200))
    const before = estimateBudgetInput(session.getMessages()).inputTokens
    assert.ok(before > 1_000_000)
    await persist.compactOaiAsync(session.getMessages(), true)
    let mainCalls = 0, summaryCalls = 0
    context.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), `${baseUrl}/chat/completions`)
      const body = JSON.parse(String(init?.body)) as OaiChatRequest
      assert.equal(body.model, 'deepseek-v4-pro')
      if (body.response_format) { summaryCalls++; return response(summary) }
      if (!currentExecutionScope()?.beforeSend) return response('No additional project facts.')
      mainCalls++
      assert.equal(body.max_tokens, 256_000)
      assert.ok(estimateBudgetInput(body.messages).inputTokens < before / 2)
      return response('Continue on the original model.')
    })
    await agent.run('Continue inspecting; do not change providers.', callbacks)
    await agent.drainPersistWrites()
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(mainCalls, 1)
    assert.ok(summaryCalls > 1)
    assert.deepEqual(persist.loadOai(), session.getMessages())
    assert.equal(session.getMessages().filter(message => message.role === 'user' && message.origin === 'human').length, 101)
  })
}

for (const message of ['context_length_exceeded', 'Input token exceed the limit (request id: fixture)']) {
  test(`server rejection overrides a ready local estimate and permits one same-model replay: ${message}`, async context => {
    const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://api.deepseek.com/v1')
    session.replaceMessages(history())
    await persist.compactOaiAsync(session.getMessages(), true)
    const bodies: OaiChatRequest[] = []
    let mainCalls = 0, summaryCalls = 0
    context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as OaiChatRequest
      if (body.response_format) { summaryCalls++; return response(summary) }
      if (!currentExecutionScope()?.beforeSend) return response('No additional project facts.')
      bodies.push(body)
      mainCalls++
      if (mainCalls === 1) {
        assert.equal(agent.getContextBudget()?.state, 'ready')
        return new Response(JSON.stringify({ error: { message, code: 'quota_limit_reached' } }), { status: 400 })
      }
      return response('Continued on the original DeepSeek model.')
    })
    await agent.run('Continue inspecting; do not change providers.', callbacks)
    await agent.drainPersistWrites()
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(mainCalls, 2)
    assert.ok(summaryCalls > 0)
    const mainBodies = bodies.filter(body => !body.response_format)
    assert.ok(estimateBudgetInput(mainBodies[1]!.messages).inputTokens < estimateBudgetInput(mainBodies[0]!.messages).inputTokens * 0.75)
    assert.ok(JSON.stringify(mainBodies[1]!.messages).includes('Continue inspecting; do not change providers.'))
    assert.ok(bodies.every(body => body.model === 'deepseek-v4-pro'))
    assert.deepEqual(persist.loadOai(), session.getMessages())
    await agent.run('Another follow-up on the same model.', callbacks)
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(mainCalls, 3)
  })
}

test('manual compact uses current occupancy after a request snapshot and preserves every human instruction', async context => {
  const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://relay.fixture.test/v1')
  session.replaceMessages(history())
  await persist.compactOaiAsync(session.getMessages(), true)
  let summaryCalls = 0
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as OaiChatRequest
    if (body.response_format) summaryCalls++
    return response(body.response_format ? summary : 'Ready.')
  })
  await agent.run('Inspect the current project.', callbacks)
  const before = estimateBudgetInput(session.getMessages()).inputTokens
  const users = structuredClone(session.getMessages().filter(message => message.role === 'user' && message.origin === 'human'))
  assert.equal(await agent.compactContext(), true)
  assert.ok(summaryCalls > 0)
  assert.ok(agent.getContextBudget()!.inputTokens < before * 0.75)
  assert.deepEqual(session.getMessages().filter(message => message.role === 'user' && message.origin === 'human'), users)
  await agent.run('Continue without changing the model.', callbacks)
  assert.deepEqual(errors.map(error => error.message), [])
})

test('a single large tool group is archived and summarized before automatic continuation', async context => {
  const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://relay.fixture.test/v1', 128_000)
  const messages: OaiMessage[] = [
    { role: 'user', origin: 'human', content: '查看项目，不要改动。' },
    { role: 'assistant', content: '', reasoning_content: 'Read only.', tool_calls: [{ id: 'read-project', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"project.txt"}' } }] },
    { role: 'tool', tool_call_id: 'read-project', content: '项目数据。'.repeat(20_000) },
  ]
  session.replaceMessages(messages)
  await persist.compactOaiAsync(session.getMessages(), true)
  assert.deepEqual(persist.loadOai(), messages)
  let mainCalls = 0, summaryCalls = 0
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as OaiChatRequest
    if (body.response_format) { summaryCalls++; return response(summary) }
    if (!currentExecutionScope()?.beforeSend) return response('No additional project facts.')
    mainCalls++
    assert.equal(body.max_tokens, 64_000)
    return response('Project inspection continued.')
  })
  await agent.run('Continue this inspection.', callbacks)
  await agent.drainPersistWrites()
  assert.deepEqual(errors.map(error => error.message), [])
  assert.equal(mainCalls, 1)
  assert.ok(summaryCalls > 1)
  assert.ok(session.getMessages().some(message => message.content === messages[0]!.content))
  assert.ok(JSON.stringify(session.getMessages()).includes('[artifact:'))
  assert.deepEqual(persist.loadOai(), session.getMessages())
})

test('repeated server rejection has a finite replay budget and does not poison the next run', async context => {
  const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://api.deepseek.com/v1')
  session.replaceMessages(history())
  await persist.compactOaiAsync(session.getMessages(), true)
  let rejecting = true, mainCalls = 0
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as OaiChatRequest
    if (body.response_format) return response(summary)
    if (!currentExecutionScope()?.beforeSend) return response('No additional project facts.')
    mainCalls++
    return rejecting ? new Response(JSON.stringify({ error: { message: 'context_length_exceeded' } }), { status: 400 }) : response('Recovered.')
  })
  await agent.run('Continue the project.', callbacks)
  assert.equal(mainCalls, 2)
  assert.equal(errors.length, 1)
  rejecting = false
  await agent.run('Try again on DeepSeek.', callbacks)
  assert.equal(mainCalls, 3)
  assert.equal(errors.length, 1)
})

test('an incomplete summary cannot latch hard-budget recovery across a new human retry', async context => {
  const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://api.deepseek.com/v1')
  session.replaceMessages(history(200))
  await persist.compactOaiAsync(session.getMessages(), true)
  let truncated = true, summaryCalls = 0, mainCalls = 0
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as OaiChatRequest
    if (body.response_format) {
      summaryCalls++
      if (truncated) return response('{"version":1', 'length')
      return response(summary)
    }
    if (!currentExecutionScope()?.beforeSend) return response('No additional project facts.')
    mainCalls++
    return response('Recovered without switching models.')
  })
  await agent.run('Continue the project.', callbacks)
  assert.equal(errors.length, 1)
  assert.equal(mainCalls, 0)
  assert.equal(summaryCalls, 1)
  truncated = false
  await agent.run('Retry on the same DeepSeek model.', callbacks)
  assert.equal(errors.length, 1)
  assert.equal(mainCalls, 1)
  assert.ok(summaryCalls > 1)
})

test('long reasoning and human input remain identical on disk before same-model compaction and continuation', async context => {
  const { agent, session, persist, errors, callbacks } = await fixture(context, 'https://api.deepseek.com/v1')
  session.replaceMessages(history())
  const human = 'Preserve these original constraints. '.repeat(8_000)
  const reasoning = 'Preserved reasoning. '.repeat(12_000)
  session.addUserMessage(human)
  session.addAssistantBlocks([{ type: 'thinking', thinking: reasoning }, { type: 'text', text: 'Prior inspection completed.' }])
  await agent.drainPersistWrites()
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as OaiChatRequest
    return response(body.response_format ? summary : 'Project inspection is ready.')
  })
  await agent.run('Continue on DeepSeek.', callbacks)
  assert.deepEqual(errors.map(error => error.message), [])
  await agent.drainPersistWrites()
  const legacy = session.getMessages().map(message => JSON.parse(serializeOaiSessionMessage(message, MAX_SESSION_MESSAGE_JSON_CHARS)) as OaiMessage)
  await persist.compactOaiAsync(legacy, true)
  assert.notDeepEqual(persist.loadOai(), session.getMessages())
  assert.equal(await agent.compactContext(), true)
  await agent.drainPersistWrites()
  assert.deepEqual(persist.loadOai(), session.getMessages())
  assert.ok(persist.loadOai().some(message => message.role === 'user' && message.content === human))
  assert.ok(persist.loadOai().some(message => message.role === 'assistant' && message.reasoning_content === reasoning))
  await agent.run('Another follow-up without switching models.', callbacks)
  assert.deepEqual(errors.map(error => error.message), [])
})

for (const kind of ['text', 'thinking', 'tool block'] as const) {
  test(`a rejection after partial ${kind} never replays or rewrites history`, async context => {
    const { agent, session, persist, callbacks } = await fixture(context, 'https://api.deepseek.com/v1')
    session.replaceMessages(history())
    await persist.compactOaiAsync(session.getMessages(), true)
    const original = structuredClone(session.getMessages())
    let calls = 0, summaries = 0
    context.mock.method(agent.config.client, 'stream', async (_request: OaiChatRequest, streamed: StreamCallbacks) => {
      calls++
      if (kind === 'text') streamed.onTextDelta('Partial response.')
      else if (kind === 'thinking') streamed.onThinkingDelta('Partial reasoning.')
      else streamed.onContentBlock({ type: 'tool_use', id: 'unexecuted', name: 'read_file', input: { file_path: 'project.txt' } })
      streamed.onError(Object.assign(new Error('context_length_exceeded'), { status: 400 }))
    })
    agent.config.budgetSummaryClient = () => ({ stream: async () => { summaries++ } })
    await agent.run('Continue safely.', callbacks)
    assert.equal(calls, 1)
    assert.equal(summaries, 0)
    assert.deepEqual(session.getMessages().slice(0, original.length), original)
    assert.equal(session.getMessages().some(message => message.role === 'tool'), false)
  })
}
