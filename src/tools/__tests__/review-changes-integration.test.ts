import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createReviewChangesTool } from '../review-changes.js'
import { createReviewInbox } from '../../agent/review-inbox.js'
import { createCoordinatorReviewDeps } from '../../agent/review-coordinator-deps.js'
import { DelegationCoordinator } from '../../agent/coordinator.js'
import { ToolRegistry } from '../registry.js'
import { profileRegistry } from '../../agent/profile-registry.js'
import { freezeReviewSnapshot, reviewSnapshotCwd } from '../../agent/review-snapshot.js'
import { createWorkerRuntimeFactory } from '../../agent/worker-runtime.js'
import { configSchema } from '../../config/schema.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'

it('dirty review freezes additions, deletions and modifications and detects later edits', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-dirty-snapshot-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(cwd, 'a.ts'), 'old\n'); writeFileSync(join(cwd, 'gone.ts'), 'gone\n')
    git('add', '--', 'a.ts', 'gone.ts'); git('commit', '-qm', 'base')
    writeFileSync(join(cwd, 'a.ts'), 'new\n'); writeFileSync(join(cwd, 'added.ts'), 'added\n'); rmSync(join(cwd, 'gone.ts'))
    const snapshot = await freezeReviewSnapshot(cwd, { kind: 'dirty-diff', files: ['a.ts', 'added.ts', 'gone.ts'], capturedAt: Date.now() })
    try {
      assert.equal(reviewSnapshotCwd(snapshot), snapshot.cwd)
      const diff = readFileSync(join(snapshot.cwd, snapshot.diffFile), 'utf8')
      assert.match(diff, /\+added/); assert.match(diff, /-gone/); assert.match(diff, /\+new/)
      assert.equal(snapshot.isCurrent(), true)
      writeFileSync(join(cwd, 'a.ts'), 'changed again\n')
      assert.equal(snapshot.isCurrent(), false)
      assert.equal(readFileSync(join(snapshot.cwd, 'a.ts'), 'utf8'), 'new\n')
    } finally { snapshot.destroy() }
    assert.throws(() => reviewSnapshotCwd(snapshot), /unavailable/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('real route and coordinator consume immutable content with no test, write, or patch worker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readonly-review-chain-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test')
    mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1\n')
    git('add', '--', 'src/a.ts'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 2\n')
    git('commit', '-qam', 'review target')
    const target = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 99\n')
    git('commit', '-qam', 'peer commit')
    const peer = git('rev-parse', 'HEAD')
    const registry = new ToolRegistry()
    for (const name of [...profileRegistry.get('reviewer')!.allowedTools, 'run_tests', 'write_file', 'bash']) registry.register({
      definition: { name, description: name, input_schema: { type: 'object', properties: {} } },
      execute: async () => { throw new Error(`unexpected tool execution: ${name}`) },
      requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true,
    })
    let calls = 0
    const config = configSchema.parse({ provider: { default: 'fixture', providers: { fixture: {
      name: 'fixture', apiKey: 'fixture-placeholder', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 1024 }],
    } } } })
    const factory = createWorkerRuntimeFactory(() => ({ config, cwd, provider: config.provider.providers.fixture!, apiKey: 'fixture-placeholder',
      auth: undefined, currentModelId: 'fixture', getUserInstructions: () => DISABLED_USER_INSTRUCTIONS,
      listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: ['patcher'],
    }))
    const coordinator = new DelegationCoordinator({ cwd, baseToolRegistry: registry, maxWorkers: 1,
      modelCards: [{ model: 'fixture', toolUseReliability: 1, jsonStability: 1, editSuccessRate: 1, testRepairRate: 1, contextWindow: 100000, cacheEconomics: 'medium', recommendedTasks: ['code_search'] }],
      runtimeFactory: factory.runtimeFactory,
      runHands: async () => { throw new Error('patcher/write worker must not run') },
      runWorker: async config => {
        calls++
        assert.equal(config.order.profile, 'reviewer')
        assert.notEqual(config.cwd, cwd)
        assert.ok(config.workspaceRoots?.includes(config.cwd), 'production runtime roots must point to the immutable snapshot')
        assert.equal(config.workspaceRoots?.includes(cwd), false, 'the live workspace must not remain a review root')
        assert.equal(readFileSync(join(config.cwd, 'src/a.ts'), 'utf8'), 'export const a = 2\n')
        for (const forbidden of ['run_tests', 'bash', 'write_file', 'edit_file', 'deliver_task']) assert.equal(config.toolRegistry.has(forbidden), false, forbidden)
        const patch = config.order.objective.match(/读取 (\.review-[^\s]+\.patch)/)![1]!
        assert.match(readFileSync(join(config.cwd, patch), 'utf8'), /\+export const a = 2/)
        assert.match(config.order.objective, new RegExp(base))
        assert.match(config.order.objective, new RegExp(target))
        return { result: { workOrderId: config.order.id, status: 'passed', summary: 'found bug',
          findings: [{ claim: 'bug', evidence: 'src/a.ts:1', confidence: 'high', severity: 'HIGH' }],
          artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' },
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 }, session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      },
    })
    const inbox = createReviewInbox(cwd, 'owner', { file: join(cwd, 'inbox.json') })
    const tool = createReviewChangesTool(() => ({ cwd, sessionId: 'owner', reviewDeps: createCoordinatorReviewDeps(coordinator), createInbox: () => inbox }))
    const result = await tool.execute({ cwd, toolUseId: 'fixed-snapshot', input: { action: 'start', commit_ref: target } })
    assert.equal(calls, 1)
    assert.match(result.content, /bug/)
    assert.equal(inbox.list()[0]!.commitRef, target)
    assert.equal(git('rev-parse', 'HEAD'), peer)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('max review reports unavailable inspectors as inconclusive and preserves findings', async () => {
  const { routeReviewWorkflow } = await import('../../agent/review-router.js')
  const result = await routeReviewWorkflow({ files: ['a.ts'], crossModule: false, isFix: false, forceLevel: 'L3' }, {
    spawnVerifier: async () => { throw new Error('no verifier') }, spawnPatcher: async () => { throw new Error('no patcher') },
    spawnSquadron: async () => ({ findings: [], infraFailures: [{ kind: 'worker', claim: 'all unavailable' }] }),
  }, { readonly: true })
  assert.equal(result.verdict, 'inconclusive')
  assert.match(result.evidence!, /all unavailable/)
  const empty = await routeReviewWorkflow({ files: ['a.ts'], crossModule: false, isFix: false, forceLevel: 'L3' },
    createCoordinatorReviewDeps({ delegate: async () => ({ status: 'completed', results: [], packet: '' }) }), { readonly: true })
  assert.equal(empty.verdict, 'inconclusive', 'zero returned results cannot masquerade as a completed review')
})
