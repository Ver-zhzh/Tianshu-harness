import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECOVERY_SCENARIOS, recoveryScene, type RecoveryArm, type RecoveryScenario } from '../recovery-scenes.js'
import { evaluateRecoveryTrial, summarizeRecoveryTrials, type RecoveryTrial } from '../recovery-evaluation.js'
import { createHash } from 'node:crypto'
import type { CallAuditRecord } from '../../api/call-audit.js'

function audit(rows: RecoveryTrial[]): CallAuditRecord[] {
  return rows.flatMap(row => row.steps.map(step => ({ operationId: step.attemptId!, requestId: step.requestId, runId: row.runId,
    sessionId: `recovery-${row.runId}`, provider: row.provider, responseModel: row.model, runtime: row.runtime,
    phase: 'finished' as const, status: 'complete' as const, purpose: 'main_execution', t: 1 })))
}

async function complete(scenario: RecoveryScenario, arm: RecoveryArm) {
  return evaluateRecoveryTrial(scenario, arm, async input => {
    const index = input.steps.length
    if (scenario === 'failure-output') return { text: JSON.stringify(arm === 'baseline' && index === 0 ? { action: 'inspect_log' } : { action: 'report', status: 'failed', cause: 'SIGTERM' }) }
    if (scenario === 'queued-read') return { text: JSON.stringify(arm === 'baseline' && index === 0 ? { action: 'retry_read' } : { action: 'report', values: [1, 2] }) }
    return { text: JSON.stringify(arm === 'baseline' && index === 0 ? { action: 'query_version' }
      : index < (arm === 'baseline' ? 2 : 1) ? { action: 'apply_edit', version: createHash('sha256').update('mode=old\n').digest('hex') }
        : { action: 'report', status: 'changed' }) }
  })
}
async function rows(): Promise<RecoveryTrial[]> {
  const result: RecoveryTrial[] = []
  for (const scenario of RECOVERY_SCENARIOS) for (const repeat of [0, 1, 2]) for (const arm of ['baseline', 'candidate'] as const) {
    const evaluated = await complete(scenario, arm)
    evaluated.steps.forEach((step, index) => { step.requestId = `${scenario}-${repeat}-${arm}-request-${index}`; step.attemptId = `${scenario}-${repeat}-${arm}-attempt-${index}` })
    result.push({
    experimentId: 'experiment', runId: `${scenario}-${repeat}-${arm}`, scenario, repeat, arm, provider: 'fixture', model: 'fixture',
    runtime: { buildId: 'build', moduleSha256: 'a'.repeat(64), sourceRevision: 'rev', version: '1', executionContract: 2 },
    mode: 'live-model', review: 'reviewed', reviewer: 'fixture',
    attempts: evaluated.steps.map(step => ({ requestId: step.requestId, operationId: step.attemptId!, responseModel: 'fixture', status: 'complete' })), ...evaluated,
  }) }
  return result
}
test('scenes measure recovery actions and require the actual requested final outcome', async () => {
  const trials = await rows(), report = summarizeRecoveryTrials(trials, audit(trials))
  assert.equal(report.supportsLocalHypothesis, true)
  assert.equal(report.productionDefaultEligible, false)
  assert.ok(report.byScenario.every(row => row.candidate.recoveryActions < row.baseline.recoveryActions))
  const wrong = await evaluateRecoveryTrial('failure-output', 'candidate', async () => ({ text: '{"action":"report","status":"passed"}' }))
  assert.equal(wrong.outcome.passed, false)
})
test('missing pairs, duplicates, unknown or mixed builds, unreviewed and scripted records cannot pass', async () => {
  const valid = await rows()
  for (const mutate of [
    (r: RecoveryTrial[]) => { r.pop() }, (r: RecoveryTrial[]) => { r[1] = structuredClone(r[0]!) },
    (r: RecoveryTrial[]) => { r[0]!.runtime.buildId = 'unknown' },
    (r: RecoveryTrial[]) => { r[0]!.model = 'different' },
    (r: RecoveryTrial[]) => { r[0]!.runtime.moduleSha256 = 'b'.repeat(64) },
    (r: RecoveryTrial[]) => { r[0]!.review = 'unreviewed' },
    (r: RecoveryTrial[]) => { r[0]!.mode = 'scripted' },
    (r: RecoveryTrial[]) => { r[0]!.attempts = [] },
    (r: RecoveryTrial[]) => { r[1]!.outcome.unsafeAttempts = 1 },
    (r: RecoveryTrial[]) => { r[0]!.steps[0]!.response = '{"action":"rerun"}' },
    (r: RecoveryTrial[]) => { r[0]!.steps[0]!.observation = { fabricated: true } },
    (r: RecoveryTrial[]) => { r[0]!.firstEffectiveAction = 9 },
  ]) {
    const input = structuredClone(valid); mutate(input)
    assert.equal(summarizeRecoveryTrials(input, audit(valid)).supportsLocalHypothesis, false)
  }
})
test('invalid responses and repeated unchanged observations do not manufacture effective progress', async () => {
  const invalid = await evaluateRecoveryTrial('version-observation', 'baseline', async () => ({ text: 'not JSON' }))
  assert.equal(invalid.steps.length, 5); assert.equal(invalid.firstEffectiveAction, null); assert.equal(invalid.outcome.passed, false)
  const repeated = await evaluateRecoveryTrial('version-observation', 'baseline', async () => ({ text: '{"action":"read_file"}' }))
  assert.equal(repeated.firstEffectiveAction, null); assert.equal(repeated.outcome.passed, false)
})

test('one scenario getting worse cannot be hidden by aggregate improvement elsewhere', async () => {
  const trials = await rows()
  for (const row of trials.filter(r => r.scenario === 'failure-output' && r.arm === 'candidate')) {
    const id = row.runId + '-extra'
    const initial = { response: '{"action":"query_execution"}', action: { action: 'query_execution' },
      observation: { executionId: 'test-1', exit: 1, status: 'failed', rawLog: 'test.log' }, requestId: id, attemptId: id }
    row.steps.unshift(initial)
    row.attempts!.push({ requestId: id, operationId: id, status: 'complete', responseModel: 'fixture' })
    // baseline needs one recovery; candidate now needs one, plus a repeated query.
    row.steps.unshift({ ...structuredClone(initial), requestId: id + '-2', attemptId: id + '-2' })
    row.attempts!.push({ requestId: id + '-2', operationId: id + '-2', status: 'complete', responseModel: 'fixture' })
  }
  const report = summarizeRecoveryTrials(trials, audit(trials))
  assert.equal(report.supportsLocalHypothesis, false)
  assert.ok(report.reasons.includes('scenario_recovery_regression'))
})

test('self-reported live metadata cannot replace provider audit or reuse one run across trials', async () => {
  const trials = await rows(), trusted = audit(trials)
  const missing = summarizeRecoveryTrials(trials)
  assert.ok(missing.reasons.includes('trusted_provider_audit_missing'))
  assert.ok(missing.byScenario.every(row => !row.localHypothesisSupported))
  const wrongRun = trusted.map(row => ({ ...row, runId: 'other' }))
  assert.ok(summarizeRecoveryTrials(trials, wrongRun).reasons.includes('trusted_provider_binding_mismatch'))
  assert.ok(summarizeRecoveryTrials(trials, trusted.map(row => ({ ...row, purpose: 'provider_probe' }))).reasons.includes('trusted_provider_binding_mismatch'))
  trials[1]!.runId = trials[0]!.runId
  trials[1]!.steps[0]!.attemptId = trials[0]!.steps[0]!.attemptId
  const reused = summarizeRecoveryTrials(trials, trusted)
  assert.ok(reused.reasons.includes('invalid_or_reused_run'))
  assert.ok(reused.reasons.includes('reused_provider_response'))
})

test('a guessed root cause is not evidence', () => {
  const guess = recoveryScene('failure-output', 'baseline')
  assert.deepEqual(guess.step({ action: 'report', status: 'failed', cause: 'SIGTERM' }), { accepted: false })
})
test('post-edit observations and subsequent version checks reflect the new state', () => {
  const file = recoveryScene('version-observation', 'candidate')
  const before = file.initial as { version: string }
  file.step({ action: 'apply_edit', version: before.version })
  const after = file.step({ action: 'read_file' }) as { content: string; version: string }
  assert.equal(after.content, 'mode=new\n')
  assert.notEqual(after.version, before.version)
  assert.equal((file.step({ action: 'apply_edit', version: before.version }) as { changed: boolean }).changed, false)
  assert.deepEqual(file.step({ action: 'apply_edit', version: after.version }), { changed: false, content: 'mode=new\n' })
})
test('execution queries cannot deny an already successful or retried read', () => {
  const queue = recoveryScene('queued-read', 'candidate')
  assert.deepEqual(queue.step({ action: 'query_execution' }), { dispatched: true, first: { value: 1 }, second: { value: 2 } })
  const baseline = recoveryScene('queued-read', 'baseline')
  baseline.step({ action: 'retry_read' })
  assert.deepEqual(baseline.step({ action: 'query_execution' }), { dispatched: true, first: { value: 1 }, second: { value: 2 } })
})
