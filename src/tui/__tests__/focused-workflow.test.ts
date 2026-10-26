import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTuiSlashCommands } from '../slash-commands.js'
import { makeApp } from '../engine/__tests__/_harness.js'
import { AgentLoop } from '../../agent/loop.js'
import { SessionContext } from '../../agent/context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { gateToolDefinitions } from '../../agent/tool-tiers.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { createTeamOrchestrateTool } from '../../tools/team-orchestrate.js'
import { resolveAppPromptInput } from '../prompt-input-resolver.js'
import { activateRequiredToolsNow } from '../../workflows/required-tools.js'

const cwd = mkdtempSync(join(tmpdir(), 'focused-workflow-'))
after(() => rmSync(cwd, { recursive: true, force: true }))
function fixture() {
  const registry = new ToolRegistry({ preset: 'minimal' })
  for (const name of ['read_file', 'galaxy', 'starflow', 'council_convene', 'git_scout', 'plan_task']) registry.register({ definition: { name, description: name, input_schema: { type: 'object', properties: {} } }, isEnabled: () => true, requiresApproval: () => false, isConcurrencySafe: () => false, execute: async () => ({ content: name }) })
  const engine = new PromptEngine({ model: 'fixture', maxTokens: 1024, staticCtx: { tools: gateToolDefinitions(registry.getDefinitions(), { enabled: true, preset: registry.preset }) }, volatileCtx: { cwd } })
  const agent = new AgentLoop({ toolRegistry: registry, promptEngine: engine, client: { stream: async () => {} } as any, maxTurns: 1, contextWindow: 200_000, toolGating: { enabled: true, preset: 'minimal' }, prefixCacheStrategy: 'deepseek-native', compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, new SessionContext(), cwd)
  const { app } = makeApp({ cols: 140 })
  registerTuiSlashCommands(app, { agent, cwd, config: structuredClone(DEFAULT_CONFIG), refs: {}, provider: { name: 'fixture', models: [] } } as any)
  return { app, agent, registry }
}

test('registered TUI commands mount only their tool before submitting the transformed prompt', async () => {
  const { app, agent } = fixture()
  const prompts: string[] = []
  app.submitText = prompt => { prompts.push(prompt) }
  try {
    for (const [command, tool] of [['/galaxy inspect', 'galaxy'], ['/starflow inspect', 'starflow'], ['/council inspect', 'council_convene']] as const) {
      assert.equal(await app.tryDispatchSlash(command), true)
      assert.ok(agent.getActiveToolNames().includes(tool))
      assert.ok(!agent.getActiveToolNames().includes('plan_task'))
      assert.match(app.getScrollbackContent(), /一次性/)
    }
    assert.equal(prompts.length, 3)
    assert.equal(agent.config.toolRegistry.preset, 'minimal')
    agent.config.toolGating!.disabledTools = ['starflow']; agent.updateTools()
    assert.equal(await app.tryDispatchSlash('/starflow blocked'), true)
    assert.equal(prompts.length, 3); assert.match(app.getScrollbackContent(), /disabled/)
  } finally { app.dispose() }
})

test('TUI /tools reports current registered, visible, cold, unavailable and restricted tools', async () => {
  const { app, agent, registry } = fixture()
  registry.register({ definition: { name: 'fixture_unavailable', description: 'fixture', input_schema: { type: 'object', properties: {} } }, isEnabled: () => false } as any)
  agent.config.toolGating!.disabledTools = ['git_scout']; agent.updateTools()
  try {
    assert.equal(await app.tryDispatchSlash('/tools'), true)
    const output = app.getScrollbackContent()
    for (const term of ['minimal', '装配 7 / 主控可见 1', '当前可见', '当前不可见', '未注册', '显式禁用', '能力不可用']) assert.ok(output.includes(term), term)
  } finally { app.dispose() }
})

test('default /team prompt executes a Markdown plan with no plan_task tool registered', async () => {
  const registry = new ToolRegistry({ preset: 'minimal' })
  let dispatches = 0
  registry.register(createTeamOrchestrateTool({ delegateBatch: async requests => { dispatches++; assert.equal(requests.length, 2); return { status: 'completed', results: [], packet: 'executed' } } }))
  const resolved = resolveAppPromptInput('/team docs/approved.md', cwd)!
  assert.ok(resolved.prompt.includes('planPath')); assert.ok(resolved.prompt.includes('planMarkdown'))
  assert.doesNotMatch(resolved.prompt, /Call plan_task/)
  assert.equal(activateRequiredToolsNow(resolved.requiredTools, () => { throw Error('default team requires no extra tools') }).ok, true)
  const result = await registry.execute('team_orchestrate', { cwd, toolUseId: 'direct-plan', input: { mode: 'standard', objective: 'force: implement the approved changes', planMarkdown: '### Task 1: update source\nModify `src/a.ts`\n### Task 2: update docs\nModify `docs/a.md`' } })
  assert.ok(!result.isError, result.content); assert.equal(dispatches, 1); assert.ok(!registry.get('plan_task'))
})
