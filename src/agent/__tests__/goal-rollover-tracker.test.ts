/**
 * Goal 上下文接力 —— tracker / continuation 侧契约。
 * - 启用接力且还有会话名额：估算上下文 ≥ ratio × 窗口 → reason 'context_rollover'；
 * - 名额用尽退回旧语义（95% 才 context_limit），不会无限接力；
 * - continuation 把它落成 paused + GOAL_ROLLOVER_REASON（非失败），并 finalize；
 * - 配置随 toRecord/fromRecord 持久化；normalizeRolloverConfig 夹紧非法值。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GoalTracker, GOAL_ROLLOVER_REASON, normalizeRolloverConfig } from '../goal-tracker.js'
import { GoalContinuationController } from '../goal-continuation.js'

const WINDOW = 100_000
function tracker(rollover?: { ratio: number; maxSessions: number; generation: number }) {
  return new GoalTracker({ goal: 'ship it', maxIterations: 20, contextWindow: WINDOW, ...(rollover ? { rollover } : {}) })
}

describe('GoalTracker rollover', () => {
  it('未启用：50% 照常 continue，95% 才 context_limit（旧行为不变）', () => {
    const t = tracker()
    assert.equal(t.check('working', 60_000, false).reason, 'continue')
    assert.equal(t.check('working', 96_000, false).reason, 'context_limit')
  })

  it('启用：到达 ratio 返回 context_rollover，阈值以下 continue', () => {
    const t = tracker({ ratio: 0.5, maxSessions: 3, generation: 1 })
    assert.equal(t.check('working', 49_999, false).reason, 'continue')
    const r = t.check('working', 50_000, false)
    assert.equal(r.reason, 'context_rollover')
    assert.equal(r.shouldContinue, false)
  })

  it('名额用尽（generation === maxSessions）退回 95% 暂停语义', () => {
    const t = tracker({ ratio: 0.5, maxSessions: 3, generation: 3 })
    assert.equal(t.check('working', 80_000, false).reason, 'continue')
    assert.equal(t.check('working', 96_000, false).reason, 'context_limit')
  })

  it('GOAL ACHIEVED 优先于接力', () => {
    const t = tracker({ ratio: 0.5, maxSessions: 3, generation: 1 })
    assert.equal(t.check('GOAL ACHIEVED', 90_000, false).reason, 'achieved')
  })

  it('toRecord/fromRecord 保留接力配置', () => {
    const t = tracker({ ratio: 0.6, maxSessions: 4, generation: 2 })
    const back = GoalTracker.fromRecord(t.toRecord())
    assert.deepEqual(back.getRollover(), { ratio: 0.6, maxSessions: 4, generation: 2 })
    assert.equal(GoalTracker.fromRecord(tracker().toRecord()).getRollover(), undefined)
  })

  it('normalizeRolloverConfig：缺省/非法 → undefined，越界夹紧', () => {
    assert.equal(normalizeRolloverConfig(undefined), undefined)
    assert.equal(normalizeRolloverConfig('yes'), undefined)
    assert.equal(normalizeRolloverConfig({ maxSessions: 1 }), undefined, '只有 1 个会话 = 不接力')
    assert.deepEqual(normalizeRolloverConfig({}), { ratio: 0.5, maxSessions: 5, generation: 1 })
    assert.deepEqual(normalizeRolloverConfig({ ratio: 0.99, maxSessions: 999 }), { ratio: 0.9, maxSessions: 20, generation: 1 })
    assert.deepEqual(normalizeRolloverConfig({ ratio: 0.01, maxSessions: 2.7 }), { ratio: 0.2, maxSessions: 2, generation: 1 })
  })
})

describe('GoalContinuationController rollover', () => {
  function ctrl(t: GoalTracker, tokens: number) {
    return new GoalContinuationController({
      getGoalTracker: () => t,
      getStreamedText: () => '正在修改文件',
      getEstimatedTokens: () => tokens,
      getSessionId: () => undefined,
      getCwd: () => '/tmp',
      appendSystemReminder: () => {},
      appendSystemReminderAndReport: () => true,
      resetSrCount: () => {},
      completeTurn: async () => {},
      writeTelemetry: () => {},
      flushMeridianTurn: () => {},
    })
  }
  const params = (tokens: number) => ({
    streamedText: '正在修改文件', estimatedTokens: tokens, isAborted: false, turn: 1,
    callbacks: {} as never, signal: new AbortController().signal,
  })

  it('到阈值：goal 暂停（非 blocked/complete），terminalReason 为接力信号，finalize 不续跑', async () => {
    const t = tracker({ ratio: 0.5, maxSessions: 3, generation: 1 })
    const res = await ctrl(t, 55_000).handleGoalCheck(params(55_000))
    assert.equal(res.kind, 'finalize')
    assert.equal(t.getStatus(), 'paused')
    assert.equal(t.getTerminalReason(), GOAL_ROLLOVER_REASON)
    assert.equal(t.getIteration(), 0, '接力不消耗迭代')
  })
})
