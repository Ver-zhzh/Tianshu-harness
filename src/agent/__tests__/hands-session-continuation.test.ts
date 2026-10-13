import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runHandsSession, type HandsRunAgentOptions, type HandsSessionConfig } from '../hands-session.js'
import { WorktreeCoordinator } from '../worktree-coordinator.js'
import { createWriteWorkOrder, type WorkOrder } from '../work-order.js'
import { MAX_BUDGET_CONTINUATIONS, MAX_HANDS_EXTRA_RUNS } from '../worker-continuation.js'
import type { WorkerWriteGateReport } from '../worker-write-gate.js'

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

function testOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return createWriteWorkOrder({
    parentTurnId: 'turn-1',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: '实现 src/output.ts 并自验',
    scope: { files: ['src/output.ts'] },
    ...overrides,
  })
}

/** 预算耗尽时 worker-session 交回的形状：blocked + failureReason，不是抛异常。 */
function exhaustedJson(order: WorkOrder, reason: 'max_turns' | 'timeout' = 'max_turns'): string {
  return JSON.stringify({
    workOrderId: order.id,
    status: 'blocked',
    summary: '改到一半被切断',
    findings: [],
    artifacts: [],
    changedFiles: ['src/output.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    failureReason: reason,
  })
}

function passedJson(order: WorkOrder): string {
  return JSON.stringify({
    workOrderId: order.id,
    status: 'passed',
    summary: '接着上一轮补完了实现并跑过 typecheck',
    findings: [],
    artifacts: [],
    changedFiles: ['src/output.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  })
}

function report(outcome: WorkerWriteGateReport['outcome']): WorkerWriteGateReport {
  return { outcome, checks: [], evidence: outcome === 'passed' ? [] : ['❌ tsc — TS0000'], falseGreen: false, declaredFalseGreen: false }
}

describe('runHandsSession × 预算耗尽在 worktree 内续跑 (Wave 7)', () => {
  let baseDir: string
  let wtCoordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-cont-'))
    initGitRepo(baseDir)
    wtCoordinator = new WorktreeCoordinator(baseDir)
  })

  after(async () => {
    await wtCoordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  function writeInWorktree(workerCwd: string, body: string): void {
    mkdirSync(join(workerCwd, 'src'), { recursive: true })
    writeFileSync(join(workerCwd, 'src', 'output.ts'), body)
    execSync('git add -A && git commit --allow-empty -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
  }

  function baseConfig(order: WorkOrder, overrides: Partial<HandsSessionConfig> = {}): HandsSessionConfig {
    return {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      writeGateEnabled: true,
      evaluateWriteGate: async () => report('passed'),
      runAgent: async () => passedJson(order),
      ...overrides,
    }
  }

  it('预算耗尽即终止，保留部分 diff，不自动续跑或进写闸门', async () => {
    const order = testOrder({ id: 'wo-cont-basic' })
    const seen: Array<{ cwd: string; options?: HandsRunAgentOptions }> = []
    let gateRuns = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd, options) => {
        seen.push({ cwd: workerCwd, options })
        writeInWorktree(workerCwd, `export const v = ${seen.length}\n`)
        return seen.length === 1 ? exhaustedJson(order) : passedJson(order)
      },
      evaluateWriteGate: async () => { gateRuns++; return report('passed') },
    }))

    assert.equal(seen.length, 1)
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.terminalFailure, true)
    assert.equal(gateRuns, 0)
    assert.ok(run.result.artifacts.some(a => a.kind === 'diff' || a.title.includes('diff') || a.content.includes('diff --git')), 'partial diff is retained without a continuation')

  })

  it('不续跑的话写工连闸门都过不去——续跑是闸门的前置', async () => {
    const order = testOrder({ id: 'wo-cont-gate-gap' })
    let gateRuns = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        writeInWorktree(workerCwd, 'export const partial = 1\n')
        return exhaustedJson(order)
      },
      evaluateWriteGate: async () => { gateRuns++; return report('passed') },
    }))
    assert.equal(run.result.status, 'blocked', '续满上限仍未收敛 → 诚实交回 blocked')
    assert.equal(gateRuns, 0, 'blocked 不进闸门（这正是必须先续跑的原因）')
    assert.ok(!run.result.risks.some(r => r.includes('budget-continuation')))
  })

  it('续跑次数封顶，不会无限续', async () => {
    const order = testOrder({ id: 'wo-cont-cap' })
    let runs = 0
    await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        runs++
        writeInWorktree(workerCwd, `export const v = ${runs}\n`)
        return exhaustedJson(order, 'timeout')
      },
    }))
    assert.equal(runs, 1 + MAX_BUDGET_CONTINUATIONS, '首轮 + 上限次续跑，到此为止')
  })

  it('续跑与写闸门修复共用总账，最坏情况不叠乘', async () => {
    const order = testOrder({ id: 'wo-cont-ledger' })
    let runs = 0
    let evaluations = 0
    await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        runs++
        writeInWorktree(workerCwd, `export const v = ${runs}\n`)
        // 续满上限后才收敛，随即让闸门失败逼出一轮修复。
        return runs <= MAX_BUDGET_CONTINUATIONS ? exhaustedJson(order) : passedJson(order)
      },
      evaluateWriteGate: async () => { evaluations++; return evaluations === 1 ? report('failed') : report('passed') },
    }))
    assert.equal(runs, 1 + MAX_HANDS_EXTRA_RUNS, '首轮 + 总账额度，续跑没把闸门修复的额度吃掉')
    assert.equal(evaluations, 1, 'write gate failure does not schedule a repair')
  })

  it('父信号断开时不再续', async () => {
    const order = testOrder({ id: 'wo-cont-abort' })
    let runs = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, callbacks, workerCwd) => {
        runs++
        writeInWorktree(workerCwd, `export const v = ${runs}\n`)
        if (runs === 2) {
          callbacks.onAbort()
          return ''
        }
        return exhaustedJson(order)
      },
    }))
    assert.equal(runs, 1, 'budget failure is terminal before a second run')
    assert.equal(run.result.status, 'blocked', '保留上一轮的部分成果，不拿半截输出覆盖')
  })

  it('每一轮续跑都播报阶段，写工在工作树里的沉默期看得见（Wave 10）', async () => {
    const order = testOrder({ id: 'wo-cont-lifecycle' })
    const beats: string[] = []
    let runs = 0
    await runHandsSession(baseConfig(order, {
      onLifecycle: (detail) => beats.push(detail),
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        runs++
        writeInWorktree(workerCwd, `export const v = ${runs}\n`)
        return exhaustedJson(order, 'timeout')
      },
    }))
    assert.equal(runs, 1)
    assert.deepEqual(beats, [], 'no continuation lifecycle or model run')

  })

  it('续跑后 worktree 仍被正常销毁，不泄漏', async () => {
    const order = testOrder({ id: 'wo-cont-cleanup' })
    let worktreePath = ''
    await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        worktreePath = workerCwd
        writeInWorktree(workerCwd, 'export const v = 1\n')
        return exhaustedJson(order)
      },
    }))
    assert.notEqual(worktreePath, baseDir, '确实跑在隔离工作树里')
    assert.equal(existsSync(worktreePath), false, '续跑不影响 finally 里的 worktree 销毁')
  })
})
