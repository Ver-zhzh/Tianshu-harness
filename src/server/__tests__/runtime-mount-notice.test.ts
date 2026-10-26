import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { providerSchema } from '../../config/schema.js'
import { buildManagedAgent } from '../serve-agent.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { __resetToolPresetForTest } from '../../tools/tool-preset.js'

test('production manager discloses mount losses on explicit replacement and auth self-healing only to the owning chat', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'runtime-notice-'))
  const keys = ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_CONFIG_PATH', 'RIVET_TOOL_PRESET', 'NOTICE_FIXTURE_KEY']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { RIVET_HOME: cwd, RIVET_SESSION_DIR: join(cwd, 'sessions'), RIVET_CONFIG_PATH: join(cwd, 'missing.json'), RIVET_TOOL_PRESET: 'minimal', NOTICE_FIXTURE_KEY: 'fixture' })
  __resetToolPresetForTest()
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain local fixture input */ }
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fixture complete.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = providerSchema.parse({ name: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, protocol: 'openai', thinking: 'disabled', apiKeyEnv: 'NOTICE_FIXTURE_KEY', models: [{ id: 'old', contextWindow: 200000, maxTokens: 512 }, { id: 'next', contextWindow: 200000, maxTokens: 512 }] })
  try {
    for (const healing of [false, true]) {
      const config = structuredClone(DEFAULT_CONFIG)
      config.agent.verificationSnapshot = 'off'; config.agent.maxTurns = 1; config.agent.defaultDomain = 'qiming'
      config.provider = { default: 'fixture', providers: { fixture: provider } }
      // A stale empty credential snapshot exercises the real run preflight; reload resolves the now-available env key.
      const context = { config, provider, model: provider.models[0]!, apiKey: healing ? '' : 'fixture', configured: true }
      let facade: ManagedAgent | undefined, constructionError: unknown
      const manager = new RuntimeSessionManager({ defaultCwd: cwd, createAgent: (_cwd, id) => {
        try { facade = buildManagedAgent(context, cwd, id!, undefined, 'manual', undefined, () => context) }
        catch (error) { constructionError = error; throw error }
        return facade
      } })
      try {
        const owner = manager.createSession({ cwd, model: 'fixture:old' }), sibling = manager.createSession({ cwd })
        assert.equal(await manager.ensureSessionAgent(owner.id), true, `healing=${healing}: ${String(constructionError)}`)
        assert.equal(facade!.enableTool!('galaxy').status, 'mounted')
        config.agent.toolGating.disabledTools = ['galaxy']
        if (healing) {
          assert.equal(manager.run(owner.id, '仅回答当前只读观察，不调用工具。'), true)
          for (let i = 0; i < 100 && manager.getSession(owner.id)!.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10))
          assert.equal(manager.getSession(owner.id)!.status, 'completed')
        } else assert.equal(await manager.switchModel(owner.id, 'fixture:next'), true)
        const notices = manager.getEvents(owner.id)!.events.filter(e => e.type === 'intent_note' && String(e.data.text).includes('galaxy(disabled)'))
        assert.equal(notices.length, 1, 'actual sidecar events must contain the warning, not only stderr')
        assert.match(String(notices[0]!.data.summary), /未恢复/)
        assert.ok(!manager.getEvents(sibling.id)!.events.some(e => String(e.data.text).includes('galaxy')))
        assert.equal(facade!.getToolSurface!().tools.find(t => t.name === 'galaxy')!.state, 'disabled')
        assert.equal(await manager.switchModel(owner.id, 'fixture:old'), true)
        assert.equal(manager.getEvents(owner.id)!.events.filter(e => e.type === 'intent_note' && String(e.data.text).includes('galaxy(disabled)')).length, 1)
      } finally { await manager.shutdownAll() }
    }
    assert.equal(requests, 1, 'only the explicitly requested healing run calls the local model')
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    __resetToolPresetForTest(); rmSync(cwd, { recursive: true, force: true })
  }
})
