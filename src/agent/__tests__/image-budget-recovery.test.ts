import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, type AgentCallbacks } from '../loop.js'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import { ArtifactStore } from '../../artifact/store.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { providerSchema } from '../../config/schema.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { loadContextImage } from '../context-image-archive.js'
import type { OaiMessage } from '../../api/oai-types.js'

for (const fault of ['none', 'archive', 'concurrent', 'snapshot', 'cancel'] as const) {
  test(`real image budget transaction survives guarded dispatch and restart: ${fault}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'image-budget-recovery-'))
    const previous = { RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR, RIVET_HOME: process.env.RIVET_HOME }
    process.env.RIVET_SESSION_DIR = join(root, 'sessions'); process.env.RIVET_HOME = join(root, 'home')
    const agents: AgentLoop[] = []
    t.after(async () => {
      for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPostSession(); await agent.drainPersistWrites().catch(() => {}); agent.stopFsWatcher(); agent.stopConfigWatcher() }
      for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value
      rmSync(root, { recursive: true, force: true })
    })
    const bodies: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body)
      return new Response('data: {"choices":[{"delta":{"content":"Ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_hit_tokens":80}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const provider = providerSchema.parse({ name: 'image-fixture', baseUrl: 'https://image.fixture.invalid/v1', maxRetries: 0, maxTokens: 4096, models: [] })
    const makeClient = () => createProviderClient(provider, resolveCapabilities(provider.name), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
    const engineConfig = { model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' } }
    const engine = new PromptEngine(engineConfig), session = new SessionContext(), persist = new SessionPersist('budget-fixture', root)
    const initial: OaiMessage[] = [{ role: 'user', origin: 'human', content: 'Keep requirements.' }]
    for (let i = 0; i < 5; i++) initial.push({ role: 'user', origin: 'hook', content: [{ type: 'text', text: `Picture ${i}` },
      { type: 'image_url', image_url: { url: `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}${String(i).repeat(1_700_000)}` } }] })
    initial.push({ role: 'assistant', content: 'Earlier turn completed.' })
    session.replaceMessages(initial)
    await persist.compactOaiAsync(initial, true)
    const client = makeClient()
    const makeAgent = (context: SessionContext, prompt: PromptEngine, storage: SessionPersist, stream = client) => {
      const agent = new AgentLoop({ client: stream, primaryClient: stream, promptEngine: prompt, toolRegistry: new ToolRegistry(),
        headless: true, maxTurns: 1, contextWindow: 1_000_000, compact: { enabled: false, model: 'fixture' }, crossSessionEnabled: false,
        sessionId: 'budget-fixture', sessionPersist: storage, agentReconnect: { enabled: false, maxAttempts: 0 } }, context, root)
      agents.push(agent); return agent
    }
    const agent = makeAgent(session, engine, persist)
    const store = agent.artifactStore!
    // Publish the original prefix first; otherwise no authorization transition is exercised.
    await client.stream(engine.buildOaiRequest(initial, [], 1_000_000), { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: e => { throw e } })
    await persist.commitFrozenSnapshot(engine.exportFrozenSnapshot())
    const generation = client.getMainPrefixProof!()!.cacheGenerationId
    let armed = true
    const save = store.saveDurable.bind(store)
    if (fault === 'archive' || fault === 'concurrent' || fault === 'cancel') t.mock.method(store, 'saveDurable', async (input: Parameters<ArtifactStore['saveDurable']>[0]) => {
      if (armed) {
        armed = false
        if (fault === 'archive') throw new Error('archive unavailable')
        if (fault === 'cancel') agent.abortController?.abort(new Error('cancelled during image archive'))
        else session.addUserMessage('Concurrent human input must remain.')
      }
      return save(input)
    })
    if (fault === 'snapshot') {
      const commit = persist.commitFrozenSnapshot.bind(persist)
      t.mock.method(persist, 'commitFrozenSnapshot', async (snapshot: Parameters<SessionPersist['commitFrozenSnapshot']>[0], cancelled?: string) => {
        if (armed && snapshot.rewindAuthorization && !snapshot.pendingCompaction) { armed = false; throw new Error('snapshot unavailable') }
        return commit(snapshot, cancelled)
      })
    }
    const errors: Error[] = []
    const callbacks: AgentCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {},
      onError: e => errors.push(e), onApprovalRequired: async () => false }
    await agent.run('Continue with the original requirements.', callbacks)
    await agent.drainPersistWrites()
    if (fault !== 'none') {
      if (fault !== 'cancel') assert.ok(errors.length)
      assert.equal(bodies.length, 1, 'failed archive or stale candidate must not dispatch a second HTTP request')
      if (fault === 'concurrent') assert.ok(session.getMessages().some(m => m.content === 'Concurrent human input must remain.'))
      else {
        errors.length = 0
        await agent.run('Retry after storage recovers.', callbacks)
        assert.deepEqual(errors, [], 'same image set must retry budgeting after a failed attempt')
      }
    }
    if (fault === 'concurrent') return
    assert.equal(bodies.length, 2)
    assert.ok(Buffer.byteLength(JSON.stringify(bodies.at(-1))) < 6_000_000)
    assert.notEqual(client.getMainPrefixProof!()!.cacheGenerationId, generation)
    assert.equal(client.getMainPrefixProof!()!.generationReason, 'image_budget')
    const imageRef = /context-image:[A-Za-z0-9_-]+/.exec(JSON.stringify(session.getMessages()))?.[0]
    assert.ok(imageRef)
    await agent.drainPersistWrites(); await persist.drainFrozenSnapshots()
    const frozen = persist.readFrozenSnapshot()!
    assert.equal(frozen.executionSnapshot?.generationReason, 'image_budget')
    const restoredSession = new SessionContext(), restoredPersist = new SessionPersist('budget-fixture', root)
    restoredSession.replaceMessages(restoredPersist.loadOai())
    const restoredEngine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: frozen })
    const restoredClient = makeClient(); restoredClient.restoreExecutionSnapshot!(frozen.executionSnapshot!)
    const restored = makeAgent(restoredSession, restoredEngine, restoredPersist, restoredClient)
    errors.length = 0
    await restored.run('Continue again.', callbacks)
    assert.deepEqual(errors, [])
    assert.equal(restoredClient.getMainPrefixProof!()!.cacheGenerationId, frozen.executionSnapshot!.cacheGenerationId)
    assert.ok((await loadContextImage(restored.artifactStore, imageRef))?.dataUrl.startsWith('data:image/gif;base64,'))
  })
}
