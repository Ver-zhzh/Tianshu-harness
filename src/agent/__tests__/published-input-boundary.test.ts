import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { providerSchema } from '../../config/schema.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { parseFrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import { proveRewindHistory } from '../../api/continuation-prefix.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { AgentLoop } from '../loop.js'
import { SessionPersist } from '../session-persist.js'
import { recordInterruption } from '../interrupt-marker.js'
import { recordHumanInput, applyHumanInputBoundary, rollbackActiveUserInput, getCompactionTaskContract, getCompactionGoalAnchor } from '../human-input-boundary.js'

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'published-input-boundary-'))
  const oldHome = process.env.RIVET_HOME
  const oldSessions = process.env.RIVET_SESSION_DIR
  process.env.RIVET_HOME = join(root, 'home')
  process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  mkdirSync(process.env.RIVET_HOME, { recursive: true })
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  const agents: AgentLoop[] = []
  context.after(async () => {
    for (const agent of agents) {
      agent.stopFsWatcher(); agent.stopConfigWatcher()
      await agent.drainPersistWrites()
      await agent.telemetryWriter.flush()
      await agent.frameRecorder.flush()
    }
    if (oldHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = oldHome
    if (oldSessions === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = oldSessions
    rmSync(root, { recursive: true, force: true })
  })
  const bodies: Array<{ messages: OaiMessage[] }> = []
  context.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), 'https://published.fixture.test/v1/chat/completions')
    bodies.push(JSON.parse(String(init.body)))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const provider = providerSchema.parse({ name: 'third-party', protocol: 'openai', baseUrl: 'https://published.fixture.test/v1',
    maxTokens: 4096, maxRetries: 0, models: [{ id: 'fixture-model', contextWindow: 1_000_000, maxTokens: 4096 }] })
  const engineConfig = { model: 'fixture-model', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' } }
  function create(session = new SessionContext(), engine = new PromptEngine(engineConfig), persist?: SessionPersist) {
    if (persist) {
      engine.setOnFrozenSnapshotChanged(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
      engine.setOnFrozenSnapshotCommit(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
    }
    const client = createProviderClient(provider, resolveCapabilities(provider.name), { apiKey: 'fixture', model: 'fixture-model', maxTokens: 4096 })
    const agent = new AgentLoop({ client, promptEngine: engine, providerName: provider.name, toolRegistry: new ToolRegistry(),
      headless: true, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, model: 'fixture-model' }, fsWatcherEnabled: false,
      ...(persist ? { sessionId: 'published-source-fixture', sessionPersist: persist } : {}),
    }, session, root)
    const pending = engine.getRewindAuthorization()
    if (pending) client.restoreRewindAuthorization!(pending)
    else if (engine.getExecutionSnapshot()) client.restoreExecutionSnapshot!(engine.getExecutionSnapshot()!)
    agents.push(agent)
    return { session, engine, client, agent }
  }
  return { ...create(), create, engineConfig, bodies }
}

const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error: Error) { throw error } }

for (const repair of ['missing result', 'late result', 'empty calls'] as const) {
  for (const restart of [false, true]) {
    test(`preflight ${repair} keeps the published source usable ${restart ? 'after restart' : 'on repeated continuation'}`, async context => {
      const setup = fixture(context)
      let active = setup
      setup.session.addUserMessage('inspect main.js')
      await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
      const generation = setup.client.getMainPrefixProof!()!.cacheGenerationId
      setup.session.replaceMessages([...setup.session.getMessages(), {
        role: 'assistant', content: repair === 'empty calls' ? null : 'reading',
        tool_calls: repair === 'empty calls' ? [] : [{ id: 'read-main', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"main.js"}' } }],
      }])
      setup.session.addUserMessage('continue the previous task')
      if (repair === 'late result') {
        setup.session.replaceMessages([...setup.session.getMessages(), {
          role: 'tool', tool_call_id: 'read-main', content: 'original file content',
        }])
      }
      let repairs = 0
      const request = setup.engine.buildOaiRequest(setup.session.getMessages(), undefined, undefined, {
        onOrphanRepair(messages) { repairs++; setup.session.replaceMessages(messages) },
      })
      await setup.client.stream(request, callbacks)
      assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, proveRewindHistory(setup.session.getMessages()),
        'the first repaired request must publish the repaired source without relying on legacy recovery next turn')
      if (restart) {
        const frozen = parseFrozenSnapshotData(JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot())))!
        const session = new SessionContext()
        session.replaceMessages(JSON.parse(JSON.stringify(setup.session.getMessages())))
        active = { ...setup, ...setup.create(session, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: frozen })) }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        active.session.addUserMessage('continue the previous task')
        await assert.doesNotReject(active.client.stream(active.engine.buildOaiRequest(active.session.getMessages(), undefined, undefined, {
          onOrphanRepair(messages) { repairs++; active.session.replaceMessages(messages) },
        }), callbacks))
      }
      assert.equal(repairs, 1, 'every canonical repair must be written back exactly once, including repairs without synthetic results')
      assert.deepEqual(active.engine.exportFrozenSnapshot().publishedHistory, proveRewindHistory(active.session.getMessages()))
      assert.equal(active.client.getMainPrefixProof!()!.cacheGenerationId, generation, 'recovery must not silently cold-start')
      assert.equal(setup.bodies.length, 4)
      if (repair === 'late result') {
        const results = setup.bodies[1]!.messages.filter(message => message.role === 'tool')
        assert.deepEqual(results.map(message => message.content), ['original file content'])
      }
    })
  }
}

test('a request-only preflight repair does not seal a source writeback that never happened', async context => {
  const setup = fixture(context)
  setup.session.replaceMessages([
    { role: 'user', content: 'inspect main.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'read-main', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"main.js"}' } }] },
  ])
  for (let attempt = 0; attempt < 3; attempt++) {
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, proveRewindHistory(setup.session.getMessages()))
    assert.equal(setup.session.getMessages().filter(message => message.role === 'tool').length, 0)
  }
  assert.equal(setup.bodies.length, 3)
})

for (const invalid of ['changed source', 'published repair'] as const) {
  test(`preflight cannot bless ${invalid} by writing repaired messages back`, async context => {
    const setup = fixture(context)
    setup.session.replaceMessages([
      { role: 'user', content: 'inspect main.js' },
      ...(invalid === 'published repair' ? [{ role: 'assistant' as const, content: null,
        tool_calls: [{ id: 'read-main', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'user' as const, content: 'already published continuation' }] : []),
    ])
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    const baseline = setup.engine.exportFrozenSnapshot()
    if (invalid === 'changed source') {
      setup.session.replaceMessages([
        { role: 'user', content: 'rewritten published task' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'read-main', type: 'function',
          function: { name: 'read_file', arguments: '{}' } }] },
      ])
    }
    let repairs = 0
    const history = structuredClone(setup.session.getMessages())
    assert.throws(() => setup.engine.buildOaiRequest(setup.session.getMessages(), undefined, undefined, {
      onOrphanRepair(messages) { repairs++; setup.session.replaceMessages(messages) },
    }), /prefix diverged at source/)
    assert.equal(repairs, 0)
    assert.deepEqual(setup.session.getMessages(), history)
    assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, baseline.publishedHistory)
    assert.deepEqual(setup.client.getMainPrefixProof!(), baseline.executionSnapshot)
    assert.equal(setup.bodies.length, 1)
  })
}

test('preparing repaired history does not publish it before HTTP or through a side path', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published task')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  const baseline = structuredClone(setup.engine.exportFrozenSnapshot().publishedHistory)
  setup.session.replaceMessages([...setup.session.getMessages(), {
    role: 'assistant', content: null, tool_calls: [{ id: 'read-main', type: 'function',
      function: { name: 'read_file', arguments: '{}' } }],
  }])
  let repairs = 0
  const options = { onOrphanRepair(messages: OaiMessage[]) { repairs++; setup.session.replaceMessages(messages) } }
  const request = setup.engine.buildOaiRequest(setup.session.getMessages(), undefined, undefined, options)
  assert.equal(repairs, 1)
  assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, baseline)
  await setup.client.stream(setup.engine.buildOaiRequest([
    { role: 'assistant', content: null, tool_calls: [] }, { role: 'user', content: 'unrelated summary' },
  ], undefined, undefined, { ...options, sidePath: true }), callbacks)
  assert.equal(repairs, 1)
  assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, baseline)
  await setup.client.stream(request, callbacks)
  assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, proveRewindHistory(setup.session.getMessages()))
  assert.equal(setup.bodies.length, 3)
})

test('the actual agent repair persists a matching source seal and continues from disk without restarting its generation', async context => {
  const setup = fixture(context)
  const cwd = setup.engineConfig.volatileCtx.cwd
  const persist = new SessionPersist('published-source-fixture', cwd)
  const active = setup.create(new SessionContext(), new PromptEngine(setup.engineConfig), persist)
  const errors: Error[] = []
  const runCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {},
    onError(error: Error) { errors.push(error) }, onApprovalRequired: async () => assert.fail('no live tools in this fixture') }
  await active.agent.run('inspect main.js', runCallbacks)
  assert.deepEqual(errors, [])
  const generation = active.client.getMainPrefixProof!()!.cacheGenerationId
  active.session.addAssistantBlocks([{ type: 'tool_use', id: 'read-main', name: 'read_file', input: { path: 'main.js' } }])
  await active.agent.run('continue the previous task', runCallbacks)
  assert.deepEqual(errors, [])
  await active.agent.drainPersistWrites()
  const disk = new SessionPersist('published-source-fixture', cwd)
  const snapshot = disk.readFrozenSnapshot()!
  const history = disk.loadOai()
  assert.ok(snapshot.publishedHistory)
  assert.deepEqual(snapshot.publishedHistory, proveRewindHistory(history.slice(0, snapshot.publishedHistory.length)))
  const restoredSession = new SessionContext()
  restoredSession.replaceMessages(history)
  const restored = setup.create(restoredSession, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: snapshot }), disk)
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = setup.bodies.length
    await restored.agent.run('continue the previous task', runCallbacks)
    assert.ok(setup.bodies.length > sent, 'each continuation must actually reach HTTP')
  }
  assert.deepEqual(errors, [], 'the production preflight callback must not poison later continuation')
  assert.equal(restored.client.getMainPrefixProof!()!.cacheGenerationId, generation)
})

for (const changed of ['none', 'source', 'provenance', 'wire', 'empty wire', 'short wire', 'short wire changed request', 'extra wire', 'wire role', 'native proof', 'request wire', 'synthetic result', 'provider', 'model', 'credential', 'endpoint', 'options', 'tools', 'generation'] as const) {
  test(`legacy preflight seal recovery requires exact old source and wire evidence (${changed})`, async context => {
    const setup = fixture(context)
    setup.session.replaceMessages([
      { role: 'user', content: 'inspect main.js' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'read-main', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"main.js"}' } }] },
      { role: 'user', content: 'continue the previous task' },
    ])
    const legacySource = proveRewindHistory(setup.session.getMessages())
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages(), undefined, undefined, {
      onOrphanRepair(messages) { setup.session.replaceMessages(messages) },
    }), callbacks)
    const frozen = JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot()))
    frozen.publishedHistory = legacySource
    if (changed === 'wire') frozen.executionSnapshot.messages[1].hash = '0'.repeat(64)
    if (changed === 'empty wire') frozen.executionSnapshot.messages = []
    if (changed === 'short wire' || changed === 'short wire changed request') frozen.executionSnapshot.messages = frozen.executionSnapshot.messages.slice(0, 1)
    if (changed === 'extra wire') frozen.executionSnapshot.messages.push({ ...frozen.executionSnapshot.messages.at(-1) })
    if (changed === 'wire role') frozen.executionSnapshot.messages[1].role = 'assistant'
    if (changed === 'native proof') frozen.executionSnapshot.canonicalSource = frozen.executionSnapshot.messages.map((message: { hash: string }) => message.hash)
    if (changed === 'provider') frozen.executionSnapshot.provider = 'another-provider'
    if (changed === 'model') frozen.executionSnapshot.model = 'different-model'
    if (changed === 'credential') frozen.executionSnapshot.credentialScope = 'different-principal'
    if (changed === 'endpoint') frozen.executionSnapshot.endpointHash = '0'.repeat(64)
    if (changed === 'tools') frozen.executionSnapshot.toolsHash = '0'.repeat(64)
    const session = new SessionContext()
    session.replaceMessages(structuredClone(setup.session.getMessages()))
    if (changed === 'source') session.getMessages()[0]!.content = 'rewritten task'
    if (changed === 'provenance') {
      const first = session.getMessages()[0]!
      if (first.role === 'user') first.origin = 'hook'
    }
    if (changed === 'synthetic result') session.getMessages()[2]!.content = 'invented tool success'
    const restored = setup.create(session, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: frozen }))
    session.addUserMessage('continue the previous task')
    let request: ReturnType<PromptEngine['buildOaiRequest']>
    try { request = restored.engine.buildOaiRequest(session.getMessages()) }
    catch (error) {
      assert.ok(['source', 'provenance', 'synthetic result'].includes(changed), 'only invalid source evidence may reject earlier while building')
      assert.match(String(error), /prefix diverged at source/)
      assert.equal(setup.bodies.length, 1)
      assert.deepEqual(restored.engine.exportFrozenSnapshot().publishedHistory, legacySource)
      assert.deepEqual(restored.client.getMainPrefixProof!(), frozen.executionSnapshot)
      return
    }
    if (changed === 'request wire') request.messages[0]!.content = 'unverified system rewrite'
    if (changed === 'options') request.max_tokens = 2_048
    if (changed === 'short wire changed request') request.messages[1]!.content = 'unverified historical task rewrite'
    if (changed === 'generation') restored.client.authorizeCacheGeneration!('explicit_user_effort')
    const previousProof = structuredClone(restored.client.getMainPrefixProof!())
    if (changed !== 'none') {
      await assert.rejects(restored.client.stream(request, callbacks), /prefix diverged at source/)
      assert.equal(setup.bodies.length, 1)
      assert.deepEqual(restored.engine.exportFrozenSnapshot().publishedHistory, legacySource)
      assert.deepEqual(restored.client.getMainPrefixProof!(), previousProof)
      return
    }
    await assert.doesNotReject(restored.client.stream(request, callbacks))
    assert.deepEqual(restored.engine.exportFrozenSnapshot().publishedHistory, proveRewindHistory(session.getMessages()))
    assert.equal(restored.client.getMainPrefixProof!()!.cacheGenerationId, frozen.executionSnapshot.cacheGenerationId)
    session.addUserMessage('continue once more')
    await restored.client.stream(restored.engine.buildOaiRequest(session.getMessages()), callbacks)
    assert.equal(setup.bodies.length, 3)
  })
}

function cancel(session: SessionContext) {
  recordInterruption({
    removeLastMessage: () => { session.removeLastMessage() },
    addAssistantBlocks: blocks => session.addAssistantBlocks(blocks),
    appendSystemReminder: (content, cls) => session.appendSystemReminder(content, cls),
  }, { partialText: '', assistantResponded: false, userMessageConsumed: false, markerEnabled: false })
}

for (const pending of ['cancelled before HTTP', 'published user']) {
  test(`cancelling unsent input ${JSON.stringify(pending)} cannot resend it after an earlier published request`, async context => {
    const setup = fixture(context)
    setup.session.addUserMessage('published user')
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    setup.session.addUserMessage(pending)
    cancel(setup.session)
    assert.equal(setup.session.getMessages().length, 1, 'only the already published user must remain')
    setup.session.addUserMessage('replacement instruction')
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    assert.equal(setup.bodies.length, 2)
    assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
    assert.equal(setup.bodies[1]!.messages.filter(message => message.role === 'user').length, 2,
      'the cancelled occurrence must not reach HTTP, even when its text equals a published occurrence')
  })
}

test('building an unsent request does not publish its user boundary', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  setup.session.addUserMessage('prepared but not sent')
  setup.engine.buildOaiRequest(setup.session.getMessages())
  cancel(setup.session)
  assert.equal(setup.session.getMessages().length, 1)
  assert.equal(setup.bodies.length, 1)
  assert.equal(setup.session.removeLastMessage(), undefined, 'the remaining published user must still be protected')
})

test('reminders may merge into an unpublished tail but never into the published user', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  setup.session.appendSystemReminder('first reminder', 'functional')
  assert.equal(setup.session.appendSystemReminderAndReport('second reminder', 'functional'), true)
  assert.equal(setup.session.getMessages().length, 2)
  assert.equal(setup.session.getMessages()[0]!.content, 'published user')
  assert.match(String(setup.session.getMessages()[1]!.content), /first reminder[\s\S]*second reminder/)
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
})

test('a serialized source publication boundary still distinguishes unsent input after restore', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  setup.session.addUserMessage('prepared and cancelled before snapshot export')
  setup.engine.buildOaiRequest(setup.session.getMessages())
  cancel(setup.session)
  const frozen = JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot()))
  const session = new SessionContext()
  session.replaceMessages(structuredClone(setup.session.getMessages()))
  const restored = setup.create(session, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: frozen }))
  restored.client.restoreExecutionSnapshot!(frozen.executionSnapshot)
  assert.equal(session.removeLastMessage(), undefined, 'restoring the source seal must protect the old user')
  session.addUserMessage('cancelled after restore')
  cancel(session)
  assert.equal(session.getMessages().length, 1, 'restoring a proof must not seal a future unsent user')
  session.addUserMessage('new instruction after restore')
  await restored.client.stream(restored.engine.buildOaiRequest(session.getMessages()), callbacks)
  assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
})

test('publication captures the built source rather than later additions to its mutable input array', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  const request = setup.engine.buildOaiRequest(setup.session.getMessages())
  setup.session.addUserMessage('arrived after request assembly')
  await setup.client.stream(request, callbacks)
  cancel(setup.session)
  assert.equal(setup.session.getMessages().length, 1)
  assert.ok(!JSON.stringify(setup.bodies[0]).includes('arrived after request assembly'))
  assert.equal(setup.engine.exportFrozenSnapshot().publishedHistory!.length, 1)
  assert.equal(setup.engine.assertPublishedHistory(setup.session.getMessages()), true,
    'a later append to the source array cannot be retroactively sealed by an earlier request')
  assert.equal(setup.session.removeLastMessage(), undefined)
})

test('an unrelated side-path request cannot advance the source publication boundary', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  const proof = structuredClone(setup.client.getMainPrefixProof!()!)
  await setup.client.stream(setup.engine.buildOaiRequest([
    { role: 'user', content: 'summary one' }, { role: 'user', content: 'summary two' }, { role: 'user', content: 'summary three' },
  ], undefined, undefined, { sidePath: true }), callbacks)
  setup.session.addUserMessage('cancelled after side path')
  cancel(setup.session)
  assert.equal(setup.session.getMessages().length, 1)
  assert.deepEqual(setup.client.getMainPrefixProof!(), proof)
})

test('invalid persisted source counters are rejected rather than protecting arbitrary future inputs', context => {
  const setup = fixture(context)
  const frozen = setup.engine.exportFrozenSnapshot()
  for (const publishedUserCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.equal(parseFrozenSnapshotData({ ...frozen, publishedUserCount }), undefined)
  }
})

test('assistant and tool messages do not advance the source user publication boundary', async context => {
  const setup = fixture(context)
  setup.session.replaceMessages([
    { role: 'user', content: 'first source user' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'fixture-tool', arguments: '{}' } }] },
    { role: 'tool', content: 'fixture tool response', tool_call_id: 'fixture-call' },
    { role: 'user', content: 'second source user' },
  ])
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  setup.session.addUserMessage('cancelled mixed-history input')
  cancel(setup.session)
  assert.equal(setup.session.getMessages().length, 4)
  assert.equal(setup.session.removeLastMessage(), undefined, 'the second already published source user must remain protected')
})

test('a legacy snapshot gains an exact source seal on its next request without a cold generation', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  const frozen = JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot()))
  delete frozen.publishedUserCount
  delete frozen.publishedHistory
  const session = new SessionContext()
  session.replaceMessages(structuredClone(setup.session.getMessages()))
  const restored = setup.create(session, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: frozen }))
  restored.client.restoreExecutionSnapshot!(frozen.executionSnapshot)
  session.addUserMessage('cancelled legacy input before HTTP')
  cancel(session)
  assert.equal(session.getMessages().length, 1)
  session.addUserMessage('new legacy continuation')
  await restored.client.stream(restored.engine.buildOaiRequest(session.getMessages()), callbacks)
  assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
  assert.equal(restored.client.getMainPrefixProof!()!.cacheGenerationId, frozen.executionSnapshot.cacheGenerationId)
  assert.equal(session.removeLastMessage(), undefined, 'the newly published legacy continuation must now be sealed')
})

test('the actual published source seal rejects changed history while permitting later input', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published source')
  assert.equal(setup.engine.assertPublishedHistory(setup.session.getMessages()), false)
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  setup.session.addUserMessage('later unpublished input')
  assert.equal(setup.engine.assertPublishedHistory(setup.session.getMessages()), true)
  const snapshot = parseFrozenSnapshotData(JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot())))!
  assert.equal(snapshot.publishedHistory!.length, 1)
  const restored = new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: snapshot })
  assert.equal(restored.assertPublishedHistory(setup.session.getMessages()), true)
  const altered = structuredClone(setup.session.getMessages())
  altered[0]!.content = 'changed published source'
  assert.throws(() => restored.assertPublishedHistory(altered), /已发布的源历史发生变化/)
  snapshot.publishedHistory![0]!.hash = '0'.repeat(64)
  assert.equal(restored.assertPublishedHistory(setup.session.getMessages()), true,
    'a caller cannot mutate the live seal through an exported or inherited snapshot')
})

test('a side path cannot bless a historical rewrite for subsequent compaction', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('original main source')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  const original = structuredClone(setup.engine.exportFrozenSnapshot().publishedHistory)
  const changed = structuredClone(setup.session.getMessages())
  changed[0]!.content = 'unknown source rewrite'
  await setup.client.stream(setup.engine.buildOaiRequest(changed, undefined, undefined, { sidePath: true }), callbacks)
  assert.deepEqual(setup.engine.exportFrozenSnapshot().publishedHistory, original)
  assert.throws(() => setup.engine.assertPublishedHistory(changed), /已发布的源历史发生变化/)
})

test('persisted raw source seals reject malformed entries and inconsistent source counts', context => {
  const setup = fixture(context)
  const baseline = setup.engine.exportFrozenSnapshot()
  for (const publishedHistory of [null, {}, [null], [{ hash: 'bad', role: 'user', chars: 1 }],
    [{ hash: '0'.repeat(64), role: 'user', chars: -1 }], [{ hash: '0'.repeat(64), role: 'user', chars: Infinity }]]) {
    assert.equal(parseFrozenSnapshotData({ ...baseline, publishedHistory }), undefined)
  }
  assert.equal(parseFrozenSnapshotData({ ...baseline, publishedUserCount: 0,
    publishedHistory: [{ hash: '0'.repeat(64), role: 'user', chars: 1 }] }), undefined)
})

test('rollback withdraws its prepared occurrence without discarding an identical later input', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('published user')
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  const original = setup.session.getMessages().at(-1)!
  setup.session.addUserMessage('identical pending instruction')
  const active = setup.session.getMessages().at(-1)!
  setup.engine.buildOaiRequest(setup.session.getMessages())
  setup.session.addUserMessage('identical pending instruction')
  const future = setup.session.getMessages().at(-1)!
  assert.equal(setup.session.removeUserInput(original, setup.engine.getPreparedUserInput()), active)
  assert.equal(setup.session.getMessages().at(-1), future)
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  assert.equal(setup.bodies.length, 2)
  assert.equal(setup.bodies[1]!.messages.filter(message => message.role === 'user').length, 2)
})

for (const advisory of [false, true]) {
  test(`a restored published user is immutable before the first new request is prepared (${advisory ? 'advisory' : 'reminder'})`, async context => {
    const setup = fixture(context)
    setup.session.addUserMessage('published before restore')
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    const restoredSession = new SessionContext()
    restoredSession.replaceMessages(structuredClone(setup.session.getMessages()))
    const restoredEngine = new PromptEngine({ ...setup.engineConfig,
      inheritFrozenFrom: parseFrozenSnapshotData(JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot())))! })
    const restored = setup.create(restoredSession, restoredEngine)
    assert.equal(restored.engine.getPreparedUserCount(), 0)
    if (advisory) restored.session.appendSystemReminderAndReport('A new post-restore reminder.', 'functional')
    else restored.session.appendSystemReminder('A new post-restore reminder.', 'functional')
    assert.equal(restored.session.getMessages()[0]!.content, 'published before restore')
    restored.session.addUserMessage('a later continuation')
    await restored.client.stream(restored.engine.buildOaiRequest(restored.session.getMessages()), callbacks)
    assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
  })
}

test('withdrawing a wholly speculative task restores its prior objective, constraints and verification debt', async context => {
  const setup = fixture(context)
  const { agent, session, engine } = setup
  agent.activeInputOrigin = 'human'
  session.setGoalTracking(messages => {
    const human = messages.filter(message => message.role === 'user' && message.origin === 'human').at(-1)
    return !human ? null : String(human.content).includes('BOUNDARY_B') ? 'goal-B' : 'goal-A'
  }, goal => engine.setGoalAnchor(goal))
  recordHumanInput(agent, '任务 A：检查旧问题，不要修改文件')
  agent.requestContext.activeUserMessage = session.getMessages().at(-1)
  applyHumanInputBoundary(agent, 'task', '任务 A：检查旧问题，不要修改文件')
  const obligation = agent.obligations.upsert({ family: 'delivery', claim: '任务 A 必须完成验证', targets: [], risk: 'high' })
  agent.obligations.markContinued(obligation)
  await setup.client.stream(engine.buildOaiRequest(session.getMessages()), callbacks)
  const priorContract = structuredClone(agent.taskContract)
  const priorDebt = structuredClone(agent.obligations.getStore())
  recordHumanInput(agent, 'BOUNDARY_B: please edit src/change.ts')
  agent.requestContext.activeUserMessage = session.getMessages().at(-1)
  applyHumanInputBoundary(agent, 'task', 'BOUNDARY_B: please edit src/change.ts')
  const epoch = agent.workFacts.taskEpoch
  const version = agent.obligations.getVersion()
  assert.equal(getCompactionTaskContract(agent), undefined, 'a new unpublished task must not commit its own or revive a superseded task anchor')
  assert.equal(getCompactionGoalAnchor(agent), 'goal-A')
  session.appendSystemReminder('A before-build advisory.', 'functional')
  engine.buildOaiRequest(session.getMessages())
  session.appendSystemReminder('A later independent advisory.', 'functional')
  rollbackActiveUserInput(agent)
  assert.ok(!JSON.stringify(session.getMessages()).includes('BOUNDARY_B'))
  assert.deepEqual(agent.taskContract, priorContract)
  assert.deepEqual(agent.obligations.getStore(), priorDebt)
  // 267a0001e：delivery 义务属 isIndependentVerification——披露而不排期续轮。
  // rollback 恢复的是债务记录本身（上方 deepEqual 已钉），final 评估不再因此续轮。
  assert.equal(agent.obligations.evaluateFinal().alreadyContinued, false)
  assert.ok(agent.obligations.getVersion() > version)
  assert.equal(agent.workFacts.taskEpoch, epoch, 'rollback must not rewind monotonic task epochs')
  assert.equal(agent.workFacts.explicitNoMutation, true)
  assert.equal(session.getGoalAnchor(), 'goal-A')
  assert.equal(engine.getGoalAnchor(), 'goal-A')
  recordHumanInput(agent, '继续任务 A')
  agent.requestContext.activeUserMessage = session.getMessages().at(-1)
  applyHumanInputBoundary(agent, 'followUp', '继续任务 A')
  assert.deepEqual(getCompactionTaskContract(agent), priorContract, 'an unpublished follow-up retains the already published task identity')
  await setup.client.stream(engine.buildOaiRequest(session.getMessages()), callbacks)
  assert.ok(!JSON.stringify(setup.bodies[1]).includes('BOUNDARY_B'))
})

for (const progress of ['mutation', 'obligation'] as const) {
  test(`input withdrawal cannot erase independently recorded ${progress} facts`, context => {
    const { agent, session } = fixture(context)
    agent.activeInputOrigin = 'human'
    recordHumanInput(agent, 'BOUNDARY_B: please edit src/change.ts')
    agent.requestContext.activeUserMessage = session.getMessages().at(-1)
    applyHumanInputBoundary(agent, 'task', 'BOUNDARY_B: please edit src/change.ts')
    if (progress === 'mutation') agent.workFacts.recordFileProgress({ outcome: 'changed', targets: ['src/change.ts'] })
    else agent.obligations.upsert({ family: 'delivery', claim: '新增的真实验证义务', targets: [], risk: 'high' })
    const contract = structuredClone(agent.taskContract)
    const debt = structuredClone(agent.obligations.getStore())
    rollbackActiveUserInput(agent)
    assert.ok(JSON.stringify(session.getMessages()).includes('BOUNDARY_B'))
    assert.deepEqual(agent.taskContract, contract)
    assert.deepEqual(agent.obligations.getStore(), debt)
  })
}

test('the real convergence stop withdraws only its unsent input and retains a later advisory', async context => {
  const setup = fixture(context)
  const { agent, session, engine } = setup
  const delivered = 'A delivered convergence warning.'
  session.addUserMessage(delivered)
  const request = engine.buildOaiRequest(session.getMessages())
  await setup.client.stream(request, callbacks)
  const generation = setup.client.getMainPrefixProof!()!.cacheGenerationId
  recordHumanInput(agent, 'An unpublished follow-up to cancel at convergence.')
  agent.requestContext.activeUserMessage = session.getMessages().at(-1)
  applyHumanInputBoundary(agent, 'followUp', 'An unpublished follow-up to cancel at convergence.')
  const candidateId = agent.decisionShifts.registerConvergence(10, 'plan', 10, delivered, 2)
  let aborts = 0
  const runCallbacks = { ...callbacks, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
    onAbort() { aborts++ }, onApprovalRequired: async () => assert.fail('no tools are configured') }
  assert.equal(agent.decisionShifts.confirm([{ candidateId }], request, runCallbacks), true)
  engine.buildOaiRequest(session.getMessages())
  session.appendSystemReminder('A later convergence advisory.', 'functional')
  const advisory = session.getMessages().at(-1)!
  agent.consecutiveNoToolTurns = 5
  agent.modelObservationTurn = 100
  assert.deepEqual(await agent.runConvergenceCheck(100, 'plan', false, false, runCallbacks), { action: 'abort' })
  assert.equal(aborts, 1)
  assert.ok(session.getMessages().includes(advisory))
  assert.ok(!JSON.stringify(session.getMessages()).includes('An unpublished follow-up to cancel at convergence.'))
  await setup.client.stream(engine.buildOaiRequest(session.getMessages()), callbacks)
  assert.equal(setup.bodies.length, 2)
  assert.ok(JSON.stringify(setup.bodies[1]).includes('A later convergence advisory.'))
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, generation)
})

test('an earlier unconsumed preparation cannot withdraw a different current input', async context => {
  const setup = fixture(context)
  setup.session.addUserMessage('earlier retained input')
  setup.engine.buildOaiRequest(setup.session.getMessages())
  const earlier = setup.session.getMessages().at(-1)!
  setup.session.addUserMessage('current unpublished input')
  const current = setup.session.getMessages().at(-1)!
  assert.equal(setup.session.removeUserInput(current, setup.engine.getPreparedUserInput()), current)
  assert.equal(setup.session.getMessages().at(-1), earlier)
  await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
  assert.ok(!JSON.stringify(setup.bodies[0]).includes('current unpublished input'))
})

for (const advisory of [false, true]) {
  test(`legacy publication evidence protects pre-request reminders without sealing a new cancelled input (${advisory})`, async context => {
    const setup = fixture(context)
    setup.session.addUserMessage('legacy published source')
    await setup.client.stream(setup.engine.buildOaiRequest(setup.session.getMessages()), callbacks)
    const generation = setup.client.getMainPrefixProof!()!.cacheGenerationId
    const snapshot = JSON.parse(JSON.stringify(setup.engine.exportFrozenSnapshot()))
    delete snapshot.publishedUserCount
    delete snapshot.publishedHistory
    const restoredSession = new SessionContext()
    restoredSession.replaceMessages(structuredClone(setup.session.getMessages()))
    const restored = setup.create(restoredSession, new PromptEngine({ ...setup.engineConfig, inheritFrozenFrom: snapshot }))
    if (advisory) restored.session.appendSystemReminderAndReport('A legacy startup reminder.', 'functional')
    else restored.session.appendSystemReminder('A legacy startup reminder.', 'functional')
    assert.equal(restored.session.getMessages()[0]!.content, 'legacy published source')
    restored.session.addUserMessage('legacy unsent input')
    const cancelled = restored.session.getMessages().at(-1)!
    restored.engine.buildOaiRequest(restored.session.getMessages())
    assert.equal(restored.session.removeUserInput(cancelled, restored.engine.getPreparedUserInput()), cancelled)
    restored.session.addUserMessage('legacy replacement input')
    await restored.client.stream(restored.engine.buildOaiRequest(restored.session.getMessages()), callbacks)
    assert.equal(setup.bodies.length, 2)
    assert.deepEqual(setup.bodies[1]!.messages.slice(0, setup.bodies[0]!.messages.length), setup.bodies[0]!.messages)
    assert.ok(!JSON.stringify(setup.bodies[1]).includes('legacy unsent input'))
    assert.equal(restored.client.getMainPrefixProof!()!.cacheGenerationId, generation)
  })
}
