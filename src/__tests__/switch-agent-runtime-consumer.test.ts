import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BootstrapContext, RuntimeRefs } from '../bootstrap.js'

test('real runtime replacement emits one audit event, never writes a sticky cache status, and repeated selection is inert', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-switch-'))
  const saved = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
  process.env.RIVET_HOME = join(dir, 'home')
  process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const { createAgentRuntime, switchAgentRuntime } = await import('../bootstrap.js')
  const { DEFAULT_CONFIG } = await import('../config/default.js')
  const { providerSchema } = await import('../config/schema.js')
  const { SessionPersist } = await import('../agent/session-persist.js')
  const { SessionContext } = await import('../agent/context.js')
  const { FileHistory } = await import('../agent/file-history.js')
  const { DomainKnowledgeStore } = await import('../agent/domain-knowledge-store.js')
  const { ToolRegistry } = await import('../tools/registry.js')
  const { TodoStore } = await import('../tools/todo-store.js')
  const { DISABLED_USER_INSTRUCTIONS } = await import('../prompt/user-instructions.js')
  const provider = providerSchema.parse({ name: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', models: [{ id: 'before' }, { id: 'after' }] })
  const config = structuredClone(DEFAULT_CONFIG)
  config.provider = { default: 'fixture', providers: { fixture: provider } }
  const persist = new SessionPersist('switch-fixture', dir)
  const claimStore = persist.createClaimStore()
  const fileHistory = new FileHistory(join(dir, 'backups'), 'switch-fixture')
  const domainKnowledgeStore = new DomainKnowledgeStore(join(dir, 'knowledge'))
  const refs = {
    coordinator: null, fileHistory, claimStore, sessionId: 'switch-fixture', sessionRegistry: null,
    taskLedger: null, ownershipLedger: null, verificationSnapshotManager: null, deliveryGate: null,
    meridianIndexer: null, mcpManager: null, lspManager: null, banditState: null, promptEngine: null,
    goalTrackerRef: { current: null }, reviewGateRef: { current: 'off' }, pluginHooks: [], pluginCommands: [], todoStore: new TodoStore(),
  } as RuntimeRefs
  const session = new SessionContext(), toolRegistry = new ToolRegistry()
  const { agent } = createAgentRuntime({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider, apiKey: 'fixture-only', auth: undefined,
    config, sessionId: 'switch-fixture', cwd: dir, toolRegistry, persist, claimStore, fileHistory, refs, domainKnowledgeStore, modelId: 'before', session })
  const statuses: unknown[] = [], audits: unknown[] = []
  let changed = 0
  t.mock.method(persist, 'appendModelSwitch', (event: unknown) => { audits.push(event) })
  const ctx = { agent, provider, apiKey: 'fixture-only', config, sessionId: 'switch-fixture', cwd: dir, toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, session, setStatusLine: (text: string | null) => statuses.push(text), onAgentRuntimeChanged: () => { changed++ },
  } as unknown as BootstrapContext
  t.after(async () => {
    for (const runtime of new Set([agent, ctx.agent])) {
      runtime.abort(); runtime.stopFsWatcher(); runtime.stopConfigWatcher()
      await runtime.config.externalHookRuntime?.close()
    }
    refs.coordinator?.shutdown()
  })
  const result = switchAgentRuntime(ctx, 'after', 'fixture')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.notEqual(ctx.agent, agent)
  assert.equal(ctx.agent.config.promptEngine.getModel(), 'after')
  assert.equal(audits.length, 1)
  assert.equal(changed, 1)
  assert.deepEqual(statuses, [], 'cache information belongs in the one-time switch confirmation, never the persistent status channel')
  const replacement = ctx.agent, client = replacement.config.client
  const frozen = replacement.config.promptEngine.exportFrozenSnapshot()
  assert.equal(switchAgentRuntime(ctx, 'after', 'fixture').changed, false)
  assert.equal(ctx.agent, replacement)
  assert.equal(ctx.agent.config.client, client)
  assert.deepEqual(ctx.agent.config.promptEngine.exportFrozenSnapshot(), frozen)
  assert.equal(audits.length, 1)
  assert.equal(changed, 1)
})
