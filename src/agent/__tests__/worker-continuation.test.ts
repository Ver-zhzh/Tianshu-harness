import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDS_GATE_REPAIR_RESERVE,
  MAX_BUDGET_CONTINUATIONS,
  MAX_HANDS_EXTRA_RUNS,
  buildContinuationObjective,
  decideContinuation,
  decideHandsContinuation,
  markContinued,
  mergeUsage,
  subtractUsage,
  type ContinuationInput,
  type HandsContinuationInput,
} from '../worker-continuation.js'
import type { WorkerResult } from '../work-order.js'

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'blocked',
    summary: 'cut off mid-work',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    failureReason: 'max_turns',
    ...over,
  }
}

function input(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    result: result(),
    attempt: 0,
    aborted: false,
    isWrite: false,
    sharedWorktree: false,
    hasSessionMessages: true,
    ...over,
  }
}

describe('continuation policy is permanently disabled', () => {
  it('legacy limits expose zero additional runs', () => {
    assert.equal(MAX_BUDGET_CONTINUATIONS, 0)
    assert.equal(MAX_HANDS_EXTRA_RUNS, 0)
    assert.equal(HANDS_GATE_REPAIR_RESERVE, 0)
  })
  for (const failureReason of ['max_turns', 'timeout', 'caller_aborted', 'worker_crash', 'json_parse', 'stalled'] as const) {
    it(`${failureReason}: read and write workers cannot automatically continue`, () => {
      const r = result({ failureReason })
      assert.equal(decideContinuation(input({ result: r, productivity: { toolCalls: 99 } })).proceed, false)
      assert.equal(decideHandsContinuation({ result: r, attempt: 0, extraRunsUsed: 0, aborted: false }).proceed, false)
    })
  }
})

describe('buildContinuationObjective', () => {
  it('告诉 worker 这是接着干，并带上原始目标', () => {
    const text = buildContinuationObjective('定位路由接缝', 'max_turns', 1)
    assert.match(text, /第 1 次续跑/)
    assert.match(text, /轮次预算/)
    assert.match(text, /不要重做/)
    assert.match(text, /定位路由接缝/)
  })

  it('区分轮次耗尽与时间耗尽', () => {
    assert.match(buildContinuationObjective('x', 'timeout', 2), /时间预算/)
    assert.doesNotMatch(buildContinuationObjective('x', 'timeout', 2), /轮次预算/)
  })
})

describe('markContinued', () => {
  it('在 risks 上留痕，且幂等', () => {
    const once = markContinued(result({ risks: ['既有风险'] }), 2, 'max_turns')
    assert.equal(once.risks.length, 2)
    assert.match(once.risks[1]!, /budget-continuation/)
    assert.match(once.risks[1]!, /续跑 2 次/)

    const twice = markContinued(once, 2, 'max_turns')
    assert.equal(twice.risks.length, 2, '重复标注不该叠加')
  })

  it('不改动原对象', () => {
    const original = result()
    markContinued(original, 1, 'timeout')
    assert.equal(original.risks.length, 0)
  })
})

describe('mergeUsage', () => {
  it('逐字段累加，缺项按 0 计', () => {
    const merged = mergeUsage({ input_tokens: 10, output_tokens: 3 }, { input_tokens: 5, cache_read_input_tokens: 7 })
    assert.deepEqual(merged, { input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 7 })
  })

  it('任一侧缺席时原样返回另一侧', () => {
    assert.deepEqual(mergeUsage(undefined, { input_tokens: 4 }), { input_tokens: 4 })
    assert.deepEqual(mergeUsage({ input_tokens: 4 }, undefined), { input_tokens: 4 })
    assert.equal(mergeUsage(undefined, undefined), undefined)
  })
})

describe('subtractUsage（usage-ledger 对齐）', () => {
  it('从累计值扣除回种份额，得到本轮净增', () => {
    const total = { input_tokens: 1010, output_tokens: 55, cache_read_input_tokens: 900 }
    const delta = subtractUsage(total, { input_tokens: 1000, output_tokens: 50 })
    assert.deepEqual(delta, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 })
  })

  it('与 mergeUsage 互逆：seed ⊕ delta 还原累计', () => {
    const seed = { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 40 }
    const total = { input_tokens: 2345, output_tokens: 77, cache_creation_input_tokens: 40, cache_read_input_tokens: 2000 }
    const restored = mergeUsage(seed, subtractUsage(total, seed))
    assert.deepEqual(restored, total)
  })

  it('prior 缺席的键保留原值；prior 大于累计时钳 0', () => {
    assert.deepEqual(
      subtractUsage({ input_tokens: 5, output_tokens: 2 }, { input_tokens: 10 }),
      { input_tokens: 0, output_tokens: 2 },
    )
  })

  it('total 缺席返回空对象（零账）', () => {
    assert.deepEqual(subtractUsage(undefined, { input_tokens: 3 }), {})
  })
})
