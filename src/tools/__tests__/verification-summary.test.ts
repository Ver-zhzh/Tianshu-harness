import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeVerification } from '../verification-summary.js'
import type { VerificationMetadata } from '../types.js'
import { verificationLifecycle } from '../../agent/verification-runs.js'

const receipt = (executionId: string, passed: number, failed = 0): VerificationMetadata => ({ executionId, command: 'fixture', status: failed ? 'failed' : 'passed', scope: 'targeted', executionState: 'exited', outcome: failed ? 'failed' : passed ? 'passed' : 'unknown', coverageStatus: 'complete', passed, failed, skipped: 0, countsReliable: true })
test('all completed receipts contribute totals once; failure and incomplete coverage are independent', () => {
  const first = receipt('first', 3), last = receipt('last', 2, 1)
  const summary = summarizeVerification([first, last, last], 3, 2)
  assert.deepEqual(summary.totals, { passed: 5, failed: 1, skipped: 0 })
  assert.equal(summary.coverageStatus, 'partial')
  assert.equal(summary.outcome, 'failed')
  assert.deepEqual(summary.executionIds, ['first', 'last'])
  assert.equal(summarizeVerification([receipt('zero', 0)], 1, 1).outcome, 'unknown')
  const excerpt = { ...last, countsReliable: false }
  assert.equal(summarizeVerification([first, excerpt], 2, 2).totals, undefined)
})
test('explicit comparison environments do not double-count unique test totals', () => {
  const summary = summarizeVerification([{ ...receipt('isolated', 3), verificationPhase: 'isolated' }, { ...receipt('integration', 3), verificationPhase: 'integration' }], 1, 1)
  assert.equal(summary.totals, undefined)
  assert.deepEqual(summary.byPhase, { isolated: { passed: 3, failed: 0, skipped: 0 }, integration: { passed: 3, failed: 0, skipped: 0 } })
})
test('interrupted or failed-to-start lifecycle cannot promote a late passed payload', () => {
  for (const executionState of ['timed_out', 'cancelled', 'failed_to_start'] as const) {
    const lifecycle = verificationLifecycle({ cwd: '/fixture', toolUseId: 'state', input: {} }, 'fixture', '/fixture')
    const result = lifecycle.finish(receipt('late', 1), executionState)
    assert.equal(result.executionState, executionState)
    assert.equal(result.outcome, 'unknown')
  }
})
