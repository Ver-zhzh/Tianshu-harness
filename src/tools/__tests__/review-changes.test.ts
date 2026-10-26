import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createReviewChangesTool, resolveReviewSnapshot, type ReviewChangesContext } from '../review-changes.js'
import { createReviewInbox, type ReviewInbox } from '../../agent/review-inbox.js'
import type { ChangeSet } from '../../agent/review-discipline.js'
import type { ReviewOutcome, ReviewRouterDeps, ReviewRouterOptions } from '../../agent/review-router.js'
import type { ToolCallParams } from '../types.js'

/** 真实 git 仓库夹具。 */
function gitRepo(): { cwd: string; head: () => string; dispose: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'review-changes-'))
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1\n')
  git('add', '--', 'src/a.ts'); git('commit', '-qm', 'base')
  return { cwd, head: () => git('rev-parse', 'HEAD'), dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}

function makeContext(overrides: Partial<ReviewChangesContext> & { cwd: string; sessionId: string }): ReviewChangesContext {
  return {
    ownedDirtyFiles: () => [],
    lastCommitRef: () => undefined,
    ...overrides,
  }
}

function params(input: Record<string, unknown>, cwd: string): ToolCallParams {
  return { input, toolUseId: 't-review', cwd, taskId: 'task-review' }
}

describe('review_changes — snapshot resolution', async () => {
  it('files 参数优先：固定 dirty-diff 快照', async () => {
    const ctx = makeContext({ cwd: '/repo', sessionId: 's1', ownedDirtyFiles: () => ['src/a.ts'] })
    const snap = await resolveReviewSnapshot(params({ files: ['src/x.ts'] }, '/repo'), ctx)
    assert.ok(!('choose' in snap) && snap.kind === 'dirty-diff')
    assert.deepEqual(snap.files, ['src/x.ts'])
  })

  it('无显式对象：已归属 dirty diff 次之', async () => {
    const ctx = makeContext({ cwd: '/repo', sessionId: 's1', ownedDirtyFiles: () => ['src/a.ts', 'src/b.ts'] })
    const snap = await resolveReviewSnapshot(params({}, '/repo'), ctx)
    assert.ok(!('choose' in snap) && snap.kind === 'dirty-diff')
    assert.deepEqual(snap.files, ['src/a.ts', 'src/b.ts'])
  })

  it('无 dirty → 本会话最近提交；两者皆无 → 展示选择，不偷换 HEAD', async () => {
    const withCommit = makeContext({ cwd: '/repo', sessionId: 's1', lastCommitRef: () => 'abc1234' })
    const snap = await resolveReviewSnapshot(params({}, '/repo'), withCommit)
    assert.ok(!('choose' in snap) && snap.kind === 'commit' && snap.headRef === 'abc1234')

    const empty = makeContext({ cwd: '/repo', sessionId: 's1' })
    const choice = await resolveReviewSnapshot(params({}, '/repo'), empty)
    assert.ok('choose' in choice, '无确定对象必须要求选择，不得静默审查其他会话的 HEAD')
  })

  it('range 参数解析 A..B', async () => {
    const ctx = makeContext({ cwd: '/repo', sessionId: 's1' })
    const snap = await resolveReviewSnapshot(params({ range: 'main..feature' }, '/repo'), ctx)
    assert.ok(!('choose' in snap) && snap.kind === 'range')
    assert.equal(snap.baseRef, 'main'); assert.equal(snap.headRef, 'feature')
  })
})

describe('review_changes — 只读审查边界（验收第 4 条）', () => {
  it('formats and persists a routed finding; readonly boundaries are covered by the real-chain integration test', async () => {
    const repo = gitRepo()
    try {
      let routeCalls = 0
      const ctx = makeContext({
        cwd: repo.cwd, sessionId: 'owner-readonly',
        ownedDirtyFiles: () => ['src/a.ts'],
        reviewDeps: {} as ReviewRouterDeps,
        route: async (change: ChangeSet) => {
          routeCalls++
          return { tier: 'L2', verdict: 'rejected', rounds: 1, evidence: 'line 1: off-by-one',
            findings: [{ claim: '边界缺陷', evidence: 'src/a.ts:1', severity: 'HIGH', polarity: 'defect' }] } as ReviewOutcome
        },
        createInbox: ((cwd: string, sessionId: string) => createReviewInbox(cwd, sessionId, { file: join(cwd, '.inbox-test.json') })) as typeof createReviewInbox,
      })
      const tool = createReviewChangesTool(() => ctx)
      const result = await tool.execute(params({ action: 'start' }, repo.cwd))
      assert.equal(routeCalls, 1, '只读审查恰好一次 route 调用')
      assert.match(result.content, /独立审查启动/)
      assert.match(result.content, /固定快照/)
      assert.match(result.content, /不执行测试/)
      // 发现已持久化
      const inbox = ctx.createInbox!(repo.cwd, 'owner-readonly')
      const tasks = inbox.list()
      assert.equal(tasks.length, 1)
      assert.match(tasks[0]!.claim, /边界缺陷/)
    } finally { repo.dispose() }
  })

  it('verified 结论表述「代码审查未发现问题」，不表述「测试已通过」', async () => {
    const repo = gitRepo()
    try {
      const ctx = makeContext({
        cwd: repo.cwd, sessionId: 'owner-clean',
        ownedDirtyFiles: () => ['src/a.ts'],
        reviewDeps: {} as ReviewRouterDeps,
        route: async () => ({ tier: 'L2', verdict: 'verified', rounds: 1, evidence: 'clean' }),
        createInbox: ((cwd: string, sessionId: string) => createReviewInbox(cwd, sessionId, { file: join(cwd, '.inbox-test2.json') })) as typeof createReviewInbox,
      })
      const tool = createReviewChangesTool(() => ctx)
      const result = await tool.execute(params({ action: 'start' }, repo.cwd))
      assert.match(result.content, /代码审查未发现问题/)
      assert.doesNotMatch(result.content, /^测试已通过$/m)
      assert.match(result.content, /≠「测试已通过」/)
    } finally { repo.dispose() }
  })

  it('审查依赖不可用 → advisory 失败（errorKind=review_unavailable），不是崩溃', async () => {
    const repo = gitRepo()
    try {
      const ctx = makeContext({ cwd: repo.cwd, sessionId: 's-no-deps', ownedDirtyFiles: () => ['src/a.ts'] })
      const tool = createReviewChangesTool(() => ctx)
      const result = await tool.execute(params({ action: 'start' }, repo.cwd))
      assert.equal(result.isError, true)
      assert.equal(result.errorKind, 'runtime_gate')
    } finally { repo.dispose() }
  })
})

describe('review_changes — list / update 持久化（验收第 7 条）', () => {
  it('list 空态与发现展示；update confirmed 需原因与证据', async () => {
    const repo = gitRepo()
    try {
      const inboxFile = join(repo.cwd, '.inbox-lu.json')
      const ctx = makeContext({
        cwd: repo.cwd, sessionId: 'owner-lu',
        ownedDirtyFiles: () => ['src/a.ts'],
        reviewDeps: {} as ReviewRouterDeps,
        route: async () => ({ tier: 'L2', verdict: 'rejected', rounds: 1, evidence: 'e',
          findings: [{ claim: '问题A', evidence: 'f:1', polarity: 'defect' }] }),
        createInbox: ((cwd: string, sessionId: string) => createReviewInbox(cwd, sessionId, { file: inboxFile })) as typeof createReviewInbox,
      })
      const tool = createReviewChangesTool(() => ctx)
      const empty = await tool.execute(params({ action: 'list' }, repo.cwd))
      assert.match(empty.content, /没有未核销的审查发现/)
      await tool.execute(params({ action: 'start' }, repo.cwd))
      const listed = await tool.execute(params({ action: 'list' }, repo.cwd))
      assert.match(listed.content, /问题A/)
      const inbox = ctx.createInbox!(repo.cwd, 'owner-lu')
      const [task] = inbox.list()
      const confirmed = await tool.execute(params({ action: 'update', id: task!.id, state: 'confirmed', reason: '核实成立', evidence: 'src/a.ts:1 复现' }, repo.cwd))
      assert.match(confirmed.content, /confirmed/)
      // 无证据 update 被拒
      const bad = await tool.execute(params({ action: 'update', id: task!.id, state: 'rejected', reason: '', evidence: '' }, repo.cwd))
      assert.equal(bad.isError, true)
    } finally { repo.dispose() }
  })

  it('applied 状态：补丁已应用未提交，不冒充 fixed', async () => {
    const repo = gitRepo()
    try {
      const inboxFile = join(repo.cwd, '.inbox-applied.json')
      const ctx = makeContext({
        cwd: repo.cwd, sessionId: 'owner-applied',
        ownedDirtyFiles: () => ['src/a.ts'],
        reviewDeps: {} as ReviewRouterDeps,
        route: async () => ({ tier: 'L2', verdict: 'rejected', rounds: 1, evidence: 'e',
          findings: [{ claim: '问题B', evidence: 'f:2', polarity: 'defect' }] }),
        createInbox: ((cwd: string, sessionId: string) => createReviewInbox(cwd, sessionId, { file: inboxFile })) as typeof createReviewInbox,
      })
      const tool = createReviewChangesTool(() => ctx)
      await tool.execute(params({ action: 'start' }, repo.cwd))
      const inbox = ctx.createInbox!(repo.cwd, 'owner-applied')
      const [task] = inbox.list()
      const applied = await tool.execute(params({ action: 'update', id: task!.id, state: 'applied', reason: '补丁已打', evidence: 'diff 应用后待提交' }, repo.cwd))
      assert.match(applied.content, /applied/)
      assert.equal(inbox.list()[0]!.state, 'applied')
      assert.equal(inbox.list()[0]!.verification, 'not_run')
    } finally { repo.dispose() }
  })
})

describe('review_changes — 旧 followupClaimed 数据兼容（验收第 7 条）', () => {
  it('含 followupClaimed 的旧格式收件箱可正常读取，字段不再驱动执行', async () => {
    const repo = gitRepo()
    try {
      const inboxFile = join(repo.cwd, '.inbox-legacy.json')
      // 手写旧格式（followupClaimed: true）
      mkdirSync(join(inboxFile, '..'), { recursive: true })
      writeFileSync(inboxFile, JSON.stringify({
        version: 1, sessionId: 'owner-legacy',
        reviews: [{ id: 'old-review', followupClaimed: true }],
        findings: [{ id: 'oldf1', reviewId: 'old-review', commitRef: 'abc', files: ['src/a.ts'],
          claim: '旧发现', evidence: 'e', state: 'pending', createdAt: 1, updatedAt: 1, history: [] }],
      }))
      const ctx = makeContext({
        cwd: repo.cwd, sessionId: 'owner-legacy',
        createInbox: ((cwd: string, sessionId: string) => createReviewInbox(cwd, sessionId, { file: inboxFile })) as typeof createReviewInbox,
      })
      const tool = createReviewChangesTool(() => ctx)
      const listed = await tool.execute(params({ action: 'list' }, repo.cwd))
      assert.match(listed.content, /旧发现/, '旧格式收件箱数据可恢复展示')
    } finally { repo.dispose() }
  })
})
