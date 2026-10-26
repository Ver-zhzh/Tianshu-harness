import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_TOOL } from '../plan.js'
import type { DeliveryGateResult } from '../../agent/delivery-gate-v2.js'
import type { VerificationSummary } from '../../agent/evidence.js'

describe('plan closure separates implementation from quality', () => {
  let dir = '', previous: string | undefined
  const planRel = '.rivet/plans/close.md'
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-independent-'))
    previous = process.env.RIVET_SESSION_DIR; process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
    mkdirSync(join(dir, '.rivet/plans'), { recursive: true })
    writeFileSync(join(dir, planRel), '# Plan\n\n### Task 1\n- [ ] [implementation] implement\n- [ ] legacy unknown\n- [ ] [verification] tests\n- [ ] [review] review\n')
  })
  afterEach(() => { if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const close = (input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => PLAN_TOOL.execute({ cwd: dir, sessionId: 'owner', input: { action: 'close', file_path: planRel, tasks: 'all', apply: true, ...input }, ...extra } as any)
  it('closes completed implementation with RED/unknown quality and never invokes the gate', async () => {
    let events: any[] = []
    const result = await close({ deliveryState: 'GREEN', verifiedCommands: ['npm test'] }, { assessDelivery: () => { throw Error('quality gate must not run') }, onPlanClosed: (e: any) => events.push(e) })
    assert.ok(!result.isError, result.content)
    const text = readFileSync(join(dir, planRel), 'utf8')
    assert.match(text, /Status: EXECUTED/)
    assert.match(text, /- \[x\] \[implementation\] implement/)
    for (const item of ['legacy unknown', '[verification] tests', '[review] review']) assert.ok(text.includes('- [ ] ' + item))
    assert.doesNotMatch(text, /均已完成并通过验证|验证通过/)
    assert.match(text, /历史命令：npm test（历史声明，未核实）/)
    assert.equal(events[0].summary, result.content.slice(result.content.indexOf('执行：')))
  })
  it('partial/blocked progress is independent of legacy GREEN and does not check implementation boxes', async () => {
    for (const executionStatus of ['partial', 'blocked']) {
      const result = await close({ executionStatus, deliveryState: 'GREEN', execution_ids: ['missing'] })
      assert.ok(!result.isError, result.content)
      const text = readFileSync(join(dir, planRel), 'utf8')
      assert.doesNotMatch(text, /Status: EXECUTED/)
      assert.match(text, /- \[ \] \[implementation\] implement/)
      assert.match(text, /missing: 未知/)
    }
  })
  it('preview does not write or evaluate quality', async () => {
    const before = readFileSync(join(dir, planRel), 'utf8')
    const result = await close({ apply: false }, { assessDelivery: () => { throw Error('called') } })
    assert.ok(!result.isError, result.content)
    assert.equal(readFileSync(join(dir, planRel), 'utf8'), before)
  })
  it('missing or corrupt quality records remain unknown without blocking implementation closure', async () => {
    const owner = join(dir, 'sessions', 'owner')
    mkdirSync(owner, { recursive: true })
    writeFileSync(join(owner, 'completion-evidence.json'), '{broken')
    writeFileSync(join(owner, 'verification-runs.jsonl'), '{broken\n')
    const result = await close({ execution_ids: ['unknown'] })
    assert.ok(!result.isError, result.content)
    const text = readFileSync(join(dir, planRel), 'utf8')
    assert.match(text, /Status: EXECUTED/)
    assert.match(text, /无法确认/)
    assert.match(text, /unknown: 未知/)
  })
  it('a partial close preserves the approved plan marker', async () => {
    const file = join(dir, planRel)
    writeFileSync(file, '> **Status: APPROVED**\n\n' + readFileSync(file, 'utf8'))
    assert.ok(!(await close({ executionStatus: 'partial' })).isError)
    assert.match(readFileSync(file, 'utf8'), /Status: APPROVED/)
  })
})

describe('plan close — 闭环即解锁(自动退出 plan mode)', () => {
  let dir = ''
  const planRel = '.rivet/plans/exit-plan.md'

  const PLAN_BODY = [
    '# Exit Plan',
    '',
    '## 6. Tasks',
    '',
    '### Task 1: Do the thing',
    '- [ ] step one',
    '',
  ].join('\n')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-plan-exit-'))
    const abs = join(dir, planRel)
    mkdirSync(join(dir, '.rivet/plans'), { recursive: true })
    writeFileSync(abs, PLAN_BODY, 'utf-8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function close(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return PLAN_TOOL.execute({
      cwd: dir,
      input: { action: 'close', file_path: planRel, tasks: 'all', ...input },
      toolUseId: 'test-tool-use',
      ...extra,
    } as any)
  }

  const greenGate = (): { assessDelivery: () => DeliveryGateResult; getVerificationEvidence: () => VerificationSummary } => ({
    assessDelivery: () => ({
      state: 'GREEN', canDeliver: true, isBlocked: false, ownedFileCount: 1, externalFileCount: 0,
      verificationCount: 2, supersededFailures: 0, staleSnapshotDropped: 0, staleFingerprintDropped: 0, staleFailureCandidates: 0,
      toolInvocationFailureCandidates: [],
    }),
    getVerificationEvidence: () => ({ total: 2, verified: 2, pending: 0, files: [{ path: 'src/foo.ts', level: 'tested' }] }),
  })

  const redGate = (): { assessDelivery: () => DeliveryGateResult } => ({
    assessDelivery: () => ({
      state: 'RED', canDeliver: false, isBlocked: true, ownedFileCount: 1, externalFileCount: 0,
      verificationCount: 0, supersededFailures: 0, staleSnapshotDropped: 0, staleFingerprintDropped: 0, staleFailureCandidates: 0,
      toolInvocationFailureCandidates: [],
    }),
  })

  it('闭环(gate-GREEN EXECUTED)不再调用 exitPlanMode（close 语义已解耦）', async () => {
    let exited = 0
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test'] },
      { ...greenGate(), exitPlanMode: () => { exited++ } },
    )
    assert.ok(!result.isError, result.content)
    assert.equal(exited, 0)
    assert.ok(!result.content.includes('已自动退出计划模式'))
  })

  it('非闭环(诚实 RED checkpoint)不调用 exitPlanMode', async () => {
    let exited = 0
    const result = await close(
      { apply: true, deliveryState: 'RED' },
      { ...redGate(), exitPlanMode: () => { exited++ } },
    )
    assert.ok(!result.isError, result.content)
    assert.equal(exited, 0)
  })

  it('无 exitPlanMode ref(worker 上下文)不报错', async () => {
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test'] },
      greenGate(),
    )
    assert.ok(!result.isError, result.content)
  })
})
