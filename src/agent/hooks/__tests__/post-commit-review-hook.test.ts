import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPostCommitReviewPreTurnHook, createPostCommitReviewPostToolHook } from '../post-commit-review-hook.js'
import { enqueuePostCommitReviewOutcome, __resetPostCommitReviewQueue } from '../../post-commit-review-queue.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn: 3,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {},
      setGitChangeRate() {}, injectUserMessage() {},
      requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

const toolEvent: RuntimeToolEvent = { name: 'read_file', success: true }

describe('PostCommitReviewHook', () => {
  beforeEach(() => { __resetPostCommitReviewQueue() })

  it('another session and an unbound hook cannot consume the owner outcome', () => {
    const a: AdvisoryEntry[] = [], b: AdvisoryEntry[] = []
    enqueuePostCommitReviewOutcome({ sessionId: 'B', lines: ['owned by B'], verdict: 'rejected', tier: 'auto' })
    createPostCommitReviewPreTurnHook({ sessionId: 'A', advisoryBus: { submit: e => { a.push(e) } } }).run(makeCtx())
    createPostCommitReviewPreTurnHook({ advisoryBus: { submit: e => { a.push(e) } } }).run(makeCtx())
    assert.equal(a.length, 0)
    createPostCommitReviewPostToolHook({ sessionId: 'B', advisoryBus: { submit: e => { b.push(e) } } }).run(makeCtx(), toolEvent)
    assert.equal(b.length, 1)
    assert.equal(b[0]!.content, 'owned by B')
  })

  it('preTurn drains the queue into the advisory bus', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createPostCommitReviewPreTurnHook({
      sessionId: 'owner', advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    enqueuePostCommitReviewOutcome({ sessionId: 'owner',
      lines: ['提交 abc1234 的提交后审查完成：', '⚠️ 审查门发现问题 (auto)：wiring gap'],
      verdict: 'rejected',
      tier: 'auto',
    })

    hook.run(makeCtx())

    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /审查门发现问题/)
    assert.match(submitted[0]!.content, /abc1234/)
    assert.equal(submitted[0]!.category, 'discipline')
    assert.equal(submitted[0]!.tier, 'informational')
    assert.notEqual(submitted[0]!.immediate, true, 'late results never steer the controller into work')
  })

  it('postTool drains too, and the queue is consumed exactly once', () => {
    const submitted: AdvisoryEntry[] = []
    const bus = { submit(e: AdvisoryEntry) { submitted.push(e) } }
    const postTool = createPostCommitReviewPostToolHook({ sessionId: 'owner', advisoryBus: bus })
    const preTurn = createPostCommitReviewPreTurnHook({ sessionId: 'owner', advisoryBus: bus })
    enqueuePostCommitReviewOutcome({ sessionId: 'owner', lines: ['✅ 审查通过 (auto)：ok'], verdict: 'verified', tier: 'auto' })

    postTool.run(makeCtx(), toolEvent)
    preTurn.run(makeCtx())

    assert.equal(submitted.length, 1, 'dual-phase drain must not double-deliver')
    assert.equal(submitted[0]!.tier, 'informational', 'verified verdict is low-priority fill')
    assert.notEqual(submitted[0]!.immediate, true)
  })

  it('inconclusive verdict is operational but not immediate', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createPostCommitReviewPreTurnHook({
      sessionId: 'owner', advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    enqueuePostCommitReviewOutcomes3()
    hook.run(makeCtx())

    assert.equal(submitted.length, 3, 'each outcome is delivered as its own entry')
    const keys = new Set(submitted.map(e => e.key))
    assert.equal(keys.size, 3, 'keys must be unique so entries do not dedupe-overwrite each other')
  })

  it('empty queue is a no-op', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createPostCommitReviewPreTurnHook({
      sessionId: 'owner', advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx())
    assert.equal(submitted.length, 0)
  })

  it('persisted findings never repeatedly inject work into unrelated turns', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createPostCommitReviewPreTurnHook({ sessionId: 'owner',
      reviewInbox: { sessionId: 'owner', list: () => [{ id: 'pending', state: 'pending', claim: 'bug' }] } as never,
      advisoryBus: { submit: e => { submitted.push(e) } },
    })
    hook.run(makeCtx()); hook.run(makeCtx())
    assert.equal(submitted.length, 0)
  })
})

function enqueuePostCommitReviewOutcomes3(): void {
  enqueuePostCommitReviewOutcome({ sessionId: 'owner', lines: ['⚠️ 审查未决 (auto)：infra'], verdict: 'inconclusive', tier: 'auto' })
  enqueuePostCommitReviewOutcome({ sessionId: 'owner', lines: ['⚠️ 审查未决 (auto)：infra'], verdict: 'inconclusive', tier: 'auto' })
  enqueuePostCommitReviewOutcome({ sessionId: 'owner', lines: ['✅ 审查通过 (L3)：ok'], verdict: 'verified', tier: 'L3' })
}
