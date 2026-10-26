import { execFileSync } from 'node:child_process'
import { filterToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractiveToolRegistry } from '../../bootstrap.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { __resetToolPresetForTest, type ToolPreset } from '../../tools/tool-preset.js'
import { createMemoryTool } from '../../tools/memory.js'
import { TodoStore } from '../../tools/todo-store.js'
import { ORCHESTRATION_TOOLS, gateToolDefinitions } from '../tool-tiers.js'
import { createAgentConfig, createMainAgentConfigInput } from '../create-agent-config.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { setActiveScheduler } from '../../server/cron-scheduler.js'
import { STAR_DOMAINS } from '../star-domain-data.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'

const cwd = mkdtempSync(join(tmpdir(), 'tool-surface-'))
const saved = Object.fromEntries(['RIVET_HOME','RIVET_SESSION_DIR','RIVET_CONFIG_PATH','RIVET_TOOL_PRESET'].map(key => [key, process.env[key]]))
process.env.RIVET_HOME = join(cwd, 'home'); process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json')
after(() => { setActiveScheduler(undefined); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; __resetToolPresetForTest(); rmSync(cwd, { recursive: true, force: true }) })
function assemble(preset: ToolPreset, domain = 'qiming') {
  process.env.RIVET_TOOL_PRESET = preset; __resetToolPresetForTest()
  const config = structuredClone(DEFAULT_CONFIG)
  config.agent.defaultDomain = domain; config.agent.verificationSnapshot = 'off'
  const refs = { sessionId: `surface-${preset}-${domain}`, todoStore: new TodoStore() }
  const { registry } = createInteractiveToolRegistry(refs as any, config, cwd)
  if (preset !== 'taiyi') registry.register(createMemoryTool({} as any, { embeddingProvider: { isAvailable: () => false } } as any))
  const input = createMainAgentConfigInput({ toolPreset: registry.preset, userInstructions: DISABLED_USER_INSTRUCTIONS,
    apiKey: 'fixture', model: { id: 'fixture', maxTokens: 1024, contextWindow: 200_000 }, cwd, config,
    sessionId: refs.sessionId, toolDefinitions: registry.getDefinitions(),
    provider: { name: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai', capabilities: {}, models: [], unsupported: [] } as any })
  const built = createAgentConfig(input)
  const agent = new AgentLoop({ ...built, toolRegistry: registry, maxTurns: 1 }, new SessionContext(), cwd)
  return { registry, input, built, agent }
}
function names(engine: any): string[] { return engine.config.staticCtx.tools.map((t: any) => t.name) }

for (const scheduler of [false, true]) test(`real assembly, constructor and refresh respect preset with scheduler=${scheduler}`, () => {
  setActiveScheduler(scheduler ? {} as any : undefined)
  for (const [preset, count] of [['minimal',26],['frontend',27],['orchestration',30],['full',scheduler?46:43],['taiyi',scheduler?16:13]] as const) {
    const { registry, input, built, agent } = assemble(preset)
    assert.equal(registry.preset, preset); assert.equal(input.toolGating?.preset, preset)
    assert.equal(names(built.promptEngine).length, count, preset)
    assert.equal(agent.getActiveToolNames().length, count, preset)
    agent.updateTools(); assert.equal(names(built.promptEngine).length, count, 'refresh must consume the same frozen preset')
    if (preset !== 'taiyi') {
      for (const tool of ORCHESTRATION_TOOLS) assert.ok(registry.get(tool), `cold tool missing: ${tool}`)
      for (const tool of ['delegate_task','delegate_batch','team_orchestrate','memory','recall_capsule','ask_image','ast_grep','job','run_tests','deliver_task']) assert.ok(agent.getActiveToolNames().includes(tool), tool)
    }
    if (preset === 'minimal') {
      assert.ok(registry.get('git_scout'), 'worker retains the actual read-only Git tool')
      assert.ok(!agent.getActiveToolNames().includes('git_scout'))
      for (const tool of ORCHESTRATION_TOOLS) assert.ok(!agent.getActiveToolNames().includes(tool))
    }
  }
})

test('all fifteen ordinary domains share the focused default; MCP stays visible and mounts are isolated/idempotent', () => {
  setActiveScheduler(undefined)
  for (const domain of Object.keys(STAR_DOMAINS).filter(d => d !== 'taiyi')) {
    const { registry, agent, built } = assemble('minimal', domain)
    assert.equal(agent.getActiveToolNames().length, 26, domain)
    registry.register({ definition: { name: 'mcp_fixture_lookup', description: 'fixture', input_schema: { type: 'object', properties: {} } }, isEnabled: () => true } as any)
    agent.updateTools(); assert.equal(agent.getActiveToolNames().length, 27)
    assert.equal(agent.enableTool('galaxy').status, 'mounted')
    assert.equal(agent.enableTool('galaxy').status, 'already-active')
    agent.updateTools()
    assert.ok(names(built.promptEngine).includes('galaxy')); assert.ok(!names(built.promptEngine).includes('starflow'))
  }
})

test('explicit allow-lists and disables dominate preset defaults and mounting at the real consumer', () => {
  const { agent, built } = assemble('orchestration')
  agent.config.toolGating = { enabled: true, preset: 'orchestration', coreOverride: ['read_file'], disabledTools: ['read_file','galaxy'] }
  agent.updateTools(); assert.deepEqual(names(built.promptEngine), [])
  assert.equal(agent.enableTool('galaxy').status, 'disabled')
  assert.equal(agent.enableTool('starflow').status, 'restricted')
  assert.deepEqual(agent.getActiveToolNames(), [])
  assert.deepEqual(gateToolDefinitions([{ name: 'read_file' }], { enabled: false, disabledTools: ['read_file'] }), [])
})

test('schedule tools are explicitly mountable only with a real scheduler registration', () => {
  setActiveScheduler(undefined)
  let agent = assemble('minimal').agent
  assert.equal(agent.enableTool('schedule_create').status, 'unknown')
  setActiveScheduler({} as any)
  agent = assemble('minimal').agent
  assert.ok(!agent.getActiveToolNames().includes('schedule_create'))
  assert.equal(agent.enableTool('schedule_create').status, 'mounted')
  assert.ok(agent.getActiveToolNames().includes('schedule_create'))
  assert.ok(!agent.getActiveToolNames().includes('schedule_delete'))
  setActiveScheduler(undefined)
})

test('a real readonly worker registry keeps executable Git queries without Git write tools', async () => {
  const { registry, agent } = assemble('minimal')
  const order = createReadOnlyWorkOrder({ parentTurnId: 'git-query-worker', kind: 'code_search', profile: 'code_scout', authority: 'tianquan', objective: 'Inspect repository facts', scope: {} })
  const worker = filterToolRegistry(registry, order.allowedTools.filter(name => registry.has(name)))
  assert.ok(worker.has('git_scout')); assert.ok(!worker.has('git')); assert.ok(!worker.has('bash'))
  assert.ok(!agent.getActiveToolNames().includes('git_scout'))
  const repo = mkdtempSync(join(cwd, 'worker-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const result = await worker.execute('git_scout', { cwd: repo, toolUseId: 'worker-tags', input: { action: 'tags' } })
  assert.ok(!result.isError, result.content)
})
