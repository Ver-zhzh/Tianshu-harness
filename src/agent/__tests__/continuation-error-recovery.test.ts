import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { providerSchema } from '../../config/schema.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { AgentLoop, type AgentCallbacks } from '../loop.js'

for (const historyLength of [0, 453]) {
  for (const failureKind of ['network', 'late advisory', 'before transport advisory', 'network after late advisory', 'user stop', 'user stop without marker', 'watchdog'] as const) {
    test(`${failureKind} retains the sent user boundary and continues without restarting with ${historyLength} historical messages`, async context => {
      const providerFailure = failureKind === 'network' || failureKind === 'network after late advisory'
      const advisoryOnly = failureKind === 'late advisory' || failureKind === 'before transport advisory'
      const root = mkdtempSync(join(tmpdir(), 'continuation-error-recovery-'))
      const oldHome = process.env.RIVET_HOME
      const oldSessions = process.env.RIVET_SESSION_DIR
      process.env.RIVET_HOME = join(root, 'home')
      process.env.RIVET_SESSION_DIR = join(root, 'sessions')
      mkdirSync(process.env.RIVET_HOME, { recursive: true })
      writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
      context.after(() => {
        if (oldHome === undefined) delete process.env.RIVET_HOME
        else process.env.RIVET_HOME = oldHome
        if (oldSessions === undefined) delete process.env.RIVET_SESSION_DIR
        else process.env.RIVET_SESSION_DIR = oldSessions
        rmSync(root, { recursive: true, force: true })
      })
      const bodies: Array<{ messages: OaiMessage[] }> = []
      context.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
        assert.equal(String(url), 'https://continuation.fixture.test/v1/chat/completions')
        bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 2) {
          if (failureKind === 'late advisory' || failureKind === 'network after late advisory') {
            assert.equal(session.appendSystemReminderAndReport('A late fixture advisory.', 'functional'), true)
          }
          if (providerFailure) throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
          if (!advisoryOnly) {
            if (failureKind === 'watchdog') agent.abortStalledTurn()
            else agent.abort()
            throw new DOMException('fixture interrupted', 'AbortError')
          }
        }
        return new Response('data: {"choices":[{"delta":{"content":"The status is available."},"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":6}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
      })
      const provider = providerSchema.parse({
        name: 'third-party', protocol: 'openai' as const, baseUrl: 'https://continuation.fixture.test/v1',
        maxTokens: 4096, maxRetries: 0, unsupported: [],
        models: [{ id: 'fixture-model', contextWindow: 1_000_000, maxTokens: 4096 }],
      })
      const transport = createProviderClient(provider, resolveCapabilities(provider.name), {
        apiKey: 'fixture', model: 'fixture-model', maxTokens: 4096,
      })
      let advisoryInjected = false
      const client = failureKind === 'before transport advisory' ? new Proxy(transport, {
        get(target, property) {
          if (property === 'stream') return (...args: Parameters<typeof transport.stream>) => {
            if (bodies.length === 1 && !advisoryInjected) {
              advisoryInjected = true
              session.appendSystemReminderAndReport('A late fixture advisory.', 'functional')
            }
            return target.stream(...args)
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) : transport
      const engine = new PromptEngine({ model: 'fixture-model', maxTokens: 4096,
        staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' } })
      const session = new SessionContext()
      session.replaceMessages(Array.from({ length: historyLength }, (_, index): OaiMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant', content: `Archived exchange ${index}`,
      })))
      const agent = new AgentLoop({
        client, promptEngine: engine, providerName: provider.name,
        toolRegistry: new ToolRegistry(), headless: true, maxTurns: 2, contextWindow: 1_000_000,
        interruptMarker: failureKind !== 'user stop without marker',
        agentReconnect: { enabled: false, maxAttempts: 0 },
        compact: { enabled: false, model: 'fixture-model' },
      }, session, root)
      context.after(() => { agent.stopFsWatcher(); agent.stopConfigWatcher() })
      const errors: Error[] = []
      let aborts = 0
      const callbacks: AgentCallbacks = {
        onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
        onError: error => { errors.push(error) }, onAbort: () => { aborts++ },
        onApprovalRequired: async () => assert.fail('this fixture has no tools'),
      }
      assert.equal(engine.getRequestBudgetPolicy(), undefined)
      await agent.run('What is the current status?', callbacks)
      assert.equal(errors.length, 0)
      assert.equal(bodies.length, 1)
      const generation = client.getMainPrefixProof!()!.cacheGenerationId
      assert.ok(generation)
      await agent.run('What is the follow-up status?', callbacks)
      assert.equal(bodies.length, 2, 'the failed attempt must have reached the real transport boundary')
      assert.equal(errors.length, providerFailure ? 1 : 0, 'transport errors and user interruption must retain their distinct feedback')
      assert.equal(aborts, providerFailure || advisoryOnly ? 0 : 1)
      const sentUserRetained = session.getMessages().some(message => message.role === 'user'
        && message.content === 'What is the follow-up status?')
      const failedPrefix = bodies[1]!.messages
      errors.length = 0
      await agent.run('Continue with the follow-up status.', callbacks)
      assert.deepEqual(errors.map(error => ({ name: error.name, message: error.message })), [],
        'continuing in the same agent must not loop on a local prefix divergence')
      assert.ok(sentUserRetained, 'a user message already sealed by the sent request must not be removed on error')
      assert.equal(bodies.length, 3)
      assert.deepEqual(bodies[2]!.messages.slice(0, failedPrefix.length), failedPrefix,
        'recovery must extend the actual sent prefix instead of clearing or weakening the guard')
      if (advisoryOnly) assert.ok(bodies[2]!.messages.some(message => message.role === 'user'
        && String(message.content).includes('A late fixture advisory.')), 'an acknowledged advisory must survive error cleanup too')
      assert.ok(session.getMessages().some(message => message.role === 'assistant'
        && message.content === 'The status is available.'))
      await agent.run('And what is the status after that?', callbacks)
      assert.deepEqual(errors.map(error => error.message), [])
      assert.equal(bodies.length, 4, 'the second continuation must use the same live agent too')
      assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, generation,
        'recovery must not discard the execution baseline or force a new cache generation')
    })
  }
}

for (const historyLength of [0, 453]) {
  test(`cancelling a prepared input preserves later advisories without replaying the input with ${historyLength} historical messages`, async context => {
    const root = mkdtempSync(join(tmpdir(), 'continuation-prepared-cancel-'))
    const oldHome = process.env.RIVET_HOME
    const oldSessions = process.env.RIVET_SESSION_DIR
    process.env.RIVET_HOME = join(root, 'home')
    process.env.RIVET_SESSION_DIR = join(root, 'sessions')
    mkdirSync(process.env.RIVET_HOME, { recursive: true })
    writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
    context.after(() => {
      if (oldHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = oldHome
      if (oldSessions === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = oldSessions
      rmSync(root, { recursive: true, force: true })
    })
    const bodies: Array<{ messages: OaiMessage[] }> = []
    context.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), 'https://prepared-cancel.fixture.test/v1/chat/completions')
      bodies.push(JSON.parse(String(init.body)))
      return new Response('data: {"choices":[{"delta":{"content":"The status is available."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    })
    const provider = providerSchema.parse({ name: 'fixture', protocol: 'openai', baseUrl: 'https://prepared-cancel.fixture.test/v1',
      maxTokens: 4096, maxRetries: 0, models: [{ id: 'fixture-model', contextWindow: 1_000_000, maxTokens: 4096 }] })
    const transport = createProviderClient(provider, resolveCapabilities(provider.name), { apiKey: 'fixture', model: 'fixture-model', maxTokens: 4096 })
    const engine = new PromptEngine({ model: 'fixture-model', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' } })
    const session = new SessionContext()
    session.replaceMessages(Array.from({ length: historyLength }, (_, index): OaiMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `Archived exchange ${index}`,
    })))
    let stopped = false
    const client = new Proxy(transport, {
      get(target, property) {
        if (property === 'stream') return (...args: Parameters<typeof transport.stream>) => {
          if (bodies.length === 1 && !stopped) {
            stopped = true
            session.appendSystemReminderAndReport('An advisory after request assembly.', 'functional')
            agent.abort()
            throw new DOMException('fixture stopped before dispatch', 'AbortError')
          }
          return target.stream(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const agent = new AgentLoop({ client, promptEngine: engine, providerName: provider.name, toolRegistry: new ToolRegistry(),
      headless: true, maxTurns: 2, contextWindow: 1_000_000, interruptMarker: false, fsWatcherEnabled: false,
      agentReconnect: { enabled: false, maxAttempts: 0 }, compact: { enabled: false, model: 'fixture-model' },
    }, session, root)
    context.after(() => { agent.stopFsWatcher(); agent.stopConfigWatcher() })
    const cancelled = 'What is the cancelled status?'
    const build = engine.buildOaiRequest.bind(engine)
    let merged = false
    context.mock.method(engine, 'buildOaiRequest', (...args: Parameters<typeof engine.buildOaiRequest>) => {
      if (!merged && agent.requestContext.activeUserMessage?.content === cancelled) {
        merged = true
        if (historyLength === 0) session.appendSystemReminder('An advisory before request assembly.', 'functional')
        else session.appendSystemReminderAndReport('An advisory before request assembly.', 'functional')
      }
      return build(...args)
    })
    const errors: Error[] = []
    let aborts = 0
    const callbacks: AgentCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
      onError: error => { errors.push(error) }, onAbort: () => { aborts++ }, onApprovalRequired: async () => assert.fail('no tools') }
    await agent.run('What is the original status?', callbacks)
    const generation = client.getMainPrefixProof!()!.cacheGenerationId
    await agent.run(cancelled, callbacks)
    assert.equal(merged, true)
    assert.equal(aborts, 1)
    assert.equal(bodies.length, 1, 'the cancelled request must never reach HTTP')
    assert.ok(!session.getMessages().some(message => message.role === 'user' && String(message.content).includes(cancelled)),
      'error cleanup must remove the actual unpublished input, not its later advisory')
    assert.ok(session.getMessages().some(message => message.role === 'user' && String(message.content).includes('An advisory after request assembly.')))
    await agent.run('What is the replacement status?', callbacks)
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1]!.messages.slice(0, bodies[0]!.messages.length), bodies[0]!.messages)
    assert.ok(!JSON.stringify(bodies[1]).includes(cancelled), 'the withdrawn input must not be replayed on the next real request')
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, generation)
  })
}
