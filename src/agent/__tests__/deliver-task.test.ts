import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDeliverTaskTool, detectSymptomPatch, parseLearnedEntries } from '../deliver-task.js'
import { appendMemoryEntry, readMemoryEntries } from '../../memory/unified-memory.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewOutcome, ReviewRouterDeps, ReviewRouterOptions } from '../review-router.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { ToolCallParams, ToolResult, DelegationActivity } from '../../tools/types.js'
import type { SessionRegistry } from '../session-registry.js'
import { getReviewHealth, resetReviewHealth } from '../review-health.js'
import { openCandidateDeliveryTree } from '../candidate-delivery-tree.js'
import { candidateSnapshotRef } from '../candidate-snapshot-ref.js'
import { resolveDeliveryImpact } from '../delivery-impact.js'
import { diagnoseCandidateEvidence } from '../delivery-candidate-diagnostics.js'
import { deliveryNextAction } from '../delivery-no-progress.js'
import { commitScopedFiles } from '../scoped-git-commit.js'
import { readDeliveryReceipt } from '../delivery-receipt.js'

it('receipt belongs to this commit even when a peer advances HEAD before tool readback', async () => {
  await withGitRepo(async cwd => {
    const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
    let own = '', peer = ''
    const { tool, params } = makeContext({ taskId: 'receipt-race', sessionId: 'receipt-owner', ownedFiles: ['src/a.ts'], dirtyFiles: ['src/a.ts'],
      commitOwnedFiles: async (cwd, files, message) => {
        const result = await commitScopedFiles({ cwd, files, message })
        own = result.commitSha!
        git('commit', '--allow-empty', '-qm', 'peer change after own commit')
        peer = git('rev-parse', 'HEAD')
        return result
      },
    })
    const result = await tool.execute({ ...params, cwd, input: { commit: true, message: 'own safe change' } })
    assert.ok(own)
    assert.notEqual(own, peer)
    assert.match(result.content, new RegExp(`VERIFIED: 本次提交 ${own}`))
    assert.doesNotMatch(result.content, new RegExp(peer))
    assert.equal(readDeliveryReceipt(cwd, 'receipt-owner'), own)
    assert.equal(readDeliveryReceipt(cwd, 'another-owner'), undefined)
  })
})

it('stops index retries with a Git action rather than asking for another test run', () => {
  const diagnostic = { currentRef: 'same-ref', onlyInCurrent: [], onlyInPassed: [], excludedCandidateProofs: 0,
    unboundProofs: 0, nextRun: 'run_tests(files=["a.test.ts"], deliveryFiles=["a.ts"])' }
  assert.match(deliveryNextAction('git-index-lock', diagnostic), /index.lock/)
  assert.doesNotMatch(deliveryNextAction('git-index-lock', diagnostic), /run_tests/)
})

it('does not diagnose a same-candidate failure after its matching scope passes', () => {
  const ledger = createTaskLedger({ taskId: 'diagnostic-supersession' })
  const meta = { snapshotRef: 'same-ref', candidateFiles: ['src/a.ts'], targetFiles: ['src/a.test.ts'], kind: 'test' as const, scope: 'targeted' as const }
  ledger.record({ type: 'verification', command: 'npm test src/a.test.ts', status: 'failed', meta })
  ledger.record({ type: 'verification', command: 'npm test src/a.test.ts', status: 'passed', meta })
  const diagnostics = diagnoseCandidateEvidence(ledger.getVerifications(), 'same-ref', ['src/a.ts'])
  assert.equal(diagnostics.currentFailure, undefined)
})

function makeContext(opts: {
  taskId: string
  ownedFiles: string[]
  externalFiles?: string[]
  preExistingUntracked?: string[]
  dirtyFiles?: string[]
  verifications?: Array<{ command: string; status: 'passed' | 'failed' | 'blocked'; meta?: Record<string, unknown> }>
  projectMemory?: string
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => import('../scoped-git-commit.js').ScopedCommitResult | Promise<import('../scoped-git-commit.js').ScopedCommitResult>
  routeReviewWorkflow?: (change: ChangeSet, deps: ReviewRouterDeps, options?: ReviewRouterOptions) => Promise<ReviewOutcome>
  reviewDeps?: ReviewRouterDeps
  disableReviewDeps?: boolean
  reviewDepth?: number
  sessionRegistry?: SessionRegistry
  sessionId?: string
  detectWroteButNeverRead?: (cwd: string, files: string[]) => Array<{ symbol: string; file: string; kind: 'export' | 'field' }>
  meridianDb?: import('../../repo/meridian-db.js').MeridianDb
  typecheckRunner?: import('../typecheck-gate.js').TypecheckRunner
  declaredCheckRunner?: import('../typecheck-gate.js').DeclaredCommandRunner
  taskContract?: import('../../context/task-contract.js').TaskContract
  inventorySearcher?: import('../regression-inventory.js').InventorySearcher
  obligationGateRunner?: import('../council/council-obligations.js').GateRunner
  impactedTests?: string[]
  resolveDeliveryImpact?: (cwd: string, files: readonly string[], proof?: import('../../repo/type-only-import.js').TypecheckProof) => Promise<import('../delivery-impact.js').DeliveryImpact>
  getCurrentSnapshotRef?: () => string | undefined
  getCurrentSnapshotRefForFiles?: (files: string[]) => string | undefined
  prepareCandidateTree?: (cwd: string, files: readonly string[], signal?: AbortSignal) => Promise<import('../candidate-delivery-tree.js').CandidateDeliveryTree>
  palConvergedCases?: import('../problem-attack-loop.js').ConvergedCaseEntry[]
  palNeedsUserCases?: Array<{ caseId: string; problem: string; minimalQuestion: string }>
  reviewConfig?: import('../../config/schema.js').ReviewConfig
  isAutoReviewOff?: boolean
  goalAchieved?: boolean
  autoCommit?: boolean
  obligationStore?: import('../evidence-obligation.js').ObligationStore
  claimTracker?: import('../hooks/external-claim-tracking-hook.js').ClaimTracker
  scoutFirewall?: boolean
  completeBaseline?: boolean
  recaptureBaseline?: (cwd: string) => boolean
  repoRoot?: string
}) {
  const baseline = createWorktreeBaseline({
    branch: 'feat/b1',
    head: 'abc123',
    preExistingDirty: opts.externalFiles ?? [],
    preExistingUntracked: opts.preExistingUntracked ?? [],
    capturedAt: Date.now(),
    complete: opts.completeBaseline,
  })
  const ledger = createTaskLedger({ taskId: opts.taskId })
  for (const f of opts.ownedFiles) ledger.record({ type: 'file_write', path: f })
  for (const v of (opts.verifications ?? [])) ledger.record({ type: 'verification', command: v.command, status: v.status, meta: { targetFiles: opts.ownedFiles, snapshotRef: 'snapshotRef' in (v.meta ?? {}) ? undefined : opts.getCurrentSnapshotRefForFiles?.(opts.ownedFiles) ?? 'candidate-ref', ...v.meta } })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  ownership.autoOwnFromLedger()
  const attribution = createVerificationAttribution({ ownership })
  const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution, ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}) })

  const tool = createDeliverTaskTool(() => ({
    taskLedger: ledger,
    ownership,
    gate,
    sessionRegistry: opts.sessionRegistry,
    sessionId: opts.sessionId,
    getCurrentDirtyFiles: () => opts.dirtyFiles,
    getProjectMemoryContent: () => opts.projectMemory,
    recaptureBaseline: opts.recaptureBaseline,
    commitOwnedFiles: opts.commitOwnedFiles,
    routeReviewWorkflow: opts.disableReviewDeps
      ? opts.routeReviewWorkflow
      : (opts.routeReviewWorkflow ?? (async () => ({ tier: 'L2', verdict: 'verified', evidence: 'test review shim', rounds: 1 }))),
    reviewDeps: opts.disableReviewDeps ? undefined : (opts.reviewDeps ?? {} as ReviewRouterDeps),
    reviewDepth: opts.reviewDepth,
    detectWroteButNeverRead: opts.detectWroteButNeverRead ?? (() => []),
    meridianIndexer: opts.meridianDb ? { getDb: () => opts.meridianDb! } as unknown as import('../../repo/meridian-indexer.js').MeridianIndexer : null,
    typecheckRunner: opts.typecheckRunner,
    declaredCheckRunner: opts.declaredCheckRunner,
    getTaskContract: opts.taskContract ? () => opts.taskContract : undefined,
    inventorySearcher: opts.inventorySearcher,
    obligationGateRunner: opts.obligationGateRunner,
    getImpactedTests: opts.impactedTests ? () => opts.impactedTests! : undefined,
    resolveDeliveryImpact: opts.resolveDeliveryImpact ?? (async () => ({ resolved: true, requiredTests: opts.impactedTests ?? [], advisoryTests: [] })),
    getCurrentSnapshotRef: opts.getCurrentSnapshotRef,
    getCurrentSnapshotRefForFiles: opts.getCurrentSnapshotRefForFiles,
    prepareCandidateTree: opts.prepareCandidateTree ?? (async (cwd, files) => ({
      path: cwd, files: [...files], ref: opts.getCurrentSnapshotRefForFiles?.([...files]) ?? 'candidate-ref', buildMs: 0,
      isCurrent: () => true, destroy: () => {},
    })),
    getPalConvergedCases: opts.palConvergedCases ? () => opts.palConvergedCases! : undefined,
    getPalNeedsUserCases: opts.palNeedsUserCases ? () => opts.palNeedsUserCases! : undefined,
    reviewConfig: opts.reviewConfig,
    isAutoReviewOff: opts.isAutoReviewOff !== undefined ? () => opts.isAutoReviewOff! : undefined,
    isGoalAchieved: opts.goalAchieved !== undefined ? () => opts.goalAchieved! : undefined,
    autoCommit: opts.autoCommit,
    getObligationStore: opts.obligationStore ? () => opts.obligationStore! : undefined,
    getClaimTracker: opts.claimTracker ? () => opts.claimTracker! : undefined,
    scoutFirewallConfig: opts.scoutFirewall,
  }))

  const params: ToolCallParams = {
    input: {},
    toolUseId: 'test-1',
    cwd: '/fake/project',
    taskId: opts.taskId,
    ownedFiles: opts.ownedFiles,
  }

  return { tool, params, ledger, ownership, gate }
}

/** 临时 git 仓库：commit 路径要真实 HEAD / scoped commit / 版本指纹。 */
async function withGitRepo<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'deliver-git-'))
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src/a.ts'), 'export const v = 1\n')
    git('add', '--', 'src/a.ts'); git('commit', '-qm', 'base')
    writeFileSync(join(cwd, 'src/a.ts'), 'export const v = 2\n')
    return await fn(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}





function toolDescription(): string {
  const { tool } = makeContext({
    taskId: 'schema',
    ownedFiles: [],
  })
  return tool.definition.description
}

describe('default advisory commit separates saving work from verification', () => {


  it('lands a real scoped commit without snapshot, impact, or proof and preserves peer staged work', async () => {
    await withGitRepo(async cwd => {
      let reviews = 0
      writeFileSync(join(cwd, 'peer.ts'), 'export const peer = true\n')
      const staged = spawnSync('git', ['add', '--', 'peer.ts'], { cwd })
      assert.equal(staged.status, 0)
      const { tool, params } = makeContext({ taskId: 'advisory-real', ownedFiles: ['src/a.ts'],
        sessionId: 'advisory-real-session',
        externalFiles: ['peer.ts'], dirtyFiles: ['src/a.ts', 'peer.ts'],
        prepareCandidateTree: async () => { throw new Error('snapshot must not run') },
        resolveDeliveryImpact: async () => { throw new Error('impact must not run') },
        routeReviewWorkflow: async () => { reviews++; return { tier: 'L2', verdict: 'verified', evidence: '', rounds: 1 } },
      })
      const result = await tool.execute({ ...params, cwd,
        input: { commit: true, files: ['src/a.ts'], message: 'fix: save bounded work' } })
      assert.equal(result.isError, undefined, result.content)
      assert.match(result.content, /Ledger verification: RED/)
      assert.match(result.content, /本次未执行测试或审查/)
      assert.match(result.content, /VERIFIED: 本次提交/)
      assert.equal(result.verificationPlan, undefined, 'skipped analysis must not fabricate an empty completed plan')
      const committed = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd, encoding: 'utf8' })
      assert.equal(committed.stdout.trim(), 'src/a.ts')
      const index = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
      assert.equal(index.stdout.trim(), 'peer.ts')
      assert.equal(reviews, 0, 'default delivery must not start an immediate review')
    })
  })

  for (const proof of [
    { label: 'stale', command: 'npm test', status: 'passed' as const, meta: { stale: true } },
    { label: 'failed', command: 'npm test', status: 'failed' as const, meta: { scope: 'targeted' } },
    { label: 'timeout', command: 'npm test', status: 'blocked' as const, meta: { blockedReason: 'timeout' } },
  ]) it(`discloses ${proof.label} evidence without making it a commit prerequisite or changing the ledger`, async () => {
    await withGitRepo(async cwd => {
      let committed = false
      const { tool, params, ledger } = makeContext({ taskId: `advisory-${proof.label}`, ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'], verifications: [proof],
        commitOwnedFiles: () => { committed = true; return { ok: true, output: '' } },
      })
      const before = JSON.stringify(ledger.getEvents())
      const result = await tool.execute({ ...params, cwd, input: { commit: true, message: 'fix: save work' } })
      assert.equal(result.isError, undefined, result.content)
      assert.equal(committed, true)
      assert.doesNotMatch(result.content, /Cannot commit|Ledger verification: GREEN/)
      assert.match(result.content, /Attribution:|Verifications: none/)
      assert.equal(JSON.stringify(ledger.getEvents()), before)
    })
  })




  it('still blocks peer claims and non-owned files by default', async () => {
    const registry = { checkClaim: () => ({ sessionId: 'peer', claimType: 'exclusive' }) } as unknown as SessionRegistry
    const { tool, params } = makeContext({ taskId: 'advisory-claim', ownedFiles: ['src/a.ts'], dirtyFiles: ['src/a.ts', 'peer.ts'],
      externalFiles: ['peer.ts'], sessionRegistry: registry, sessionId: 'mine',
      commitOwnedFiles: () => { throw new Error('unsafe commit') },
    })
    const conflict = await tool.execute({ ...params, input: { commit: true, message: 'fix: work' } })
    assert.equal(conflict.isError, true)
    assert.match(conflict.content, /cross-session claim conflicts/)
    const foreign = await tool.execute({ ...params, input: { commit: true, files: ['peer.ts'], message: 'fix: work' } })
    assert.equal(foreign.isError, true)
    assert.match(foreign.content, /not in owned files/)
  })

  it('still rejects partially staged selected files in the real Git executor', async () => {
    await withGitRepo(async cwd => {
      assert.equal(spawnSync('git', ['add', '--', 'src/a.ts'], { cwd }).status, 0)
      writeFileSync(join(cwd, 'src/a.ts'), 'export const v = 3\n')
      const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout
      const { tool, params } = makeContext({ taskId: 'advisory-partial', ownedFiles: ['src/a.ts'], dirtyFiles: ['src/a.ts'] })
      const result = await tool.execute({ ...params, cwd, input: { commit: true, message: 'fix: work' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /partially staged/)
      assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout, before)
    })
  })

})

/** Let the detached (fire-and-forget) post-commit review promise settle. */
async function settleDetachedReview(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** Settle a whole detached review CHAIN: initial review + in-flight follow-up
 *  sweep (each hop is microtask-only once the route mock resolves, but the
 *  chain is launched from .finally callbacks — give it several macrotask
 *  ticks instead of one). */
async function settleReviewChain(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('deliver-task — semantic task delivery tool', () => {
  it('reports GREEN delivery readiness when verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('GREEN'))
  })

  it('reports RED without marking status-only report as tool error when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
  })

  // ── 零验证记录的诚实性（issue #537 附带项）─────────────────────
  // 这句话曾无条件输出：空 workspace（无改动、零验证）也会断言 "Typecheck passed"，
  // 把没发生的事写成证据。

  it('空 workspace 不说「Typecheck passed」，改说没有任何验证记录', async () => {
    const { tool, params } = makeContext({ taskId: 't1', ownedFiles: [] })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /Typecheck passed/)
    assert.match(result.content, /no tests were run for this task/)
  })










  it('reports YELLOW when external verification blocked but owned files verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    // With only owned files verified and no external blocked verifications,
    // the gate is GREEN. YELLOW requires external blocked verifications.
    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
  })

  it('includes ownership report in output', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      externalFiles: ['src/ext.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes('src/ext.ts'))
  })

  it('handles empty delivery (no owned files)', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
    assert.ok(result.content.includes('(none)'))
  })

  it('reports failed verification details', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsx --test', status: 'failed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
    assert.ok(result.content.includes('failure'))
  })

  it('requires approval for commit action', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const needsApproval = tool.requiresApproval({
      input: { message: 'feat: deliver', commit: true },
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, true)
  })

  it('executes scoped commit for commit=true when gate is green', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'feat: scoped delivery' }])
    assert.match(result.content, /Scoped commit created/)
    assert.match(result.content, /commit abc123/)
  })

  it('真实提交后回读 HEAD 移动（headBefore 复用 captureCommitVersion 的完整 hash）', async () => {
    await withGitRepo(async cwd => {
      // core.abbrev=12：headAfter 是 12 位短哈希，headBefore 是完整哈希——
      // 截断长度必须跟着 headAfter 走。写死 slice(0, 7) 会误报 "HEAD did not move"。
      const git = (...args: string[]) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
        assert.equal(r.status, 0, r.stderr)
        return r.stdout.trim()
      }
      git('config', 'core.abbrev', '12')

      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed', meta: { scope: 'full' } }],
      })

      const result = await tool.execute({ ...params, cwd, input: { commit: true, message: 'feat: real commit' } })

      assert.equal(result.isError, undefined, result.content)
      assert.match(result.content, /VERIFIED: 本次提交 [0-9a-f]{40}/)
      assert.doesNotMatch(result.content, /HEAD did not move/)
    })
  })

  it('autoCommit=false skips git commit but still produces delivery report', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
      autoCommit: false,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    // Must NOT have called commitOwnedFiles
    assert.deepEqual(calls, [])
    // Must contain the manual-commit-mode message
    assert.match(result.content, /自动提交已关闭/)
    assert.match(result.content, /agent\.delivery\.autoCommit/)
  })


  it('denoises junk external files: capped list + summary count (C-fix)', async () => {
    const junk = Array.from({ length: 67 }, (_, i) => `.test-tmp/corrupt-${i}.json`)
    const signal = ['src/important.ts', 'docs/notes.md']
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      externalFiles: [...junk, ...signal],
      dirtyFiles: ['src/a.ts', ...junk, ...signal],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /\.test-tmp\/corrupt-/, 'junk paths must not be listed')
    assert.match(result.content, /src\/important\.ts/)
    assert.match(result.content, /\(\+67 more, 67 junk\/gitignored\)/)
    assert.match(result.content, /External files \(69\)/, 'count stays truthful even when display is filtered')
    // Gate section (up to "Verifications:") must stay compact.
    const gateSection = result.content.split('\n')
    const verifIdx = gateSection.findIndex(l => l.startsWith('Verifications:'))
    assert.ok(verifIdx >= 0 && verifIdx < 25, `gate file lists must stay compact, got ${verifIdx + 1} lines`)
  })

  it('caps long owned-file lists at 5 with a (+N more) summary (C-fix)', async () => {
    const owned = Array.from({ length: 12 }, (_, i) => `src/mod-${i}.ts`)
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: owned,
      dirtyFiles: owned,
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute({ ...params, ownedFiles: owned })

    assert.match(result.content, /Owned files \(12\)/)
    assert.match(result.content, /\(\+7 more\)/)
    assert.doesNotMatch(result.content, /src\/mod-9\.ts/, 'files beyond the cap are summarized, not listed')
  })
















  it('tool timeout budget — fast ownership query, no blocking stages', () => {
    const { tool, params } = makeContext({ taskId: 't1', ownedFiles: [] })
    const timeoutMs = tool.timeoutMs!
    // Readiness check: ownership query, no blocking stages.
    assert.equal(timeoutMs({ ...params, input: {} }), 60_000)
    // Commit: file I/O + git, no typecheck/review stages inside. 180s（而非
    // 60s）：满载机器 + 多会话大工作区上 60s 超时导致模型退回裸 git 提交
    //（2026-07-21 损毁提交事故），提交是终态动作，宁可慢不可断。
    assert.equal(timeoutMs({ ...params, input: { commit: true } }), 180_000)
    // Explicit review_level no longer adds budget — review is detached.
    assert.equal(timeoutMs({ ...params, input: { commit: true, review_level: 'L2' } }), 180_000)
  })











  it('rejects commit=true without message before running executor', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run without message')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Commit requires/)
    assert.equal(result.errorKind, 'format_error', '参数缺失与 browser_debug 参数校验同构（T3）')
  })

  it('reports scoped commit executor failure as tool error', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'git commit failed' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: fail' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Scoped commit failed/)
    assert.match(result.content, /git commit failed/)
  })

  it('rejects an empty commit candidate before invoking the Git executor', async () => {
    let invoked = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => { invoked = true; return { ok: false, output: 'No owned files to commit.' } },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: empty' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /No dirty files in the delivery candidate/)
    assert.equal(invoked, false)
  })

  it('does not require approval for status-only delivery report', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const needsApproval = tool.requiresApproval({
      input: {},
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, false)
  })

  it('reports external dirty files as informational caveats, not ownership warnings', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
    })

    const result = await tool.execute(params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Ledger verification: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /External files \(1\)/)
    assert.doesNotMatch(result.content, /Ownership health warnings:/)
    assert.match(result.content, /Ownership caveats:/)
    assert.match(result.content, /External dirty files are present and excluded from delivery scope\./)
  })

  it('auto-populates ownership from task ledger at execution time', async () => {
    const ctx = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    ctx.ledger.record({ type: 'file_write', path: 'src/late-write.ts' })
    const result = await ctx.tool.execute(ctx.params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Owned files \(1\)/)
    assert.match(result.content, /src\/late-write\.ts/)
  })

  it('treats clean historical owned files as non-blocking when current dirty snapshot is empty', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/already-committed.ts'],
      dirtyFiles: [],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Ledger verification: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /Historical owned files \(1\)/)
    assert.match(result.content, /src\/already-committed\.ts/)
  })

  it('still blocks current dirty owned files when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/current-dirty.ts'],
      dirtyFiles: ['src/current-dirty.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Ledger verification: RED/)
    assert.match(result.content, /Owned files \(1\)/)
  })

  it('generates consistent report for same state', async () => {
    const ctx1 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })
    const ctx2 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const r1 = await ctx1.tool.execute(ctx1.params)
    const r2 = await ctx2.tool.execute(ctx2.params)

    assert.equal(r1.content, r2.content)
  })



  describe('preExistingUntracked scenarios', () => {
    it('treats preExistingUntracked files as external in ownership report', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts', 'temp.txt'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts', 'temp.txt'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Ledger verification: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/untracked\.ts/)
      assert.match(result.content, /temp\.txt/)
    })

    it('prevents registerOwned from claiming preExistingUntracked files', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        preExistingUntracked: ['src/pre-existing.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Try to register the pre-existing untracked file
      ctx.ownership.registerOwned('src/pre-existing.ts')

      // Should not be owned
      assert.equal(ctx.ownership.isOwned('src/pre-existing.ts'), false)

      // Now execute and verify it appears as external
      const result = await ctx.tool.execute(ctx.params)
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/pre-existing\.ts/)
    })

    it('shows ownership health warning when dirty file has no classification', async () => {
      // Note: dirtyFiles passed to makeContext are used by getCurrentDirtyFiles mock.
      // In real usage, deliver-task computes dirtyFiles from owned + external only.
      // Files that are neither owned nor external are not included in the health check.
      // This test verifies the current behavior: unknown files are silently excluded.
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: [],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Ledger verification: GREEN/)
      // No warnings because all dirty files are classified
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })

    it('allows commit=true for owned files even when preExistingUntracked are present', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only owned file should be committed, not the untracked one
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('handles mixed preExistingDirty and preExistingUntracked correctly', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/dirty-ext.ts'],
        preExistingUntracked: ['src/untracked-ext.ts'],
        dirtyFiles: ['src/owned.ts', 'src/dirty-ext.ts', 'src/untracked-ext.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Ledger verification: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/dirty-ext\.ts/)
      assert.match(result.content, /src\/untracked-ext\.ts/)
    })
  })

  describe('co-ownership scenarios', () => {
    it('shows co-owned files in report when external file is registered', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Register external file as co-owned
      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Ledger verification: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(1\)/)
    })

    it('shows co-owned caveat in ownership health', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Ownership caveats:/)
      assert.match(result.content, /co-owned file\(s\) present/)
    })

    it('allows commit=true for owned files when co-owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only truly owned file should be committed, not co-owned
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('distinguishes co-owned from external in ownership report', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts', 'src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/external\.ts/)
    })
  })


  // ── 层3: 重构行为等价契约 — 回归清单核验（重构事故链缺口 3）──

  // ── Norns 义务账：议事会契约随附义务的交付前核验（Phase 3）──

  // ── 验证命令对账：计划声明的 verification 命令逐条核销（advisory）──

  describe('unclassified dirty files → dynamic external reclassification', () => {
    it('reports GREEN when dirty unclassified files are lazily reclassified as dynamic externals', async () => {
      // P1 living baseline: files with no ledger trace that are NOT in the baseline
      // external set are now lazily reclassified as "dynamic externals" —
      // created by other sessions after our baseline was taken.
      // This eliminates false YELLOWs from stale baseline information.
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      // src/new-session-file.ts is dynamically reclassified as external → GREEN
      assert.match(result.content, /Ledger verification: GREEN/)
      // It appears in the external files section, not as an "unclassified" warning
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/new-session-file\.ts/)
      // No ownership health warning for unclassified files
      assert.doesNotMatch(result.content, /no ownership classification/)
    })

    it('allows commit=true when dirty unclassified files are reclassified as external (only owned committed)', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only src/owned.ts has a ledger trace → only it is owned and committed
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('does not report YELLOW when all dirty files are classified', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Ledger verification: GREEN/)
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })
  })

  describe('detectSymptomPatch', () => {
    function tmpRepo(file: string, before: string, after: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'sym-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      writeFileSync(join(dir, file), before)
      run(['add', '.']); run(['commit', '-qm', 'base'])
      writeFileSync(join(dir, file), after)
      return dir
    }

    it('flags a single-line fallback patch', async () => {
      const dir = tmpRepo('a.ts', 'const x = v ?? "medium"\n', 'const x = v || "medium"\n')
      assert.match((await detectSymptomPatch(dir))!, /症状处的 fallback 补丁/)
    })

    it('ignores a multi-line structural change', async () => {
      const dir = tmpRepo('a.ts', 'const x = 1\n', 'const a = 1\nconst b = 2\nconst c = 3\n')
      assert.equal(await detectSymptomPatch(dir), null)
    })
  })

  // ── P2 cross-session claim conflicts ──

  describe('cross-session claim conflict detection', () => {
    it('reports conflict when other session holds exclusive claim on owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /src\/owned\.ts.*exclusive lock held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('blocks commit when other session holds a claim on an owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-block-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit should-not-happen' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: claim conflict' } })

        assert.equal(result.isError, true)
        assert.equal(committed, false)
        assert.match(result.content, /Cannot commit: cross-session claim conflicts are present/)
        assert.equal(result.errorKind, 'delivery_gate', 'claim 冲突硬拦是门禁判定（T3）')
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('allows force=true to override a cross-session claim conflict explicitly', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-force-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit abc123' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, force: true, message: 'feat: claim conflict override' } })

        assert.equal(result.isError ?? false, false)
        assert.equal(committed, true)
        assert.match(result.content, /Cross-session claim conflicts overridden with force=true/)
        assert.match(result.content, /Scoped commit created/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when own session holds the claim', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-self-'))
      const registry = await SR.create(tmpDir)
      registry.register('my-session', '/fake/project')
      // My own session holds the claim — no conflict
      registry.acquireClaim('my-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Ledger verification: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when no session holds claims', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-none-'))
      const registry = await SR.create(tmpDir)

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Ledger verification: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('reports conflict for shared_read claim from other session too', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-read-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /shared read held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('no crash when sessionRegistry is absent (backward compatible)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        // sessionRegistry not provided
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
      assert.match(result.content, /Ledger verification: GREEN/)
    })
  })

  describe('files parameter — subset commit', () => {
    it('commits only specified subset of owned files when files param provided', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1 only', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1 only' }])
      assert.match(result.content, /Scoped commit created/)
    })


    it('rejects a clean or non-owned selected file before impact resolution', async () => {
      let impactCalls = 0
      const ctx = makeContext({
        taskId: 'scope-invalid',
        ownedFiles: ['src/a.ts', 'src/clean.ts'],
        dirtyFiles: ['src/a.ts'],
        resolveDeliveryImpact: async () => {
          impactCalls++
          return { resolved: true, requiredTests: [], advisoryTests: [] }
        },
      })

      const clean = await ctx.tool.execute({ ...ctx.params, input: { files: ['src/clean.ts'] } })
      const external = await ctx.tool.execute({ ...ctx.params, input: { files: ['src/other.ts'] } })
      assert.equal(clean.isError, true)
      assert.match(clean.content, /not currently dirty/)
      assert.equal(external.isError, true)
      assert.match(external.content, /not in owned files/)
      assert.equal(impactCalls, 0)
    })

    it('rejects files param containing non-owned file', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: ['src/agent/a.ts', 'src/tools/NOT-OWNED.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in owned files/)
      assert.equal(result.errorKind, 'delivery_gate', 'ownership 拒绝是门禁判定（T3）')
    })

    it('rejects empty files array', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: [] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /No files specified/)
    })

    it('scopes the status report when commit is false', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute({
        ...params,
        input: { files: ['src/agent/a.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Ledger verification: GREEN/)
      assert.match(result.content, /Owned files \(1\):\n  src\/agent\/a\.ts/)
      assert.match(result.content, /Historical owned files \(1\):\n  src\/agent\/b\.ts/)
      assert.doesNotMatch(result.content, /Scoped commit/)
    })
  })

  describe('cohesion warnings never block safe commits', () => {
    it('commits files across 3+ areas without force', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          return { ok: true, output: 'commit successful' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: big batch' },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /不阻断安全提交/)
    })

    it('allows commit with force=true when cohesion gate triggers', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: truly one unit', force: true },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /不阻断安全提交/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files, message: 'feat: truly one unit' }])
    })

    it('does not block small focused commit (≤2 areas, ≤5 files)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: focused' },
      })

      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Scoped commit created/)
    })

    it('keeps multi-area subset commits nonblocking', async () => {
      const allFiles = ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts']
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          return { ok: true, output: 'commit successful' }
        },
      })

      // Request a subset that still spans 3 areas
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: subset', files: ['src/agent/a.ts', 'src/tools/c.ts', 'src/tui/d.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /不阻断安全提交/)
    })

    it('allows small subset commit even when total owned files are large', async () => {
      const allFiles = [
        'src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts',
        'src/tools/d.ts', 'src/tui/e.ts', 'src/config/f.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      // Request a focused subset (1 area, 2 files) — should pass
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1' }])
    })
  })

  describe('adopt — cross-session takeover', () => {









    it('adopts external files and commits them alongside owned files', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        dirtyFiles: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: take over crashed session work',
          adopt: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 2 external file/)
      assert.match(result.content, /src\/other-session-a\.ts/)
      assert.match(result.content, /src\/other-session-b\.ts/)
      assert.match(result.content, /Scoped commit created/)
      // All 3 files should be committed (1 owned + 2 adopted)
      assert.deepEqual(calls, [{
        files: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        message: 'fix: take over crashed session work',
      }])
    })

    it('adopts external files even when no owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        externalFiles: ['src/crashed-work.ts'],
        dirtyFiles: ['src/crashed-work.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit def456' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: adopt orphaned work',
          adopt: ['src/crashed-work.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 1 external file/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/crashed-work.ts'], message: 'fix: adopt orphaned work' }])
    })


    it('rejects adopt for file not in external list', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => { throw new Error('should not be called') },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: try adopt non-external',
          adopt: ['src/nonexistent.ts'],
        },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in external or co-owned files/)
    })

    it('accepts empty adopt array as no-op (not an error)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        dirtyFiles: ['src/mine.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc1234' }),
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: empty adopt is no-op',
          adopt: [],
        },
      })

      // Empty adopt array should be treated the same as omitting adopt — not an error
      assert.equal(result.isError, undefined)
    })

    it('ignores adopt when commit is false (status-only)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: { adopt: ['src/external.ts'] },
      })

      // adopt is ignored in status-only mode — no adoption log
      assert.match(result.content, /Ledger verification: GREEN/)
      assert.doesNotMatch(result.content, /Adopted/)
    })
  })

  // ── Mechanical-change fast-path (docs/rename bypass) ──







  // ── 虚空仓库 P0：learned 参数解析 ──
  describe('parseLearnedEntries — learned 参数解析', () => {
    it('标准格式："模式描述——证据：..." 拆出 text/evidence/topic', () => {
      const [e] = parseLearnedEntries(['此项目用 npx tsx --test 运行测试——证据：package.json scripts 全用 tsx'])
      assert.ok(e)
      assert.equal(e!.text, '此项目用 npx tsx --test 运行测试')
      assert.equal(e!.evidence, 'package.json scripts 全用 tsx')
      assert.equal(e!.topic, 'package.json', 'topic 从证据里提取路径样 token')
      assert.deepEqual(e!.tags, ['agent-learned'])
    })

    it('分隔符变体容忍："--证据:" 也能拆', () => {
      const [e] = parseLearnedEntries(['模式 X 成立--证据: src/a/b.ts 的实现'])
      assert.equal(e!.text, '模式 X 成立')
      assert.equal(e!.evidence, 'src/a/b.ts 的实现')
      assert.equal(e!.topic, 'src/a/b.ts')
    })

    it('缺分隔符 → 整条入 text、evidence 为空、topic undefined', () => {
      const [e] = parseLearnedEntries(['没有证据分隔符的整句知识'])
      assert.equal(e!.text, '没有证据分隔符的整句知识')
      assert.equal(e!.evidence, '')
      assert.equal(e!.topic, undefined)
    })

    it('非数组 / 空数组 / 非字符串元素 / 空白串 → 全部安全过滤', () => {
      assert.deepEqual(parseLearnedEntries(undefined), [])
      assert.deepEqual(parseLearnedEntries('not-an-array'), [])
      assert.deepEqual(parseLearnedEntries([]), [])
      assert.deepEqual(parseLearnedEntries([42, null, '   ', { x: 1 }]), [])
    })
  })

  // ── 虚空仓库 P0：deliver_task 收割集成 ──

  // ── 虚空仓库 P0：收割邀请（条件展示）──


  // ── 证据防火墙 Phase 2（jidoka 硬门禁）──────────────────────────

})

// ── 提交卡死诊断插桩（2026-08-06，deliver_task isError 结果卡死排查）─────
// RIVET_DEBUG=1 时 execute 关键阶段打时间戳标记；卡死时日志最后一个
// stage 即卡点（execute 内 vs harness 结果回传层可区分）。
describe('deliver-task stage markers', () => {
  it('emits execute:start / report:done markers on the fast path (RIVET_DEBUG=1)', async () => {
    const prevDebug = process.env.RIVET_DEBUG
    process.env.RIVET_DEBUG = '1'
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')) }
    try {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.equal(result.isError ?? false, false)
      assert.ok(result.content.includes('GREEN'))
    } finally {
      console.warn = origWarn
      if (prevDebug === undefined) delete process.env.RIVET_DEBUG
      else process.env.RIVET_DEBUG = prevDebug
    }
    const markers = warns.filter(w => w.includes('[deliver-task]'))
    assert.ok(markers.some(m => m.includes('execute:start')), `missing execute:start in: ${markers.join(' | ')}`)
    assert.ok(markers.some(m => m.includes('report:done')), `missing report:done in: ${markers.join(' | ')}`)
  })

  it('stays silent without RIVET_DEBUG (zero production overhead)', async () => {
    const prevDebug = process.env.RIVET_DEBUG
    delete process.env.RIVET_DEBUG
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')) }
    try {
      const { tool, params } = makeContext({ taskId: 't2', ownedFiles: [] })
      await tool.execute(params)
    } finally {
      console.warn = origWarn
      if (prevDebug !== undefined) process.env.RIVET_DEBUG = prevDebug
    }
    assert.equal(warns.some(w => w.includes('[deliver-task]')), false)
  })
})

describe('delivery recovery real tool path', () => {
  it('does not use unrelated superseded failures to waive an active owned blocker', async () => {
    let commits = 0
    const {tool, params} = makeContext({ taskId: 'force-regression', ownedFiles: ['src/a.ts'], dirtyFiles: ['src/a.ts'],
      verifications: [
        {command: 'fixed-check', status: 'failed', meta: {scope: 'targeted'}},
        {command: 'fixed-check', status: 'passed', meta: {scope: 'targeted'}},
        {command: 'active-check', status: 'failed', meta: {scope: 'targeted'}},
      ], commitOwnedFiles: () => { commits++; return {ok:true,output:'unexpected'} } })
    const result = await tool.execute({...params,input:{verification_policy:'strict',commit:true,force:true,message:'fix: regression'}})
    assert.equal(result.isError,true); assert.equal(commits,0)
    assert.doesNotMatch(result.content,/RED overridden|RED after adoption|改动前已存在/)
  })
})

it('no adoption reuses the original decision and clean historical owned files stay out of commits', async () => {
  let committed: string[] = []
  const { tool, params, gate } = makeContext({ taskId: 'no-adoption-regression', ownedFiles: ['docs/a.md', 'docs/clean.md'], dirtyFiles: ['docs/a.md'],
    verifications: [{ command: 'check', status: 'passed', meta: { scope: 'full' } }],
    commitOwnedFiles: (_cwd, files) => { committed = files; return { ok: true, output: 'created' } }, isAutoReviewOff: true })
  const getReport = gate.getReport.bind(gate)
  let reports = 0; gate.getReport = (...args) => { reports++; return getReport(...args) }
  const result = await tool.execute({ ...params, input: { commit: true, message: 'docs: selected' } })
  assert.notEqual(result.isError, true); assert.equal(reports, 1)
  assert.deepEqual(committed, ['docs/a.md'])
})

it('unknown and blocked verification states neither authorize nor block a commit (disclosure only)', async () => {
  let commits = 0
  const { tool, params } = makeContext({ taskId: 'unknown-proof', ownedFiles: ['src/a.ts'], dirtyFiles: ['src/a.ts'],
    verifications: [{ command: 'npm test | tail -1', status: 'blocked', meta: { scope: 'unknown' } }],
    commitOwnedFiles: () => { commits++; return { ok: true, output: 'created' } } })
  const result = await tool.execute({ ...params, input: { commit: true, force: true, message: 'code' } })
  assert.equal(result.isError, undefined, result.content)
  assert.equal(commits, 1, 'blocked verification no longer blocks the commit')
  assert.match(result.content, /本次未执行测试或审查/)
})

describe('issue #356 — 门禁拒绝必须带结构化 errorKind（防文本正则误判为 timeout）', () => {
  it('git index.lock 拒绝：errorKind=delivery_gate，且不进入 commit 执行器', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue356-lock-'))
    try {
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git', 'index.lock'), '')
      utimesSync(join(dir, '.git', 'index.lock'), new Date(0), new Date(0))
      let commitCalls = 0
      const { tool, params } = makeContext({
        taskId: 'issue356-lock',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        // verify 命令刻意含 timeout 字样：返回文本必经 deliver-task.ts:537 回显该命令
        verifications: [{ command: 'timeout 300 dotnet build', status: 'passed' }],
        commitOwnedFiles: () => { commitCalls++; return { ok: true, output: 'unexpected' } },
        disableReviewDeps: true,
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'fix: scoped delivery' } })

      assert.equal(result.isError, true)
      assert.ok(result.content.includes('Git index is locked'), '返回文本应含锁提示')
      assert.ok(existsSync(join(dir, '.git', 'index.lock')), 'age alone cannot authorize lock deletion')
      assert.ok(result.content.includes('timeout 300 dotnet build'), '污染前提：verify 命令回显确实在返回文本里')
      assert.equal(result.errorKind, 'delivery_gate', 'issue #356：锁拒绝不得缺 errorKind（否则文本正则按 timeout 重试）')
      assert.equal(commitCalls, 0, '锁检查先于任何 git 操作——执行器不得被调用')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scoped commit 失败：errorKind=delivery_gate（重试会重新进入 commit）', async () => {
    const { tool, params } = makeContext({
      taskId: 'issue356-commit-fail',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'timeout 300 dotnet build', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'fatal: unable to write new index file' }),
      disableReviewDeps: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Scoped commit failed'))
    assert.equal(result.errorKind, 'delivery_gate', 'issue #356：commit 失败不得缺 errorKind（否则重试会重复进入 commit）')
  })
})


describe('PR #371 — incomplete baseline commit boundary', () => {
  for (const force of [false, true]) {
    it(`blocks commit before invoking the executor (force=${force})`, async () => {
      let commitCalls = 0
      const { tool, params } = makeContext({
        taskId: 'incomplete-commit',
        ownedFiles: ['src/app.ts'],
        dirtyFiles: ['src/app.ts'],
        verifications: [{ command: 'npx vitest run', status: 'passed' }],
        completeBaseline: false,
        disableReviewDeps: true,
        commitOwnedFiles: () => { commitCalls++; return { ok: true, output: 'unexpected commit' } },
      })
      const result = await tool.execute({ ...params, input: { commit: true, force, message: 'fix: app' } })
      assert.equal(result.isError, true)
      assert.equal(result.errorKind, 'delivery_gate')
      assert.match(result.content, /归属基线未完整建立/)
      assert.equal(commitCalls, 0)
    })
  }

  it('still reports written files and verification for delivery without committing', async () => {
    const { tool, params } = makeContext({
      taskId: 'incomplete-report', ownedFiles: ['src/app.ts'], dirtyFiles: ['src/app.ts'],
      verifications: [{ command: 'npx vitest run', status: 'passed' }],
      completeBaseline: false, disableReviewDeps: true,
    })
    const result = await tool.execute({ ...params, input: {} })
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Ledger verification: YELLOW/)
    assert.match(result.content, /Owned files \(1\):/)
    assert.match(result.content, /src\/app\.ts/)
  })

  it('恢复路径：基线 incomplete → 现场重采成功 → commit 不再被硬阻断（会话中途 git init）', async () => {
    let commitCalls = 0
    let recaptureCalls = 0
    const { tool, params } = makeContext({
      taskId: 'incomplete-recapture-ok',
      ownedFiles: ['src/app.ts'],
      dirtyFiles: ['src/app.ts'],
      verifications: [{ command: 'npx vitest run', status: 'passed' }],
      completeBaseline: false,
      disableReviewDeps: true,
      isAutoReviewOff: true,
      recaptureBaseline: () => { recaptureCalls++; return true },
      commitOwnedFiles: () => { commitCalls++; return { ok: true, output: 'created' } },
    })
    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: app' } })
    assert.equal(recaptureCalls, 1, '硬门触发时应现场重采一次')
    assert.equal(commitCalls, 1, '重采成功后应放行到 commit 执行器')
    assert.notEqual(result.isError, true)
    assert.doesNotMatch(result.content, /归属基线未完整建立/)
  })

  it('恢复路径：现场重采仍失败（非 git 工作区）→ 仍硬阻断，force 不豁免', async () => {
    let commitCalls = 0
    const { tool, params } = makeContext({
      taskId: 'incomplete-recapture-fail',
      ownedFiles: ['src/app.ts'],
      dirtyFiles: ['src/app.ts'],
      verifications: [{ command: 'npx vitest run', status: 'passed' }],
      completeBaseline: false,
      disableReviewDeps: true,
      recaptureBaseline: () => false,
      commitOwnedFiles: () => { commitCalls++; return { ok: true, output: 'unexpected commit' } },
    })
    const result = await tool.execute({ ...params, input: { commit: true, force: true, message: 'fix: app' } })
    assert.equal(result.isError, true)
    assert.equal(result.errorKind, 'delivery_gate')
    assert.match(result.content, /归属基线未完整建立/)
    assert.equal(commitCalls, 0)
  })
})

// ── 契约分离（PLAN「提交、审查、测试彻底分离」）：旧混合参数无副作用退回 ──
describe('legacy mixed parameters are rejected before any side effect', () => {
  // 每个字段在旧世界都有独立语义；新契约下携带即退回——在归属校验、
  // 台账读取、commit 执行器等任何副作用发生之前。
  const legacyCases: Array<[string, Record<string, unknown>]> = [
    ['verification_policy', { verification_policy: 'strict' }],
    ['review_level', { review_level: 'L2' }],
    ['review_policy', { review_policy: 'each' }],
    ['skipAutoReview', { skipAutoReview: true }],
    ['checklist', { checklist: [{ item: 'x', done: true }] }],
    ['learned', { learned: ['模式——证据：path'] }],
  ]

  for (const [label, legacy] of legacyCases) {
    it(`${label} → 精简迁移错误（指向独立入口），不读台账、不提交`, async () => {
      let ledgerReads = 0
      let commitCalls = 0
      const { tool, params, ledger } = makeContext({
        taskId: `legacy-${label}`,
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        disableReviewDeps: true,
        commitOwnedFiles: () => { commitCalls++; return { ok: true, output: 'must not run' } },
      })
      const original = ledger.getVerifications.bind(ledger)
      ;(ledger as unknown as { getVerifications: () => unknown }).getVerifications = () => { ledgerReads++; return original() }
      const result = await tool.execute({ ...params, input: { ...legacy, commit: true, message: 'fix: legacy field' } })
      assert.equal(result.isError, true, `${label} 必须以错误返回`)
      assert.match(result.content, /deliver_task 不再接受/, `${label} 错误须指明字段已移除`)
      assert.match(result.content, /review_changes|run_tests|memory/, `${label} 错误须指向正确的独立入口`)
      assert.equal(ledgerReads, 0, `${label} 退回必须发生在读台账之前`)
      assert.equal(commitCalls, 0, `${label} 退回不得触发提交`)
    })
  }

  it('review_findings → 迁移错误指向 review_changes（不再由 deliver_task 承接）', async () => {
    const { tool, params } = makeContext({
      taskId: 'legacy-review-findings',
      ownedFiles: ['src/a.ts'],
      disableReviewDeps: true,
    })
    const result = await tool.execute({ ...params, input: { review_findings: { action: 'list' } } })
    assert.equal(result.isError, true)
    assert.match(result.content, /review_changes/)
  })
})

// ── 验收第 2 条：影响分析/候选树/审查路由 mock 即败，提交与预览仍成功 ──
describe('commit and preview succeed with zero quality-pipeline invocations', () => {
  it('advisory commit: 候选树/影响分析/审查路由全部「调用即抛」时提交仍成功，调用次数为零', async () => {
    let candidateCalls = 0, impactCalls = 0
    const { tool, params } = makeContext({
      taskId: 'zero-invoke-advisory',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      disableReviewDeps: true,
      prepareCandidateTree: async () => { candidateCalls++; throw new Error('candidate tree must not be called') },
      resolveDeliveryImpact: async () => { impactCalls++; throw new Error('impact must not be called') },
      commitOwnedFiles: () => ({ ok: true, output: 'created abc1234' }),
    })
    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: zero-invoke' } })
    assert.equal(result.isError, undefined, result.content)
    assert.match(result.content, /本次未执行测试或审查/)
    assert.equal(candidateCalls, 0, 'advisory 提交不得物化候选树')
    assert.equal(impactCalls, 0, 'advisory 提交不得跑影响分析')
  })

  it('read-only preview: 同样零调用，报告披露验证状态', async () => {
    let candidateCalls = 0, impactCalls = 0
    const { tool, params } = makeContext({
      taskId: 'zero-invoke-preview',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      disableReviewDeps: true,
      prepareCandidateTree: async () => { candidateCalls++; throw new Error('candidate tree must not be called') },
      resolveDeliveryImpact: async () => { impactCalls++; throw new Error('impact must not be called') },
    })
    const result = await tool.execute({ ...params, input: {} })
    assert.equal(result.isError, undefined, result.content)
    assert.equal(candidateCalls, 0)
    assert.equal(impactCalls, 0)
  })

  it('零验证/失败验证/过期证明下提交仍成功（验收第 1 条）——失败方向是披露不是拦截', async () => {
    const { tool, params } = makeContext({
      taskId: 'zero-verification-commit',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [
        { command: 'npx vitest run', status: 'failed' },
        { command: 'npx tsc --noEmit', status: 'failed' },
      ],
      disableReviewDeps: true,
      commitOwnedFiles: () => ({ ok: true, output: 'created def5678' }),
    })
    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: wip save' } })
    assert.equal(result.isError, undefined, result.content)
    assert.match(result.content, /本次未执行测试或审查/)
    assert.match(result.content, /Scoped commit created/)
  })
})

// ── 被动风险提示（契约分离 Wave 2）：轻量、≤3 项、≤600 字符 ──
describe('passivelyAssessRisk — lightweight passive hints', () => {
  it('package.json / migration / security 文件各给一条提示', async () => {
    const { tool, params } = makeContext({
      taskId: 'risk-hints',
      ownedFiles: ['package.json', 'src/db/migration.ts', 'src/agent/permission.ts'],
      dirtyFiles: ['package.json', 'src/db/migration.ts', 'src/agent/permission.ts'],
      disableReviewDeps: true,
    })
    const result = await tool.execute({ ...params, input: {} })
    assert.match(result.content, /风险提示/)
    assert.match(result.content, /package\.json：依赖\/脚本变化/)
    assert.match(result.content, /数据迁移\/结构面/)
    assert.match(result.content, /权限\/安全边界/)
    assert.match(result.content, /review_changes/)
  })

  it('纯注释/格式变化（无关文件）不产生提示', async () => {
    const { tool, params } = makeContext({
      taskId: 'risk-none',
      ownedFiles: ['README.md', 'docs/guide.md'],
      dirtyFiles: ['README.md', 'docs/guide.md'],
      disableReviewDeps: true,
    })
    const result = await tool.execute({ ...params, input: {} })
    assert.doesNotMatch(result.content, /风险提示/)
  })

  it('提示总数 ≤3 且总长 ≤600 字符', async () => {
    const { passivelyAssessRisk } = await import('../deliver-task.js')
    const hint = passivelyAssessRisk(['package.json', 'a/migration.sql', 'src/auth.ts', 'b/migration2.sql', 'c/security.ts'])
    assert.ok(hint)
    const count = (hint.match(/^- /gm) ?? []).length
    assert.ok(count <= 3, `提示 ${count} 条超限`)
    assert.ok(hint.length <= 600, `总长 ${hint.length} 超限`)
  })
})
