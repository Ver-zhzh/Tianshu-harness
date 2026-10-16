import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planConvergenceEmit, type ConvergenceEmitState } from '../convergence-emit-gate.js'

/*
 * convergence 发射门的行为覆盖（2026-10-17 补，模块此前零测试）。
 *
 * 来源：issue #502 误告调查（会话 20261016a569949ff589——「plan 阶段近 86 轮
 * 进度信号弱」1.5 小时内 6 次收敛事件 + 16 张改道卡）。发射门的 Layer 2
 * 语义（2026-10-05，会话 74f350c9 事故）在此固化：
 * - 墙钟下限（默认 45s）拦住"只读诊断轮冷却极短"造成的同变体连发；
 * - level 升级刻意穿透墙钟（真实信号跃迁不容延迟）。
 *
 * 已知边界（本调查发现，未改实现）：分数长期停滞时，L2→L3 可能仅因 turn
 * 跨过 tier.nHigh 门槛（score 恒定）——"机械升级"与真实跃迁同权穿透。
 * 修复归属判定层；届时本条「升级穿透」用例应拆分为「信号型穿透 / 门槛型不穿透」。
 */

function state(over: Partial<ConvergenceEmitState> = {}): ConvergenceEmitState {
  return {
    lastEmitTurn: 40,
    lastEmitLevel: 2,
    lastMsgKey: 'stall',
    lastEmitScore: 0.06,
    lastEmitVerifyFailStreak: 0,
    lastEmitAtMs: 1_000_000,
    cooldownTurns: 3,
    minIntervalMs: 45_000,
    ...over,
  }
}

const base = {
  shouldKick: true,
  injectedMessage: 'guidance',
  messageVariant: 'stall',
  score: 0.06,
  turn: 86,
  userMessageConsumed: false,
  verifyFailStreak: 0,
  // 默认 kick 级；用例按需覆盖（如 level: 3）。此前 base 不含 level 时，
  // 新增用例若忘传会直接吃 typecheck 必填字段报错（曾发生一次）——默认值
  // 收进 base 后该族遗漏在结构上不可能复发。
  level: 2,
}

test('门槛型升级受墙钟约束：L2→L3 仅因轮数越门槛（score 持平）不再穿透', () => {
  // 2026-10-17 修复 A 实测依据（会话 20261016a569949ff589）：
  // seq 16949 L2(0.06) → seq 17436 L3(0.06) 间隔 34 秒——升级只因 turn 越过
  // tier.nHigh，分数零变化。此类"机械升级"不再穿透 45s 墙钟。
  const s = state({ lastEmitLevel: 2, lastEmitScore: 0.06, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, level: 3, score: 0.06, nowMs: 1_000_000 + 34_000, state: s })
  assert.ok(plan)
  assert.equal(plan.escalated, true, '构造校验：level 3 > lastEmitLevel 2，确实被判 escalation')
  assert.equal(plan.emit, false, '分数未变差的升级（门槛型）不得穿透 45s 墙钟下限')
  assert.equal(plan.suppressedBy, 'wall-clock')
})

test('信号型升级（score 骤降 >0.15）仍穿透墙钟——真跃迁保持 Layer 2 语义', () => {
  const s = state({ lastEmitLevel: 2, lastEmitScore: 0.39, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, level: 3, score: 0.06, nowMs: 1_000_000 + 10_000, state: s })
  assert.ok(plan)
  assert.equal(plan.escalated, true)
  assert.equal(plan.emit, true, 'score 骤降伴随升级 = 真信号跃迁，不受墙钟约束')
})

test('门槛型升级 + 墙钟已过 → 正常发射（保留探测节奏，非永久静音）', () => {
  const s = state({ lastEmitLevel: 2, lastEmitScore: 0.06, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, level: 3, score: 0.06, nowMs: 1_000_000 + 60_000, state: s })
  assert.ok(plan)
  assert.equal(plan.emit, true)
})

test('信号型升级穿透轮次冷却：冷却未到（cooldownTurns 999）仍发射', () => {
  const s = state({ lastEmitLevel: 1, lastEmitScore: 0.39, lastEmitAtMs: 1_000_000, cooldownTurns: 999 })
  const plan = planConvergenceEmit({ ...base, level: 2, score: 0.06, nowMs: 1_000_000 + 46_000, state: s })
  assert.ok(plan)
  assert.equal(plan.escalated, true)
  assert.equal(plan.emit, true, 'score 骤降伴随升级：轮次冷却未到仍应发射')
})

test('墙钟下限拦住区间内的同变体重复发射（Layer 2 主场景）', () => {
  const s = state({ lastEmitTurn: 40, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, turn: 41, nowMs: 1_000_000 + 10_000, state: s })
  assert.ok(plan)
  assert.equal(plan.escalated, false)
  assert.equal(plan.emit, false)
  assert.equal(plan.suppressedBy, 'wall-clock')
})

test('正常冷却到期 + 墙钟已过 → 发射', () => {
  const s = state({ lastEmitTurn: 40, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, turn: 44, nowMs: 1_000_000 + 60_000, state: s })
  assert.ok(plan)
  assert.equal(plan.escalated, false)
  assert.equal(plan.emit, true)
})

test('用户刚介入 → 不补刀', () => {
  const s = state()
  const plan = planConvergenceEmit({ ...base, level: 2, nowMs: 1_000_000 + 60_000, userMessageConsumed: true, state: s })
  assert.ok(plan)
  assert.equal(plan.emit, false)
  assert.equal(plan.suppressedBy, 'user-intervention')
})

test('未达 kick / 无注入消息 → 无计划', () => {
  assert.equal(planConvergenceEmit({ ...base, level: 2, shouldKick: false, nowMs: 1_000_000 + 60_000, state: state() }), null)
  assert.equal(planConvergenceEmit({ ...base, level: 2, injectedMessage: null, nowMs: 1_000_000 + 60_000, state: state() }), null)
})

test('边界：escalated 且墙钟恰好到达下限 → 发射（>= 语义）', () => {
  const s = state({ lastEmitLevel: 0, lastEmitAtMs: 1_000_000 })
  const plan = planConvergenceEmit({ ...base, level: 2, nowMs: 1_000_000 + 45_000, state: s })
  assert.ok(plan)
  assert.equal(plan.emit, true)
})
