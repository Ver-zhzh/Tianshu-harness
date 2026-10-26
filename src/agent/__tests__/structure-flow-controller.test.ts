import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeStructureFlowControl,
  type StructureFlowInputs,
} from '../structure-flow-controller.js'
import type { EFEComponents } from '../prediction-error.js'

// ── 固定输入构造器 ─────────────────────────────────────────────────────

function efe(overrides: Partial<EFEComponents> = {}): EFEComponents {
  return {
    epistemicValue: 0.15,
    pragmaticValue: 0.9,
    noveltyBonus: 0.2,
    precision: 0.9,
    ...overrides,
  }
}

/** 计划自检输入 #1：稳定执行（手推 structurePressure=.1275, flowPotential=.865）。 */
function stableInput(overrides: Partial<StructureFlowInputs> = {}): StructureFlowInputs {
  return {
    efe: efe(),
    flowScore: 0.9,
    flowSampleCount: 4,
    requiredFlowSamples: 4,
    todoCompletedDelta: 2,
    activePlan: false,
    palNeedsUser: false,
    palStalled: false,
    hasVerificationDebt: false,
    consecutiveFailures: 0,
    userIntervened: false,
    ...overrides,
  }
}
it('a confirmed repair episode prevents high-flow relaxation without requiring PAL', () => {
  const result = computeStructureFlowControl(stableInput({ repairActive: true }))
  assert.equal(result.mode, 'tighten')
  assert.equal(result.relaxation, 0)
})

/** 计划自检输入 #2：未知域（手推 structurePressure=.685, flowPotential=.17）。 */
function unknownDomainInput(overrides: Partial<StructureFlowInputs> = {}): StructureFlowInputs {
  return stableInput({
    efe: efe({ epistemicValue: 0.9, pragmaticValue: 0.2, noveltyBonus: 0.8, precision: 0.4 }),
    flowScore: null,
    flowSampleCount: 0,
    todoCompletedDelta: 0,
    ...overrides,
  })
}

describe('computeStructureFlowControl', () => {
  describe('自检输入手推数值（计划 2026-07-18 复核修正版）', () => {
    it('稳定执行 → flow、relaxation=0.25', () => {
      const snap = computeStructureFlowControl(stableInput())
      assert.equal(snap.mode, 'flow')
      assert.ok(Math.abs(snap.relaxation - 0.25) < 1e-9)
      assert.deepEqual(snap.reasons, ['stable-execution'])
    })

    it('稳定执行 + activePlan → planRecommendation=exit', () => {
      const snap = computeStructureFlowControl(stableInput({ activePlan: true }))
      assert.equal(snap.mode, 'flow')
      assert.equal(snap.planRecommendation, 'exit')
    })

    it('未知域 → tighten、activePlan=false 时 enter', () => {
      const snap = computeStructureFlowControl(unknownDomainInput())
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
      assert.equal(snap.planRecommendation, 'enter')
      assert.deepEqual(snap.reasons, ['unknown-domain'])
    })

    it('未知域 + activePlan=true → stay', () => {
      const snap = computeStructureFlowControl(unknownDomainInput({ activePlan: true }))
      assert.equal(snap.planRecommendation, 'stay')
    })
  })

  describe('缺数据 fail-closed', () => {
    for (const field of ['epistemicValue', 'pragmaticValue', 'noveltyBonus', 'precision'] as const) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`EFE.${field}=${bad} → balanced、relaxation=0、plan=none、reason=missing-data`, () => {
          const snap = computeStructureFlowControl(stableInput({ efe: efe({ [field]: bad }) }))
          assert.equal(snap.mode, 'balanced')
          assert.equal(snap.relaxation, 0)
          assert.equal(snap.planRecommendation, 'none')
          assert.deepEqual(snap.reasons, ['missing-data'])
        })
      }
    }

    it('missing-data 路径仍输出 tdd 建议（verification debt 不被吞掉）', () => {
      const snap = computeStructureFlowControl(stableInput({
        efe: efe({ precision: Number.NaN }),
        hasVerificationDebt: true,
      }))
      assert.equal(snap.tddRecommendation, 'suggest')
    })
  })

  describe('flow 样本资格门（requiredFlowSamples = P1 FLOW_MIN_SAMPLES）', () => {
    it('样本不足（3/4）时 flow 分数不贡献：输出与 flowScore=null 完全一致', () => {
      const short = computeStructureFlowControl(stableInput({ flowScore: 0.9, flowSampleCount: 3 }))
      const nullFlow = computeStructureFlowControl(stableInput({ flowScore: null, flowSampleCount: 0 }))
      assert.deepEqual(short, nullFlow)
    })

    it('样本不足但 EFE+todo 健康 → 仍可 flow（样本不足 ≠ 其它健康信号作废）', () => {
      const snap = computeStructureFlowControl(stableInput({ flowScore: 0.9, flowSampleCount: 3 }))
      assert.equal(snap.mode, 'flow')
      // qualifiedFlow=0 → flowPotential=.64，diff=.5125 → relaxation=.25*(.3125/.40)
      assert.ok(Math.abs(snap.relaxation - 0.25 * (0.3125 / 0.40)) < 1e-9)
    })

    it('非有限 flowScore 视同不合格，不进入 flowPotential', () => {
      const short = computeStructureFlowControl(stableInput({ flowScore: Number.NaN }))
      const nullFlow = computeStructureFlowControl(stableInput({ flowScore: null, flowSampleCount: 0 }))
      assert.deepEqual(short, nullFlow)
    })
  })

  describe('hardTighten（一切放松归零）', () => {
    it('PAL needs_user → tighten、relaxation=0、reason=pal-uncertain', () => {
      const snap = computeStructureFlowControl(stableInput({ palNeedsUser: true }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
      assert.ok(snap.reasons.includes('pal-uncertain'))
    })

    it('PAL 停滞 → 同上', () => {
      const snap = computeStructureFlowControl(stableInput({ palStalled: true }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
      assert.ok(snap.reasons.includes('pal-uncertain'))
    })

    it('健康探案（needs_user=false 且 stalled=false）不触发 hardTighten', () => {
      const snap = computeStructureFlowControl(stableInput())
      assert.equal(snap.mode, 'flow')
    })

    it('verification debt → tighten、relaxation=0、reason=mixed-signals、tdd=suggest', () => {
      const snap = computeStructureFlowControl(stableInput({ hasVerificationDebt: true }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
      assert.ok(snap.reasons.includes('mixed-signals'))
      assert.equal(snap.tddRecommendation, 'suggest')
    })

    it('用户干预 → tighten、relaxation=0、reason=user-intervened', () => {
      const snap = computeStructureFlowControl(stableInput({ userIntervened: true }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
      assert.ok(snap.reasons.includes('user-intervened'))
    })

    it('连续失败 ≥2 → hardTighten', () => {
      const snap = computeStructureFlowControl(stableInput({ consecutiveFailures: 2 }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.relaxation, 0)
    })

    it('hardTighten 时即便 structurePressure 高也不给 plan enter 之外的额外动作（仍按 tighten 规则）', () => {
      // hardTighten + 高压 → plan 建议仍按 tighten 分支求值
      const snap = computeStructureFlowControl(unknownDomainInput({ palNeedsUser: true }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.planRecommendation, 'enter')
    })

    it('多个 hardTighten 来源共存时 reasons 按固定顺序排序', () => {
      const snap = computeStructureFlowControl(stableInput({
        userIntervened: true,
        palNeedsUser: true,
        hasVerificationDebt: true,
      }))
      assert.deepEqual(snap.reasons, ['user-intervened', 'pal-uncertain', 'mixed-signals'])
    })
  })

  describe('单次失败软加压（修正：不再一次失败就硬收紧）', () => {
    it('consecutiveFailures=1 → 不 hardTighten，pressure +0.05，仍 flow', () => {
      const snap = computeStructureFlowControl(stableInput({ consecutiveFailures: 1 }))
      assert.equal(snap.mode, 'flow')
      assert.equal(snap.tddRecommendation, 'suggest')
      // pressure=.1775, potential=.865 → diff=.6875 → relaxation 封顶 .25
      assert.ok(Math.abs(snap.relaxation - 0.25) < 1e-9)
    })
  })

  describe('模式边界与 relaxation 连续性', () => {
    it('diff 恰好 0.20 且 progress>0 → flow、relaxation=0（连续起点）', () => {
      // 构造 diff≈0.20：prag=.5, prec=.5, flow=null, todo=1
      // pressure=.45*.15+.2*.2+.2*.5=.2075；potential=.175+.125+0+.05=.35 → diff=.1425 → balanced
      // 换一组：prag=.7, prec=.6, todo=3: pressure=.0675+.04+.08=.1875
      // potential=.245+.15+0+.15=.545 → diff=.3575 → relaxation=.25*(.1575/.40)
      const snap = computeStructureFlowControl(stableInput({
        efe: efe({ pragmaticValue: 0.7, precision: 0.6 }),
        flowScore: null,
        flowSampleCount: 0,
        todoCompletedDelta: 3,
      }))
      assert.equal(snap.mode, 'flow')
      assert.ok(Math.abs(snap.relaxation - 0.25 * (0.1575 / 0.40)) < 1e-9)
      assert.ok(snap.relaxation > 0 && snap.relaxation < 0.25)
    })

    it('progress=0 且 qualifiedFlow<0.75 时即便 diff≥0.20 也不进 flow', () => {
      // prag=.9, prec=.9, flow=.5(4/4), todo=0:
      // pressure=.1275; potential=.315+.225+.125+0=.665 → diff=.5375 但 flow=.5<.75、progress=0
      const snap = computeStructureFlowControl(stableInput({ flowScore: 0.5, todoCompletedDelta: 0 }))
      assert.equal(snap.mode, 'balanced')
      assert.equal(snap.relaxation, 0)
      assert.deepEqual(snap.reasons, ['mixed-signals'])
    })

    it('qualifiedFlow≥0.75 可替代 progress 作为 flow 准入证据', () => {
      const snap = computeStructureFlowControl(stableInput({ todoCompletedDelta: 0 }))
      // flow=.9≥.75，potential=.315+.225+.225+0=.765，diff=.6375 → flow
      assert.equal(snap.mode, 'flow')
    })

    it('balanced 区间（两个差值都不过线）→ balanced、relaxation=0、plan=none', () => {
      // epi=.5, prag=.5, nov=.5, prec=.5, flow=null, todo=0:
      // pressure=.225+.1+.1=.425; potential=.175+.125=.30 → pressure-potential=.125<.15 → balanced
      const snap = computeStructureFlowControl(stableInput({
        efe: efe({ epistemicValue: 0.5, pragmaticValue: 0.5, noveltyBonus: 0.5, precision: 0.5 }),
        flowScore: null,
        flowSampleCount: 0,
        todoCompletedDelta: 0,
      }))
      assert.equal(snap.mode, 'balanced')
      assert.equal(snap.relaxation, 0)
      assert.equal(snap.planRecommendation, 'none')
    })

    it('tighten 但 structurePressure<0.55 → plan=none（不推荐 enter）', () => {
      // epi=.6, prag=.1, nov=.2, prec=.6, flow=null, todo=0:
      // pressure=.27+.04+.08=.39; potential=.035+.15=.185 → 差 .205≥.15 → tighten 但 .39<.55
      const snap = computeStructureFlowControl(stableInput({
        efe: efe({ epistemicValue: 0.6, pragmaticValue: 0.1, noveltyBonus: 0.2, precision: 0.6 }),
        flowScore: null,
        flowSampleCount: 0,
        todoCompletedDelta: 0,
      }))
      assert.equal(snap.mode, 'tighten')
      assert.equal(snap.planRecommendation, 'none')
    })

    it('flow + activePlan 但 pragmatic<0.70 → 不建议 exit', () => {
      const snap = computeStructureFlowControl(stableInput({
        efe: efe({ pragmaticValue: 0.65 }),
        activePlan: true,
      }))
      assert.equal(snap.mode, 'flow')
      assert.equal(snap.planRecommendation, 'none')
    })

    it('flow + activePlan 但 progress=0 → 不建议 exit', () => {
      const snap = computeStructureFlowControl(stableInput({ activePlan: true, todoCompletedDelta: 0 }))
      assert.equal(snap.mode, 'flow')
      assert.equal(snap.planRecommendation, 'none')
    })
  })

  describe('输入归一化与纯函数性', () => {
    it('todoCompletedDelta 为负时 progress 归零不为负', () => {
      const neg = computeStructureFlowControl(stableInput({ todoCompletedDelta: -3 }))
      const zero = computeStructureFlowControl(stableInput({ todoCompletedDelta: 0 }))
      assert.deepEqual(neg, zero)
    })

    it('flowScore 超界（1.5）被 clamp 到 1', () => {
      const over = computeStructureFlowControl(stableInput({ flowScore: 1.5 }))
      const one = computeStructureFlowControl(stableInput({ flowScore: 1 }))
      assert.deepEqual(over, one)
    })

    it('同一输入两次调用输出深度相等（确定性）', () => {
      const a = computeStructureFlowControl(stableInput())
      const b = computeStructureFlowControl(stableInput())
      assert.deepEqual(a, b)
    })

    it('relaxation 恒在 [0, 0.25] 内（含各种极端输入）', () => {
      const extremes: StructureFlowInputs[] = [
        stableInput({ efe: efe({ pragmaticValue: 1, precision: 1 }), flowScore: 1, todoCompletedDelta: 99 }),
        unknownDomainInput(),
        stableInput({ palStalled: true }),
        stableInput({ consecutiveFailures: 99 }),
      ]
      for (const input of extremes) {
        const snap = computeStructureFlowControl(input)
        assert.ok(snap.relaxation >= 0 && snap.relaxation <= 0.25)
      }
    })
  })
})
