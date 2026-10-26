import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import { available, fixture } from './framework-fixture.js'
import { createTaskLedger } from '../../agent/task-ledger.js'
import { createOwnershipLedger } from '../../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../../agent/worktree-baseline.js'
import { createVerificationAttribution } from '../../agent/verification-attribution.js'
import { createDeliveryGateV2 } from '../../agent/delivery-gate-v2.js'
import { createDeliverTaskTool } from '../../agent/deliver-task.js'
import { commitScopedFiles } from '../../agent/scoped-git-commit.js'

test('issue 514: real workspace receipt clears required and scoped commit preserves another staged file', { skip: !available('vitest') }, async () => {
  const f = fixture('vitest', true)
  try {
    const source = 'packages/web/src/value.ts'
    f.write('src/value.ts', 'export const value=1;')
    f.write(f.file, "import {test,expect} from 'vitest';import {value} from './value.ts';test('source',()=>expect(value).toBe(1));")
    writeFileSync(join(f.cwd, 'other.txt'), 'another session\n')
    execFileSync('git', ['add', '--', 'other.txt'], { cwd: f.cwd })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: f.cwd })
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: f.cwd })
    const ledger = createTaskLedger({ taskId: 'issue514-real-delivery' })
    for (const path of [source, f.path]) ledger.record({ type: 'file_write', path })
    ledger.record({ type: 'verification', command: 'fixture typecheck', status: 'passed', meta: { kind: 'typecheck', scope: 'full', exitCode: 0 } })
    const ownership = createOwnershipLedger({ taskLedger: ledger, baseline: createWorktreeBaseline({ branch: 'main', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim(), preExistingDirty: ['other.txt'], preExistingUntracked: [], capturedAt: Date.now() }) })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    const tool = createDeliverTaskTool(() => ({ taskLedger: ledger, ownership, gate,
      getCurrentDirtyFiles: () => [source, f.path, 'other.txt'],
      resolveDeliveryImpact: async () => ({ resolved: true, requiredTests: [f.path], advisoryTests: [], policyVersion: 1 }),
      detectWroteButNeverRead: () => [], getProjectMemoryContent: () => '',
      commitOwnedFiles: (cwd, files, message) => commitScopedFiles({ cwd, files, message }),
    }))
    const params = { cwd: f.cwd, toolUseId: 'issue514-deliver', input: { verification_policy: 'strict', commit: true, force: true, skip_review: true, message: 'fix: source fixture' } }
    const before = await tool.execute(params)
    assert.equal(before.isError, true)
    assert.deepEqual(before.verificationPlan!.pending, [f.path])
    assert.deepEqual(before.verificationPlan!.blocked, [])
    const run = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'issue514-run', input: { files: before.verificationPlan!.batches[0]!.files } })
    assert.equal(run.verification?.coverage?.complete, true, JSON.stringify(run.verification))
    ledger.record({ type: 'verification', command: run.verification!.command, status: run.verification!.status, meta: { ...run.verification } })
    const after = await tool.execute(params)
    assert.notEqual(after.isError, true, after.content)
    assert.deepEqual(after.verificationPlan!.pending, [])
    assert.deepEqual(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim().split('\n').sort(), [source, f.path].sort())
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: f.cwd, encoding: 'utf8' }).trim(), 'other.txt')
    assert.equal(readFileSync(join(f.cwd, 'other.txt'), 'utf8'), 'another session\n')
  } finally { f.dispose() }
})
