import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { SessionPersist } from '../../agent/session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'

test('desktop real assembly persists image anchors and restores dispatched history on rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serve-frozen-'))
  const oldHome = process.env.RIVET_HOME, oldDir = process.env.RIVET_SESSION_DIR
  process.env.RIVET_HOME = join(dir, 'home'); process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  const agents: import('../../agent/loop.js').AgentLoop[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  try {
    const { buildAgentLoop } = await import('../serve-agent.js')
    const config = structuredClone(DEFAULT_CONFIG)
    const provider = { ...config.provider.providers.deepseek!, name: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', contextWindow: 100000, maxTokens: 4096 }] }
    config.provider = { default: 'fixture', providers: { fixture: provider } }
    const ctx = { config, provider, model: provider.models[0]!, apiKey: 'fixture', configured: true }
    const first = buildAgentLoop(ctx, dir, 'frozen-desktop').agent; agents.push(first)
    const image: OaiMessage = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    const domain = { name: 'tianshu', volatileBlock: 'same domain', motto: 'same motto' }
    first.config.promptEngine.setActiveDomain(domain)
    first.config.promptEngine.setCrossSessionMemoryBlock('unique-saved-appendix')
    const request = first.config.promptEngine.buildOaiRequest([image])
    assert.ok(JSON.stringify(request.messages[1]).includes('unique-saved-appendix'))
    await first.config.client.stream(request, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error: Error) { throw error } })
    const persist = new SessionPersist('frozen-desktop', dir)
    await persist.appendOaiWithChecksum(image); await persist.flushSessionBuffer()
    await first.drainPersistWrites()
    assert.equal(persist.readFrozenSnapshot()?.anchors?.length, 1, 'production assembly must wire changed snapshots')
    const second = buildAgentLoop(ctx, dir, 'frozen-desktop').agent; agents.push(second)
    assert.deepEqual(second.session.getMessages()[0], image)
    second.config.promptEngine.setActiveDomain(domain)
    assert.deepEqual(second.config.promptEngine.buildOaiRequest([image]).messages, request.messages,
      'real desktop rebuild must retain the current image boundary after domain assembly')
    const restored = second.config.promptEngine.buildOaiRequest([image, { role: 'user', content: 'continue' }])
    assert.deepEqual(restored.messages[1], request.messages[1], 'actual consumer must inherit disk snapshot')
  } finally {
    globalThis.fetch = previousFetch
    for (const agent of agents) { agent.abort(); await agent.cancelIdleCompaction(); await agent.drainPersistWrites(); agent.config.coordinatorRef?.()?.shutdown() }
    if (oldHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = oldHome
    if (oldDir === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = oldDir
    await rm(dir, { recursive: true, force: true })
  }
})
