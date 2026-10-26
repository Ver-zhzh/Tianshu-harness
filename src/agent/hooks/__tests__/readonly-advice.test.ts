import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfVerifyHook } from '../self-verify-hook.js'
import { ObligationTracker } from '../../obligation-tracker.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'
import type { SelfVerifyHookDeps } from '../self-verify-hook.js'
import { createDefaultRuntimeHooks } from '../../create-runtime-hooks.js'
import { readonlyFactTask } from '../../readonly-advice.js'

const ctx = { snapshot: { turn: 3, runId: 'run', modelTurn: 1,
  recentToolHistory: [{ tool: 'read_file', status: 'success', target: 'a.ts' }] } } as RuntimeHookContext
function check(overrides: Partial<SelfVerifyHookDeps> = {}, context = ctx) {
  const submitted: string[] = [], decisions: string[] = []
  createSelfVerifyHook({ advisoryBus: { submit: e => { submitted.push(e.key) } }, readonlyAdviceMode: 'active',
    getReadonlyTaskConstraint: () => true, getVerificationDebt: () => false,
    getEvidenceState: () => ({ filesModified: new Set(), verifications: [] }), obligations: new ObligationTracker(),
    recordReadonlyAdvice: e => { decisions.push(e.decision) }, ...overrides }).run(context)
  return { submitted, decisions }
}
test('only active, fully-known readonly facts suppress the informational test advice', () => {
  assert.deepEqual(check(), { submitted: [], decisions: ['eligible'] })
  assert.deepEqual(check({ readonlyAdviceMode: 'shadow' }), { submitted: ['self-verify'], decisions: ['eligible'] })
  assert.deepEqual(check({ readonlyAdviceMode: 'off' }), { submitted: ['self-verify'], decisions: [] })
})

test('readonly verification intent or missing semantic classification never acquires suppression', () => {
  assert.equal(readonlyFactTask(true, ['code_explanation']), true)
  assert.equal(readonlyFactTask(true, ['verification']), false)
  assert.equal(readonlyFactTask(true, ['code_explanation', 'verification']), false)
  assert.equal(readonlyFactTask(true, []), undefined)
  assert.equal(readonlyFactTask(undefined, ['code_explanation']), undefined)
})
test('unknown intent, missing obligation state, modifications and debt preserve existing advice', () => {
  for (const overrides of [{ getReadonlyTaskConstraint: undefined }, { obligations: undefined },
    { getVerificationDebt: undefined }, { getEvidenceState: undefined }, { getReadonlyTaskConstraint: () => false },
    { getVerificationDebt: () => true }, { getEvidenceState: () => ({ filesModified: new Set(['a.ts']), verifications: [] }) }]) {
    assert.ok(check(overrides).submitted.includes('self-verify'))
  }
})
test('a low-risk pending verification obligation is not silently suppressed', () => {
  const obligations = new ObligationTracker()
  obligations.upsert({ family: 'regression', claim: 'run the requested check', risk: 'low' })
  assert.ok(check({ obligations }).submitted.includes('self-verify'))
})
test('failed reads, unknown shell activity and mutating git do not qualify', () => {
  for (const item of [{ tool: 'read_file', status: 'failed' }, { tool: 'bash', status: 'success' },
    { tool: 'git', status: 'success', target: 'commit' }]) {
    const context = { snapshot: { ...ctx.snapshot, recentToolHistory: [{ target: '', ...item }] } } as RuntimeHookContext
    assert.ok(check({}, context).submitted.includes('self-verify'))
  }
})

test('factory forwards live readonly facts and records the actual suppression decision', () => {
  const before = process.env.RIVET_READONLY_ADVICE_EXPERIMENT
  process.env.RIVET_READONLY_ADVICE_EXPERIMENT = '1'
  try {
    const submitted: string[] = [], telemetry: unknown[] = []
    let readonly = true
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {}, stigmergyQuery: async () => [], setLoadedPheromones() {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState() {}, getPredictionAccumulator: () => ({ history: [] }),
      advisoryBus: { submit: (entry: { key: string }) => { submitted.push(entry.key) } } as never,
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      getVerificationDebt: () => false, getReadonlyTaskConstraint: () => readonly, obligations: new ObligationTracker(),
      telemetryWriter: { write: event => { telemetry.push(event) }, flush: async () => {} },
    })
    const hook = hooks.find(h => h.name === 'self-verify')!
    assert.equal(hook.phase, 'postTurn')
    if (hook.phase !== 'postTurn') throw new Error('wrong phase')
    hook.run(ctx)
    assert.equal(submitted.length, 0)
    assert.ok(telemetry.some(event => (event as { decision?: string }).decision === 'eligible'))
    readonly = false
    hook.run(ctx)
    assert.ok(submitted.includes('self-verify'), 'getter must be consumed at the hook, not frozen in an intermediate layer')
  } finally {
    if (before === undefined) delete process.env.RIVET_READONLY_ADVICE_EXPERIMENT
    else process.env.RIVET_READONLY_ADVICE_EXPERIMENT = before
  }
})
