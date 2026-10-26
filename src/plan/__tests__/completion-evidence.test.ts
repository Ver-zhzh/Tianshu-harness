import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completionSummary, recordCompletionEvidence, readCompletionEvidence } from '../completion-evidence.js'
import { saveVerificationRun } from '../../agent/verification-runs.js'
import { createReviewInbox } from '../../agent/review-inbox.js'
import { createTodoTool } from '../../tools/todo.js'
import { TodoStore } from '../../tools/todo-store.js'
import type { ToolCallParams } from '../../tools/types.js'

test('acceptance routes consume real versioned receipts, preserve deferrals, and isolate findings', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'completion-evidence-')), previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  let fingerprint = 'version-1'
  const params: ToolCallParams = { cwd, toolUseId: 'fixture', sessionId: 'owner', input: {}, currentVerificationFingerprint: () => fingerprint }
  try {
    writeFileSync(join(cwd, 'consumer.ts'), 'export const value = 1\n')
    saveVerificationRun(cwd, { executionId: 'run', sessionId: 'owner', cwd, command: 'node --test consumer.test.ts', scope: 'targeted', status: 'passed', kind: 'test', passed: 1, failed: 0, countsReliable: true, workspaceFingerprint: fingerprint, executionState: 'exited', outcome: 'passed', coverageStatus: 'complete', buildId: 'fixture', contractVersion: 2 })
    const inbox = createReviewInbox(cwd, 'owner')
    const [finding] = inbox.record('review-1', 'fixed-snapshot', ['consumer.ts'], { tier: 'L2', verdict: 'rejected', findings: [{ claim: 'missing runtime wiring', evidence: 'consumer.ts:1' }] }, { workspaceFingerprint: fingerprint })
    const tool = createTodoTool(new TodoStore())
    const result = await tool.execute({ ...params, input: { action: 'write', plan_ref: '.rivet/plans/plan.md', todos: [{ id: 'step-1', content: 'wire consumer', status: 'completed' }], acceptance: [
      { id: 'impl', stepId: 'step-1', criterion: 'consumer wired', kind: 'implementation', status: 'met', consumerBoundary: 'route → actual consumer', evidenceRefs: ['source:consumer.ts:1'], evidence: 'observed line 1' },
      { id: 'verify', stepId: 'step-1', criterion: 'targeted check', kind: 'verification', status: 'met', consumerBoundary: 'real child exit', evidenceRefs: ['execution:run'], evidence: 'receipt' },
      { id: 'review', stepId: 'step-1', criterion: 'independent review executed', kind: 'review', status: 'met', consumerBoundary: 'readonly worker snapshot', evidenceRefs: ['review:review-1'], evidence: 'findings retained' },
      { id: 'later', stepId: 'step-1', criterion: 'manual acceptance', kind: 'verification', status: 'deferred', reason: 'user deferred' },
    ], findings: [{ findingId: finding!.id, stepId: 'step-1', disposition: 'deferred', reason: 'user schedules follow-up' }] } })
    assert.ok(!result.isError, result.content)
    let summary = completionSummary({ ...params, input: { execution_ids: ['run'] } }, '.rivet/plans/plan.md', 'completed')
    assert.deepEqual(summary.criteria.map(c => c.status), ['met', 'pending', 'pending', 'deferred'])
    assert.match(summary.detail.join('\n'), /finding:.*step-1: deferred/)
    assert.match((await tool.execute({ ...params, input: { action: 'read' } })).content, /user deferred/)
    fingerprint = 'version-2'
    writeFileSync(join(cwd, 'consumer.ts'), 'export const value = 2\n')
    summary = completionSummary({ ...params, input: { execution_ids: ['run'] } }, '.rivet/plans/plan.md', 'completed')
    assert.deepEqual(summary.criteria.map(c => c.status), ['pending', 'pending', 'pending', 'deferred'])
    assert.match(summary.summary, /版本不可确认/)
    assert.equal(readCompletionEvidence({ ...params, sessionId: 'other' }).acceptance.length, 0)
    assert.throws(() => recordCompletionEvidence(params, [], [{ findingId: finding!.id, stepId: 'step-1', disposition: 'excluded' }]), /原因/)
    assert.throws(() => recordCompletionEvidence({ ...params, sessionId: 'other' }, [], [{ findingId: finding!.id, stepId: 'step-1', disposition: 'adopted' }]), /本会话/)
    const [unbacked] = recordCompletionEvidence(params, [{ criterion: 'fake GREEN', kind: 'verification', status: 'met', consumerBoundary: 'actual runner', evidenceRefs: ['execution:missing'] }])
    assert.equal(unbacked!.status, 'pending')
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    rmSync(cwd, { recursive: true, force: true })
  }
})
