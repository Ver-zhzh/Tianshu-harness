import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { buildConfigRoutes } from '../config-routes.js'
import { createRouter } from '../index.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { createInteractiveToolRegistry } from '../../bootstrap.js'
import { createAgentConfig, createMainAgentConfigInput } from '../../agent/create-agent-config.js'
import { AgentLoop } from '../../agent/loop.js'
import { SessionContext } from '../../agent/context.js'
import { TodoStore } from '../../tools/todo-store.js'
import { createMemoryTool } from '../../tools/memory.js'
import { __resetToolPresetForTest } from '../../tools/tool-preset.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'

const cwd = mkdtempSync(join(tmpdir(), 'tool-surface-route-'))
const saved = Object.fromEntries(['RIVET_HOME','RIVET_SESSION_DIR','RIVET_CONFIG_PATH','RIVET_TOOL_PRESET'].map(key => [key, process.env[key]]))
process.env.RIVET_HOME = join(cwd, 'home'); process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json'); process.env.RIVET_TOOL_PRESET = 'minimal'
__resetToolPresetForTest()
after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; __resetToolPresetForTest(); rmSync(cwd, { recursive: true, force: true }) })
const auth = { authorization: 'Bearer fixture' }

test('sidecar read query is lazy; explicit commands mount one tool and restrictions prevent runs', async () => {
  let assemblies = 0
  const received: string[] = [], agents: AgentLoop[] = []
  const manager = new RuntimeSessionManager({ defaultCwd: cwd, createAgent: (_cwd, sessionId) => {
    assemblies++
    const config = structuredClone(DEFAULT_CONFIG); config.agent.verificationSnapshot = 'off'
    const refs = { sessionId: sessionId!, todoStore: new TodoStore() }
    const { registry } = createInteractiveToolRegistry(refs as any, config, cwd)
    registry.register(createMemoryTool({} as any, { embeddingProvider: { isAvailable: () => false } } as any))
    const input = createMainAgentConfigInput({ toolPreset: registry.preset, userInstructions: DISABLED_USER_INSTRUCTIONS, apiKey: 'fixture', model: { id: 'fixture', maxTokens: 1024, contextWindow: 200_000 }, cwd, config, sessionId: sessionId!, toolDefinitions: registry.getDefinitions(), provider: { name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', capabilities: {}, models: [], unsupported: [] } as any })
    const agent = new AgentLoop({ ...createAgentConfig(input), toolRegistry: registry, maxTurns: 1 }, new SessionContext(), cwd)
    agents.push(agent)
    return { run: async prompt => { received.push(prompt) }, abort() {}, switchModel: () => null,
      enableTool: name => agent.enableTool(name), getToolSurface: () => agent.getToolSurface(), getMessages: () => [], listArtifacts: () => [], readArtifact: async () => null, replaceMessages() {}, rewindToMessages() {} }
  } })
  const router = createRouter(buildSessionRoutes(manager, 'fixture'))
  try {
    const created = await router('POST', '/sessions', { cwd }, auth), id = (created.body as any).id
    assert.equal(created.status, 201)
    assert.equal((await router('GET', `/sessions/${id}/tools`, {}, {})).status, 401)
    const unopened = await router('GET', `/sessions/${id}/tools`, {}, auth)
    assert.deepEqual(unopened.body, { initialized: false }); assert.equal(assemblies, 0)
    assert.equal((await router('GET', '/sessions/absent/tools', {}, auth)).status, 404)
    for (const [command, tool] of [['/galaxy inspect local modules', 'galaxy'], ['/starflow inspect local modules', 'starflow'], ['/council inspect local modules', 'council_convene']]) {
      const response = await router('POST', `/sessions/${id}/prompt`, { prompt: command }, auth)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      await new Promise(resolve => setTimeout(resolve, 20))
      const surface = (await router('GET', `/sessions/${id}/tools`, {}, auth)).body as any
      assert.ok(surface.surface.tools.some((t: any) => t.name === tool && t.state === 'visible'), tool)
      assert.equal(surface.surface.preset, 'minimal')
      assert.ok(!surface.surface.tools.some((t: any) => t.name === 'plan_task' && t.state === 'visible'))
    }
    assert.equal(assemblies, 1); assert.equal(received.length, 3)
    const events = manager.getEvents(id)!.events.filter(event => event.type === 'intent_note')
    assert.equal(events.length, 3); assert.ok(events.every(event => /已按显式指令启用/.test(String(event.data.summary))))
    agents[0]!.config.toolGating!.disabledTools = ['starflow']
    agents[0]!.updateTools()
    const blocked = await router('POST', `/sessions/${id}/prompt`, { prompt: '/starflow must remain blocked' }, auth)
    assert.equal(blocked.status, 409); assert.equal(received.length, 3)
    assert.match(String((blocked.body as any).error), /disabled/)
  } finally { await manager.shutdownAll() }
})

test('configuration API persists the new preset and domain override for subsequent sessions', async () => {
  const router = createRouter(buildConfigRoutes('fixture'))
  assert.equal((await router('PUT', '/config/tool-preset', { preset: 'orchestration' }, {})).status, 401)
  const saved = await router('PUT', '/config/tool-preset', { preset: 'orchestration' }, auth)
  assert.equal(saved.status, 200); assert.equal((saved.body as any).preset, 'orchestration')
  assert.equal(((await router('GET', '/config/tool-preset', {}, auth)).body as any).preset, 'orchestration')
  const invalid = await router('PUT', '/config/tool-preset', { preset: 'unknown' }, auth)
  assert.ok(invalid.status >= 400)
  const domain = await router('PUT', '/config/runtime-lean', { domains: { tianquan: { lean: false, toolPreset: 'orchestration' } } }, auth)
  assert.equal(domain.status, 200, JSON.stringify(domain.body))
})
