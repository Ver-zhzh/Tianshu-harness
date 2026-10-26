import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishFactHandoff, readFactHandoff, listFactHandoffs } from '../fact-handoff.js'
import { recordDeliveryReceipt } from '../delivery-receipt.js'
import { saveVerificationRun } from '../verification-runs.js'
import { selectHandoff, readSelectedHandoff } from '../handoff-selection.js'
import { saveCompletionEvidence } from '../../plan/completion-evidence.js'

test('fact snapshots preserve history, bound whole entries, detect corruption and isolate projects', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fact-handoff-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  try {
    recordDeliveryReceipt(cwd, 'A', 'a'.repeat(40))
    saveVerificationRun(cwd, { executionId: 'failed', sessionId: 'A', cwd, command: 'fixture', scope: 'targeted', status: 'failed', executionState: 'exited', outcome: 'failed', coverageStatus: 'partial', buildId: 'fixture', contractVersion: 2 })
    const first = publishFactHandoff(cwd, 'A', { goal: 'Task', turnCount: 4, todos: [{ id: 'done', content: 'Implemented', status: 'completed' }] })
    assert.match(first.sections.verification!.join(), /failed/)
    assert.match(first.sections.implementation!.join(), /执行：未知/)
    assert.match(first.sections.commits!.join(), /aaaaaaaa/)
    assert.match(first.brief, /当前代码有效性未知/)
    assert.equal(readFactHandoff(cwd, 'A', first.snapshotId).snapshotId, first.snapshotId)
    const second = publishFactHandoff(cwd, 'A', { goal: '😀'.repeat(2500), turnCount: 5, todos: Array.from({ length: 50 }, (_, n) => ({ id: String(n), content: `Complete item ${n}`, status: 'pending' })) })
    assert.ok([...second.brief].length <= 2000, String([...second.brief].length))
    assert.match(second.brief, /遗漏 \d+ 个完整条目/)
    assert.equal(second.sections.goal![0]!.includes('😀'.repeat(2500)), true)
    assert.equal(readFactHandoff(cwd, 'A').snapshotId, second.snapshotId)
    assert.equal(readFactHandoff(cwd, 'A', first.snapshotId).turnCount, 4)
    saveCompletionEvidence({ cwd, sessionId: 'A', toolUseId: 'fixture', input: {} }, { sessionId: 'A', acceptance: [],
      findings: [{ findingId: 'accepted', stepId: 'step', disposition: 'adopted', reportRef: 'original-report' }],
      openItems: [{ id: 'closed', text: 'Old issue', status: 'closed', closedBy: 'Observed closure', reopenIf: 'REGRESSION_CONDITION', provenance: 'unverified', updatedAt: 1 }] })
    const triage = publishFactHandoff(cwd, 'A', { goal: 'Keep pending findings visible' })
    assert.match(triage.sections.pending!.join(), /accepted.*未登记/)
    assert.match(triage.sections.open!.join(), /REGRESSION_CONDITION/)
    assert.match(triage.sections.records!.join(), /original-report/)
    publishFactHandoff(cwd, 'B', { goal: 'Other' })
    assert.equal(listFactHandoffs(cwd).length, 2)
    assert.throws(() => readFactHandoff(join(cwd, 'other'), 'A', first.snapshotId), /归属/)
    const file = join(cwd, 'sessions/A/handoff', `${first.snapshotId}.json`)
    const data = JSON.parse(readFileSync(file, 'utf8')); data.sections.commits = ['forged HEAD']
    writeFileSync(file, JSON.stringify(data))
    assert.throws(() => readFactHandoff(cwd, 'A', first.snapshotId), /损坏/)
    writeFileSync(join(cwd, 'sessions/legacy.handoff.md'), 'Old narrative')
    const legacy = readFactHandoff(cwd, 'legacy')
    assert.equal(legacy.legacy, true)
    assert.match(legacy.brief, /覆盖未知/)
    assert.equal(existsSync(join(cwd, 'sessions/legacy/handoff')), false, 'legacy query never creates a snapshot')
    writeFileSync(join(cwd, 'sessions/legacy.handoff.md'), 'Changed narrative')
    assert.throws(() => readFactHandoff(cwd, 'legacy', legacy.snapshotId), /原引用不可确认/)
  } finally { if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(cwd, { recursive: true, force: true }) }
})

test('later publications retain snapshots explicitly selected by another session from persisted selections', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fact-retention-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  try {
    const selected = publishFactHandoff(cwd, 'source', { goal: 'Keep this exact evidence' })
    selectHandoff(cwd, 'receiver', 'source', selected.snapshotId)
    for (let round = 0; round < 25; round++) publishFactHandoff(cwd, 'source', { goal: `round ${round}` })
    const result = readSelectedHandoff({ cwd, sessionId: 'receiver', toolUseId: 'persisted-selection', input: { file_path: `handoff://source/${selected.snapshotId}/goal` } })!
    assert.ok(!result.isError, result.content)
    assert.match(result.content, /Keep this exact evidence/)
    assert.equal(readFactHandoff(cwd, 'source', selected.snapshotId).snapshotId, selected.snapshotId)
    assert.match(readFactHandoff(cwd, 'source').sections.goal![0]!, /round 24$/)
    const files = readdirSync(join(cwd, 'sessions/source/handoff')).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    assert.equal(files.length, 26, 'publication is not an implicit deletion authorization')
  } finally {
    if (prior === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prior
    rmSync(cwd, { recursive: true, force: true })
  }
})
