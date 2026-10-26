import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createReviewInbox } from '../review-inbox.js'
import { createReviewFollowupController } from '../review-followup-controller.js'
import { handleReviewFindingAction } from '../review-followup-tool.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import type { ReviewOutcome } from '../review-router.js'

const outcome: ReviewOutcome = { tier: 'auto', verdict: 'verified', findings: [
  { severity: 'LOW', claim: 'low defect still needs triage', evidence: 'src/a.mjs:1' },
  { severity: 'HIGH', claim: 'already confirmed correct', evidence: 'src/a.mjs:2', polarity: 'confirmation' },
] }
const settle = () => new Promise<void>(r => setImmediate(r))
async function until(condition: () => boolean) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('review follow-up did not finish')
}

test('durable inbox keeps LOW findings across recreation, deduplicates, and retains resolution history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-inbox-'))
  try {
    const options = { file: join(cwd, 'inbox.json') }
    const a = createReviewInbox(cwd, 'owner', options)
    const [task] = a.record('review', 'abc1234', ['src/a.mjs'], outcome)
    assert.ok(task)
    assert.equal(a.record('review', 'abc1234', ['src/a.mjs'], outcome).length, 0)
    const b = createReviewInbox(cwd, 'owner', options)
    assert.equal(b.list().length, 1, 'confirmation is not a defect; LOW is not silently discarded')
    b.update(task.id, 'confirmed', { reason: 'read source', evidence: 'caller reproduces the wrong branch' })
    assert.throws(() => b.update(task.id, 'fixed', { reason: 'done', evidence: 'trust me' }), /commit/)
    b.update(task.id, 'blocked', { reason: 'requires environment', evidence: 'browser not available' })
    assert.equal(a.list()[0]!.state, 'blocked')
    assert.deepEqual(a.list()[0]!.history.map(h => h.state), ['confirmed', 'blocked'])
    assert.throws(() => createReviewInbox(cwd, 'intruder', options).list(), /owner mismatch/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('deferred owner follow-up waits for settlement, never follows another session, and runs once', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-controller-'))
  try {
    const inbox = createReviewInbox(cwd, 'B', { file: join(cwd, 'inbox.json') })
    inbox.record('review', 'abc1234', ['src/a.mjs'], outcome)
    let owner = 'A', busy = false, allowed = true, runs = 0
    const controller = createReviewFollowupController({ getOwner: () => ({ cwd, sessionId: owner }), isBusy: () => busy,
      canContinue: () => allowed, inbox: () => inbox, run: () => { runs++; return true }, onError: error => { throw error } })
    controller.ready({ sessionId: 'B', reviewId: 'review' }); await settle()
    assert.equal(runs, 0)
    owner = 'B'; busy = true; controller.flush(); await settle()
    assert.equal(runs, 0)
    busy = false; allowed = false; controller.flush(); await settle()
    assert.equal(runs, 0, 'explicit stop/archival must win')
    allowed = true; controller.flush(); await settle(); await settle()
    assert.equal(runs, 0)
    controller.ready({ sessionId: 'B', reviewId: 'review' }); await settle(); await settle()
    assert.equal(runs, 0, 'old followupClaimed cannot launch any run')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('real review_changes validates commits, persists fixed+not_run and rejects fabricated passed', async () => {
  const { createReviewChangesTool } = await import('../../tools/review-changes.js')
  const cwd = mkdtempSync(join(tmpdir(), 'review-resolution-'))
  try {
    const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status,0,r.stderr); return r.stdout.trim() }
    git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.test')
    mkdirSync(join(cwd,'src'));writeFileSync(join(cwd,'src/a.mjs'),'export const value = 1\n')
    git('add','--','src/a.mjs');git('commit','-qm','original')
    const original = git('rev-parse','HEAD')
    const inbox = createReviewInbox(cwd,'owner',{file:join(cwd,'inbox.json')})
    const [task] = inbox.record('review',original,['src/a.mjs'],outcome)
    inbox.update(task!.id,'confirmed',{reason:'reproduced',evidence:'actual source'})
    writeFileSync(join(cwd,'src/a.mjs'),'export const value = 2\n');git('commit','-qam','fix')
    const fix = git('rev-parse','HEAD')
    const ledger = createTaskLedger({taskId:'owner'})
    const tool = createReviewChangesTool(()=>({cwd,sessionId:'owner',taskLedger:ledger,createInbox:()=>inbox}))
    const update = (extra: Record<string,unknown>) => tool.execute({cwd,toolUseId:'resolve',input:{action:'update',id:task!.id,state:'fixed',reason:'fixed',evidence:'real diff',...extra}})
    assert.equal((await update({fix_commit:'deadbee'})).isError,true)
    assert.equal((await update({fix_commit:fix,verification_command:'never-run'})).isError,true)
    assert.equal((await update({fix_commit:fix,verification_status:'not_run'})).isError,undefined)
    assert.equal(inbox.list(true)[0]!.verification,'not_run')
    assert.equal(inbox.list(true)[0]!.state,'fixed')
    const command = 'node --test regression.test.mjs'
    for (const meta of [{kind:'typecheck',passed:1,failed:0},{kind:'test',passed:0,failed:0},{kind:'test',passed:1,failed:0,stale:true}]) {
      ledger.record({type:'verification',command,status:'passed',meta:{scope:'targeted',...meta}})
      assert.equal((await update({fix_commit:fix,verification_command:command,verification_status:'passed'})).isError,true)
    }
    ledger.record({type:'verification',command,status:'passed',meta:{kind:'test',scope:'targeted',passed:1,failed:0}})
    assert.equal((await update({fix_commit:fix,verification_command:command,verification_status:'passed'})).isError,undefined)
    assert.equal(createReviewInbox(cwd,'owner',{file:join(cwd,'inbox.json')}).list(true)[0]!.verification,'passed')
  } finally { rmSync(cwd,{recursive:true,force:true}) }
})
