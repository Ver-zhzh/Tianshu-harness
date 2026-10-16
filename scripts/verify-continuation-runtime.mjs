import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'dist'))
const output = mkdtempSync(path.join(tmpdir(), 'tianshu-continuation-runtime-'))
process.env.HOME = path.join(output, 'isolated-home')
process.env.CFFIXED_USER_HOME = process.env.HOME
process.env.RIVET_HOME = path.join(output, 'bootstrap-home')
process.env.RIVET_SESSION_DIR = path.join(output, 'bootstrap-sessions')
process.env.RIVET_TOKEN_STORE = 'local-key'
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.RIVET_HOME, { recursive: true })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected network access outside the fixture transport') }
const ts = createRequire(path.join(dist, 'main.js'))('typescript')
const artifacts = []
const pending = [path.join(dist, 'main.js')]
const visited = new Set()
while (pending.length) {
  const filename = pending.pop()
  if (visited.has(filename)) continue
  visited.add(filename)
  assert.ok(filename.startsWith(`${dist}${path.sep}`), 'compiled imports must remain inside the distribution')
  const source = readFileSync(filename, 'utf8')
  artifacts.push({ file: path.relative(dist, filename), exports: source.slice(source.lastIndexOf('\nexport {')),
    hash: createHash('sha256').update(source).digest('hex') })
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.') && specifier.text.endsWith('.js')) {
      pending.push(path.resolve(path.dirname(filename), specifier.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
}
const modules = {}
async function load(name) {
  for (const artifact of artifacts) {
    if (!new RegExp(`\\b${name}\\b`).test(artifact.exports)) continue
    const loaded = await import(pathToFileURL(path.join(dist, artifact.file)).href)
    if (!loaded[name]) continue
    modules[name] = { file: artifact.file, sha256: artifact.hash }
    return loaded[name]
  }
  throw new Error(`Built runtime export unavailable: ${name}`)
}
const [AgentLoop, SessionContext, PromptEngine, ToolRegistry, createProviderClient, resolveCapabilities] = await Promise.all([
  'AgentLoop', 'SessionContext', 'PromptEngine', 'ToolRegistry', 'createProviderClient', 'resolveCapabilities',
].map(load))
const reports = []
function withoutRollingCache(messages) {
  const total = messages.reduce((count, message) => count + message.content.length, 0)
  let position = 0
  let expected = -1
  for (const [index, message] of messages.entries()) {
    position += message.content.length
    if (expected === -1 && message.role === 'assistant' && total - position < 15) expected = index
  }
  const actual = []
  const normalized = messages.map((message, messageIndex) => ({ ...message, content: message.content.map((block, blockIndex) => {
    if (message.role !== 'assistant' || block.cache_control === undefined) return block
    assert.equal(blockIndex, message.content.length - 1)
    assert.deepEqual(block.cache_control, { type: 'ephemeral' })
    actual.push(messageIndex)
    const { cache_control: removed, ...content } = block
    assert.ok(removed)
    return content
  }) }))
  assert.deepEqual(actual, expected === -1 ? [] : [expected], 'the real native rolling-cache policy must remain enabled')
  return normalized
}
const scenarios = ['openai', 'anthropic'].flatMap(protocol =>
  ['network', 'late advisory', 'before transport advisory', 'network after late advisory', 'user stop', 'user stop without marker', 'stop before transport advisory', 'watchdog'].map(failureKind => ({ protocol, failureKind })))
try {
  for (const { protocol, failureKind } of scenarios) {
    const cancelBefore = failureKind === 'stop before transport advisory'
    const advisoryOnly = failureKind === 'late advisory' || failureKind === 'before transport advisory'
    const providerFailure = failureKind === 'network' || failureKind === 'network after late advisory'
    const followUp = 'What is the follow-up status?'
    const root = path.join(output, protocol, failureKind.replaceAll(' ', '-'))
    process.env.RIVET_HOME = path.join(root, 'home')
    process.env.RIVET_SESSION_DIR = path.join(root, 'sessions')
    mkdirSync(process.env.RIVET_HOME, { recursive: true })
    writeFileSync(path.join(process.env.RIVET_HOME, 'config.json'), '{}')
    const session = new SessionContext()
    const bodies = [], errors = []
    session.replaceMessages(Array.from({ length: 453 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `Archived exchange ${index}`,
    })))
    const provider = { name: 'fixture', protocol, baseUrl: protocol === 'anthropic' ? 'https://artifact.fixture.test' : 'https://artifact.fixture.test/v1',
      capabilities: {}, unsupported: [], maxTokens: 4096, maxRetries: 0,
      models: [{ id: 'fixture-model', maxTokens: 4096, contextWindow: 1_000_000 }] }
    const transport = createProviderClient(provider, resolveCapabilities(protocol === 'anthropic' ? 'anthropic' : provider.name), { apiKey: 'fixture', model: 'fixture-model', maxTokens: 4096 })
    let beforeInjected = false
    const client = cancelBefore || failureKind === 'before transport advisory' ? new Proxy(transport, {
      get(target, property) {
        if (property === 'stream') return (...args) => {
          if (bodies.length === 1 && !beforeInjected) {
            beforeInjected = true
            session.appendSystemReminderAndReport('An acknowledged fixture advisory.', 'functional')
            if (cancelBefore) { agent.abort(); throw new DOMException('fixture cancelled before transport', 'AbortError') }
          }
          return target.stream(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) : transport
    const engine = new PromptEngine({ model: 'fixture-model', maxTokens: 4096,
      staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' } })
    const agent = new AgentLoop({ client, promptEngine: engine, providerName: 'fixture', toolRegistry: new ToolRegistry(),
      headless: true, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, model: 'fixture-model' },
      agentReconnect: { enabled: false, maxAttempts: 0 }, interruptMarker: failureKind !== 'user stop without marker' && !cancelBefore, fsWatcherEnabled: false,
    }, session, root)
    let beforeMerged = false
    if (cancelBefore) {
      const build = engine.buildOaiRequest.bind(engine)
      engine.buildOaiRequest = (...args) => {
        if (!beforeMerged && agent.requestContext.activeUserMessage?.content === followUp) {
          beforeMerged = true
          if (protocol === 'openai') session.appendSystemReminder('An advisory before request assembly.', 'functional')
          else session.appendSystemReminderAndReport('An advisory before request assembly.', 'functional')
        }
        return build(...args)
      }
    }
    const fixtureGuard = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `https://artifact.fixture.test/v1/${protocol === 'anthropic' ? 'messages' : 'chat/completions'}`)
      bodies.push(JSON.parse(String(init.body)))
      if (bodies.length === 2 && !cancelBefore) {
        if (failureKind === 'late advisory' || failureKind === 'network after late advisory') session.appendSystemReminderAndReport('An acknowledged fixture advisory.', 'functional')
        if (failureKind === 'network' || failureKind === 'network after late advisory') throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
        else if (!advisoryOnly) {
          if (failureKind === 'watchdog') agent.abortStalledTurn()
          else agent.abort()
          throw new DOMException('fixture interrupted', 'AbortError')
        }
      }
      const events = protocol === 'anthropic' ? [
        { type: 'message_start', message: { id: 'fixture-response', usage: { input_tokens: 500 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The status is available.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
        { type: 'message_stop' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
        : 'data: {"choices":[{"delta":{"content":"The status is available."},"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":6}}\n\ndata: [DONE]\n\n'
      return new Response(events,
        { headers: { 'content-type': 'text/event-stream' } })
    }
    let aborts = 0
    const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
      onError: error => errors.push(error), onAbort() { aborts++ }, onApprovalRequired: async () => assert.fail('no tools are configured') }
    try {
      await agent.run('What is the current status?', callbacks)
      assert.deepEqual(errors, [])
      assert.equal(bodies.length, 1)
      const generation = agent.config.client.getMainPrefixProof().cacheGenerationId
      assert.ok(generation)
      session.addUserMessage('This instruction was cancelled before HTTP.')
      assert.equal(session.removeLastMessage()?.content, 'This instruction was cancelled before HTTP.',
        'the packaged runtime must not seal an input that was never sent')
      await agent.run(followUp, callbacks)
      const secondCount = cancelBefore ? 1 : 2
      const finalCount = secondCount + 2
      assert.equal(bodies.length, secondCount)
      assert.equal(errors.length, providerFailure ? 1 : 0)
      assert.equal(aborts, providerFailure || advisoryOnly ? 0 : 1)
      if (cancelBefore) {
        assert.equal(beforeInjected && beforeMerged, true)
        assert.ok(!session.getMessages().some(message => message.role === 'user' && String(message.content).includes(followUp)))
      }
      errors.length = 0
      const priorBody = bodies[secondCount - 1]
      const prefix = priorBody.messages
      await agent.run('Continue with the follow-up status.', callbacks)
      assert.deepEqual(errors.map(error => ({ name: error.name, message: error.message })), [])
      assert.equal(bodies.length, secondCount + 1)
      const continued = bodies[secondCount]
      if (protocol === 'openai') assert.deepEqual(continued.messages.slice(0, prefix.length), prefix)
      else {
        assert.deepEqual(continued.system, priorBody.system)
        assert.deepEqual(continued.tools, priorBody.tools)
        const before = withoutRollingCache(prefix)
        const after = withoutRollingCache(continued.messages)
        assert.deepEqual(after.slice(0, prefix.length - 1), before.slice(0, -1))
        const tail = after[prefix.length - 1]
        assert.deepEqual({ ...tail, content: tail.content.slice(0, prefix.at(-1).content.length) }, prefix.at(-1))
      }
      if (failureKind.includes('advisory')) assert.ok(JSON.stringify(continued).includes('An acknowledged fixture advisory.'))
      if (cancelBefore) assert.ok(!JSON.stringify(continued).includes(followUp), 'the cancelled assembled input must never be replayed')
      await agent.run('And what is the status after that?', callbacks)
      assert.deepEqual(errors.map(error => error.message), [])
      assert.equal(bodies.length, finalCount)
      assert.ok(bodies.every(body => !JSON.stringify(body).includes('This instruction was cancelled before HTTP.')),
        'a cancelled unsent instruction must never be serialized into a later request')
      assert.equal(agent.config.client.getMainPrefixProof().cacheGenerationId, generation)
      assert.equal(session.getMessages().filter(message => message.role === 'assistant'
        && message.content === 'The status is available.').length, advisoryOnly ? 4 : 3,
        'every successful compiled-runtime turn must retain its assistant response')
      const proof = structuredClone(agent.config.client.getMainPrefixProof())
      session.replaceMessages(session.getMessages().map((message, index) => index === 0
        ? { ...message, content: 'Unauthorized historical replacement' } : message))
      await agent.run('An invalid history must not reach the transport.', callbacks)
      assert.equal(bodies.length, finalCount)
      assert.ok(errors.some(error => error.name === 'ContinuationPrefixError'))
      assert.deepEqual(agent.config.client.getMainPrefixProof(), proof)
      reports.push({ protocol, failureKind, archivedMessages: 453, httpRequests: bodies.length,
        cancelledInputNotSent: true, preparedInputCancelled: cancelBefore, unchangedGeneration: true, unknownHistoryRewriteBlocked: true })
    } finally {
      globalThis.fetch = fixtureGuard
      agent.stopFsWatcher()
      agent.stopConfigWatcher()
    }
  }
} finally {
  globalThis.fetch = originalFetch
  const graph = artifacts.map(artifact => ({ file: artifact.file, sha256: artifact.hash }))
    .sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
  writeFileSync(path.join(output, 'results.json'), JSON.stringify({ dist, entry: 'main.js', reachableModules: artifacts.length,
    entrySha256: artifacts.find(artifact => artifact.file === 'main.js').hash,
    graphSha256: createHash('sha256').update(JSON.stringify(graph)).digest('hex'), graph, modules, reports }, null, 2))
  process.stdout.write(`Built runtime recovery report: ${output}/results.json\n`)
}
process.stdout.write(`PASS: ${reports.length} compiled runtime recovery scenarios\n`)
