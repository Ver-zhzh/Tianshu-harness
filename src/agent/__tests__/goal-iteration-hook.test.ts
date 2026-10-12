/**
 * #463 回归测试：--goal 模式下步数计数器恒为 0/100。
 *
 * 根因：goal_state SSE 只在创建/暂停/恢复/取消时下发，advanceIteration
 * 之后从不重发。修复：GoalContinuationController 在每次 advanceIteration
 * 后调用可选的 onGoalIteration 钩子（sidecar 接到后重发 goal_state）。
 *
 * 用真实 GoalTracker 驱动 handleGoalCheck 走 shouldContinue 路径，
 * 断言钩子被调用且调用时 iteration 已递增。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { GoalContinuationController } from '../goal-continuation.js'
import { GoalTracker } from '../goal-tracker.js'
import type { GoalCheckParams } from '../goal-continuation.js'

function makeController(onGoalIteration?: (t: GoalTracker) => void): {
  ctrl: GoalContinuationController
  tracker: GoalTracker
} {
  const tracker = new GoalTracker({
    goal: 'write docs',
    maxIterations: 100,
    contextWindow: 200_000,
  })
  const ctrl = new GoalContinuationController({
    getGoalTracker: () => tracker,
    getStreamedText: () => 'did some work, continuing',
    getEstimatedTokens: () => 1000,
    getSessionId: () => undefined, // persistGoalState 跳过（无 sid）
    getCwd: () => '/tmp',
    appendSystemReminder: () => {},
    appendSystemReminderAndReport: () => true,
    resetSrCount: () => {},
    completeTurn: async () => {},
    writeTelemetry: () => {},
    flushMeridianTurn: () => {},
    onGoalIteration,
  })
  return { ctrl, tracker }
}

function checkParams(): GoalCheckParams {
  return {
    streamedText: 'did some work, continuing',
    estimatedTokens: 1000,
    isAborted: false,
    turn: 1,
    callbacks: {} as GoalCheckParams['callbacks'],
    signal: new AbortController().signal,
  }
}

describe('goal-iteration hook (#463)', () => {
  it('handleGoalCheck 在 shouldContinue 时调用 onGoalIteration，且 iteration 已递增', async () => {
    const seen: number[] = []
    const { ctrl, tracker } = makeController((t) => { seen.push(t.getIteration()) })

    const result = await ctrl.handleGoalCheck(checkParams())

    assert.equal(result.kind, 'continue')
    assert.equal(tracker.getIteration(), 1, 'tracker 推进了一轮')
    assert.deepEqual(seen, [1], '钩子被调用一次，调用时 iteration=1')
  })

  it('连续两轮各触发一次，iteration 逐轮递增', async () => {
    const seen: number[] = []
    const { ctrl } = makeController((t) => { seen.push(t.getIteration()) })

    await ctrl.handleGoalCheck(checkParams())
    await ctrl.handleGoalCheck(checkParams())

    assert.deepEqual(seen, [1, 2], '每轮 advanceIteration 后都触发钩子')
  })

  it('不传 onGoalIteration 时行为不变（CLI/TUI 路径）', async () => {
    const { ctrl, tracker } = makeController()

    const result = await ctrl.handleGoalCheck(checkParams())

    assert.equal(result.kind, 'continue')
    assert.equal(tracker.getIteration(), 1, 'iteration 照常推进，不抛异常')
  })
})
