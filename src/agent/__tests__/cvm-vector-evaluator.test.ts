/**
 * CVM-vector evaluator（v3.1 计划 Wave 1-2）— 条件矩阵 + 反证测试。
 *
 * 覆盖计划的反证清单：让位矩阵各层（obligation gate / control-plane gate /
 * 压力 / convergence 发射 / scout 所有权 / 专用 hook pending / 同星 CCR
 * pending）、缺数据不假阳性、确定性、冷却、真实 AdvisoryExpectation 形状。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCvmVectorEvaluator,
  cvmVectorMode,
  CVM_REPETITION_THRESHOLD,
  CVM_VECTOR_RULE_COOLDOWN_TURNS,
  type CvmVectorInput,
} from '../hooks/cognitive-capsule-router.js'
import { emptyObligationStore, type EvidenceObligation, type ObligationStore } from '../evidence-obligation.js'
import type { CaseOpenSignal } from '../case-open-signals.js'

function obligation(partial: Partial<EvidenceObligation>): EvidenceObligation {
  return {
    id: 'ob-1',
    family: 'behavior',
    claim: 'x',
    targets: [],
    risk: 'medium',
    requiredAction: 'targeted_verification',
    state: 'open',
    attempts: 0,
    evidenceRefs: [],
    ...partial,
  }
}

function storeWith(...obs: EvidenceObligation[]): ObligationStore {
  return { obligations: obs }
}

/** 基线输入：一切健康，任何规则都不该触发。 */
function healthyInput(overrides: Partial<CvmVectorInput> = {}): CvmVectorInput {
  return {
    turn: 10,
    phaseClass: 'execute',
    convergence: { score: 0.9, level: 0, textRepetitionPenalty: 1.0, oscillationPenalty: 1.0 },
    pressure: { ratio: 0.3, cvmOverheadRatio: 0.01, thrashing: false, shouldThrottleCvm: false, hardCeiling: false },
    obligations: emptyObligationStore(),
    evidence: { filesModified: 0, deliveryStatus: 'unverified' },
    pendingAdvisoryKeys: [],
    convergenceEmittedRecently: false,
    scoutOwned: false,
    hasDecisionGates: false,
    ...overrides,
  }
}

/** CV2 触发态：重复信号强、无任何让位条件。 */
function stuckInput(overrides: Partial<CvmVectorInput> = {}): CvmVectorInput {
  return healthyInput({
    convergence: { score: 0.4, level: 1, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
    ...overrides,
  })
}

/** CV1 触发态：验证债、无任何让位条件。 */
function debtInput(overrides: Partial<CvmVectorInput> = {}): CvmVectorInput {
  return healthyInput({
    evidence: { filesModified: 3, deliveryStatus: 'unverified' },
    ...overrides,
  })
}

describe('cvmVectorMode 闸门解析', () => {
  it("缺省 shadow；'0'/'off' 关闭；'active' 开放", () => {
    assert.equal(cvmVectorMode({}), 'shadow')
    assert.equal(cvmVectorMode({ RIVET_CVM_VECTOR: '0' }), 'off')
    assert.equal(cvmVectorMode({ RIVET_CVM_VECTOR: 'off' }), 'off')
    assert.equal(cvmVectorMode({ RIVET_CVM_VECTOR: 'active' }), 'active')
    assert.equal(cvmVectorMode({ RIVET_CVM_VECTOR: 'garbage' }), 'shadow')
  })
})

describe('CVM-vector 让位矩阵（单一声音仲裁）', () => {
  it('high-risk open obligation → gate-blocked 分类，永无候选', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      obligations: storeWith(obligation({ risk: 'high', state: 'open' })),
    }))
    assert.equal(d.classification?.kind, 'gate-blocked')
    assert.equal(d.candidate, null)
  })

  it('high-risk attempted 同样让位；satisfied/low 不构成 gate', () => {
    const evA = createCvmVectorEvaluator()
    assert.equal(evA.evaluate(stuckInput({
      obligations: storeWith(obligation({ risk: 'high', state: 'attempted' })),
    })).classification?.kind, 'gate-blocked')
    // satisfied high + open low → 不是 gate，CV2 正常触发
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      obligations: storeWith(
        obligation({ id: 'a', risk: 'high', state: 'satisfied' }),
        obligation({ id: 'b', risk: 'low', state: 'open' }),
      ),
    }))
    assert.equal(d.candidate?.ruleId, 'CV2')
  })

  it('control-plane decision-gate 在场 → gate-blocked，永无候选', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({ hasDecisionGates: true }))
    assert.equal(d.classification?.kind, 'gate-blocked')
    assert.equal(d.candidate, null)
  })

  it('上下文压力（throttle/thrashing/hardCeiling 任一）→ context-pressure 静默分类', () => {
    for (const p of [
      { ratio: 0.9, cvmOverheadRatio: 0.06, thrashing: false, shouldThrottleCvm: true, hardCeiling: false },
      { ratio: 0.9, cvmOverheadRatio: 0.01, thrashing: true, shouldThrottleCvm: false, hardCeiling: false },
      { ratio: 0.9, cvmOverheadRatio: 0.09, thrashing: false, shouldThrottleCvm: false, hardCeiling: true },
    ]) {
      const d = createCvmVectorEvaluator().evaluate(stuckInput({ pressure: p }))
      assert.equal(d.classification?.kind, 'context-pressure')
      assert.equal(d.candidate, null)
    }
  })

  it('convergence 相邻轮已发射 → CV2 让位（yielded to convergence-emit）', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({ convergenceEmittedRecently: true }))
    assert.equal(d.candidate, null)
    assert.deepEqual(d.yielded, { ruleId: 'CV2', to: 'convergence-emit' })
  })

  it('scout 已拥有视角干预 → CV2 让位', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({ scoutOwned: true }))
    assert.equal(d.candidate, null)
    assert.deepEqual(d.yielded, { ruleId: 'CV2', to: 'anchor-break-scout' })
  })

  it('专用 hook 声音 pending（kick/spiral/dead-end/bisect/convergence）→ CV2 让位', () => {
    for (const key of ['dissipative-kick', 'reasoning-spiral', 'dead-end-file', 'regression-bisect', 'convergence', 'capsule-recall']) {
      const d = createCvmVectorEvaluator().evaluate(stuckInput({ pendingAdvisoryKeys: [key] }))
      assert.equal(d.candidate, null, `pending ${key} 时不得发声`)
      assert.equal(d.yielded?.to, key)
    }
  })

  it('同星去重：老 CCR 的 ccr-天璇-* pending → CV2 让位', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({ pendingAdvisoryKeys: ['ccr-天璇-P6'] }))
    assert.equal(d.candidate, null)
    assert.equal(d.yielded?.to, 'ccr-天璇-P6')
  })

  it('CV1 同星去重：ccr-瑶光-*/ccr-天权-* pending → 让位', () => {
    for (const key of ['ccr-瑶光-P1', 'ccr-天权-P7']) {
      const d = createCvmVectorEvaluator().evaluate(debtInput({ pendingAdvisoryKeys: [key] }))
      assert.equal(d.candidate, null, `pending ${key} 时不得发声`)
      assert.equal(d.yielded?.to, key)
    }
  })

  it('CV1 验证声音 pending（self-verify/typecheck-reminder）→ 让位', () => {
    // key 与 VERIFY_YIELD_KEYS 逐项对齐（267a0001e 起 self-verify-hook 的 key
    // 从 self-verify:verification-required 收口为 self-verify）。
    for (const key of ['self-verify', 'self-verify-scope-mismatch', 'typecheck-reminder']) {
      const d = createCvmVectorEvaluator().evaluate(debtInput({ pendingAdvisoryKeys: [key] }))
      assert.equal(d.candidate, null, `pending ${key} 时不得发声`)
      assert.equal(d.yielded?.to, key)
    }
  })
})

describe('CVM-vector 触发与缺数据语义', () => {
  it('CV2：重复信号 + level>=1 + 无让位 → 天璇候选，真实 tool_appears expect', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput())
    assert.equal(d.classification?.kind, 'perspective-locked')
    assert.equal(d.candidate?.star, '天璇')
    assert.equal(d.candidate?.entry.key, 'cvm-vector-天璇-CV2')
    assert.equal(d.candidate?.entry.category, 'star_domain')
    assert.deepEqual(d.candidate?.entry.expect, {
      kind: 'tool_appears',
      tools: ['recall_capsule'],
      targetIncludes: '天璇',
      withinTurns: 3,
    })
  })

  it('CV2：oscillationPenalty 低也触发（两信号任一）', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      convergence: { score: 0.5, level: 1, textRepetitionPenalty: 1.0, oscillationPenalty: 0.3 },
    }))
    assert.equal(d.candidate?.ruleId, 'CV2')
  })

  it('CV2 缺数据不假阳性：convergence null / penalty 中性 1.0 / level 0 都不触发', () => {
    const ev = createCvmVectorEvaluator()
    assert.equal(ev.evaluate(healthyInput({ convergence: null, evidence: { filesModified: 0, deliveryStatus: 'unverified' } })).candidate, null)
    assert.equal(ev.evaluate(healthyInput()).candidate, null)
    const levelZero = createCvmVectorEvaluator().evaluate(stuckInput({
      convergence: { score: 0.6, level: 0, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
    }))
    assert.equal(levelZero.candidate, null, 'level 0 时重复信号单独不足以触发')
  })

  it('CV1：验证债 + 无让位 → 瑶光候选，verify_attempted expect', () => {
    const d = createCvmVectorEvaluator().evaluate(debtInput())
    assert.equal(d.classification?.kind, 'verification-debt')
    assert.equal(d.candidate?.entry.key, 'cvm-vector-瑶光-CV1')
    assert.equal(d.candidate?.entry.expect, undefined)
    assert.equal(d.candidate?.entry.tier, 'informational')
  })

  it('CV1 不触发：无改动 / 已验证 / turn<2', () => {
    assert.equal(createCvmVectorEvaluator().evaluate(healthyInput()).candidate, null)
    assert.equal(createCvmVectorEvaluator().evaluate(debtInput({
      evidence: { filesModified: 3, deliveryStatus: 'verified' },
    })).candidate, null)
    assert.equal(createCvmVectorEvaluator().evaluate(debtInput({ turn: 1 })).candidate, null)
  })

  it('CV2 优先于 CV1（stuck 信号更尖锐）', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      evidence: { filesModified: 3, deliveryStatus: 'unverified' },
    }))
    assert.equal(d.candidate?.ruleId, 'CV2')
  })

  it('阈值常量导出且在 (0,1) 区间（Wave 0 校准入口）', () => {
    assert.ok(CVM_REPETITION_THRESHOLD > 0 && CVM_REPETITION_THRESHOLD < 1)
  })
})

describe('CVM-vector 冷却与确定性', () => {
  it('同规则冷却期内只出分类不出候选，期满恢复', () => {
    const ev = createCvmVectorEvaluator()
    assert.equal(ev.evaluate(debtInput({ turn: 10 })).candidate?.ruleId, 'CV1')
    const inCooldown = ev.evaluate(debtInput({ turn: 11 }))
    assert.equal(inCooldown.candidate, null)
    assert.equal(inCooldown.classification?.kind, 'verification-debt', '冷却期内分类仍如实记录')
    assert.equal(
      ev.evaluate(debtInput({ turn: 10 + CVM_VECTOR_RULE_COOLDOWN_TURNS })).candidate?.ruleId,
      'CV1',
    )
  })

  it('冷却独立 per-rule：CV2 触发不影响 CV1', () => {
    const ev = createCvmVectorEvaluator()
    assert.equal(ev.evaluate(stuckInput({ turn: 10 })).candidate?.ruleId, 'CV2')
    assert.equal(ev.evaluate(debtInput({ turn: 11 })).candidate?.ruleId, 'CV1')
  })

  it('确定性：相同输入（新 evaluator）产出深度相等的 decision', () => {
    const input = stuckInput()
    const d1 = createCvmVectorEvaluator().evaluate(input)
    const d2 = createCvmVectorEvaluator().evaluate(input)
    assert.deepEqual(d1, d2)
  })

  it('evaluate 不 mutation 输入对象', () => {
    const input = stuckInput()
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown
    createCvmVectorEvaluator().evaluate(input)
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot)
  })
})

describe('CV3 攻坚层规则（PAL 计划 v2 Wave P3）', () => {
  it('案件 needs_user → CV3 候选（天机，expect attack_case）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      attack: { activeCases: 1, anyNeedsUser: true, anyStalled: false },
      attackLayerEnabled: true,
    }))
    assert.equal(d.classification?.kind, 'attack-stalled')
    assert.equal(d.candidate?.ruleId, 'CV3')
    assert.equal(d.candidate?.star, '天机')
    assert.equal(d.candidate?.entry.key, 'cvm-vector-天机-CV3')
    assert.deepEqual(d.candidate?.entry.expect, { kind: 'tool_appears', tools: ['attack_case'], withinTurns: 3 })
  })

  it('案件 stalled（连续探针不出信息）→ CV3 候选', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: true },
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV3')
  })

  it('P3 阶梯：有 planned 探针 + 深度空转 → execute-planned 变体（引导 observe，不催新方向）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.3, level: 2, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: true },
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV3')
    assert.equal(d.classification?.facts.variant, 'execute-planned')
    assert.match(d.candidate?.entry.content ?? '', /planned 探针/)
    assert.match(d.candidate?.entry.content ?? '', /observe/)
  })

  it('反证：有 planned 探针但没在空转 → CV3 沉默（回执 L0 建议已覆盖，不重复发声）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: true },
      attackLayerEnabled: true,
    }))
    assert.notEqual(d.classification?.kind, 'attack-stalled')
    assert.notEqual(d.candidate?.ruleId, 'CV3')
  })

  it('反证：浅空转（level 1）不触发 execute-planned（阈值与 CV3-open 同构）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.5, level: 1, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: true },
      attackLayerEnabled: true,
    }))
    assert.notEqual(d.classification?.facts?.variant, 'execute-planned')
  })

  it('无案件 + 深度空转（level≥2 重复）+ 层启用 → CV3-open 建议开案', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.3, level: 2, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
      attack: null,
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV3-open')
    assert.match(d.candidate?.entry.content ?? '', /attack_case open/)
  })

  it('反证：层未启用（RIVET_PAL=off）→ CV3-open 不触发，回落 CV2', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.3, level: 2, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
      attack: null,
      attackLayerEnabled: false,
    }))
    assert.equal(d.candidate?.ruleId, 'CV2', 'PAL 关闭时深度空转仍由 CV2 兜底')
  })

  it('反证：level 1 浅空转不建议开案（留给 CV2），level 2 才升级', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      attack: null,
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV2')
  })

  it('让位矩阵对 CV3 同样生效：gate 在场 → gate-blocked 不发声', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      attack: { activeCases: 1, anyNeedsUser: true, anyStalled: false },
      attackLayerEnabled: true,
      obligations: storeWith(obligation({ risk: 'high', state: 'open' })),
    }))
    assert.equal(d.classification?.kind, 'gate-blocked')
    assert.equal(d.candidate, null)
  })

  it('让位矩阵：专用 hook pending → CV3 让位记录', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: true },
      attackLayerEnabled: true,
      pendingAdvisoryKeys: ['convergence'],
    }))
    assert.equal(d.candidate, null)
    assert.deepEqual(d.yielded, { ruleId: 'CV3', to: 'convergence' })
  })

  it('CV3 优先于 CV2（案件级信号更尖锐）', () => {
    const d = createCvmVectorEvaluator().evaluate(stuckInput({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: true },
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV3')
  })

  it('CV3 冷却：期内只分类不候选', () => {
    const ev = createCvmVectorEvaluator()
    const attackInput = (turn: number) => healthyInput({
      turn,
      attack: { activeCases: 1, anyNeedsUser: true, anyStalled: false },
      attackLayerEnabled: true,
    })
    assert.equal(ev.evaluate(attackInput(10)).candidate?.ruleId, 'CV3')
    const cooled = ev.evaluate(attackInput(11))
    assert.equal(cooled.candidate, null)
    assert.equal(cooled.classification?.kind, 'attack-stalled')
    assert.equal(ev.evaluate(attackInput(10 + CVM_VECTOR_RULE_COOLDOWN_TURNS)).candidate?.ruleId, 'CV3')
  })

  it('反证：健康案件（无 stalled/needs_user）零发声，CV1/CV2 正常评估', () => {
    const d = createCvmVectorEvaluator().evaluate(debtInput({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: false },
      attackLayerEnabled: true,
    }))
    assert.equal(d.candidate?.ruleId, 'CV1', '案件健康时不抢占，验证债正常触发')
  })
})

// ─── W1 开案信号扩展（PAL 第四波）─────────────────────────────────

function openSignal(ref = 'regression-bisect'): CaseOpenSignal {
  return {
    anchor: { kind: 'failure_pattern', ref },
    source: 'regression-bisect',
    summary: '回归语义 + 只读诊断空转',
  }
}

/** L2 停滞但重复 penalty 中性（缺重复证据）——原 CV3-open 条件不满足。 */
function stagnantNoRepetition(overrides: Partial<CvmVectorInput> = {}): CvmVectorInput {
  return healthyInput({
    convergence: { score: 0.4, level: 2, textRepetitionPenalty: 1.0, oscillationPenalty: 1.0 },
    attack: null,
    attackLayerEnabled: true,
    ...overrides,
  })
}

describe('CV3-open 开案信号扩展（W1）', () => {
  it('带锚信号 + L2 停滞（无重复证据）→ CV3-open 触发，文案含锚与 open 骨架', () => {
    const d = createCvmVectorEvaluator().evaluate(stagnantNoRepetition({
      caseOpenSignals: [openSignal()],
    }))
    assert.equal(d.candidate?.ruleId, 'CV3-open')
    assert.match(d.candidate?.entry.content ?? '', /failure_pattern:regression-bisect/)
    assert.match(d.candidate?.entry.content ?? '', /attack_case open \{"anchor"/)
    assert.equal(d.classification?.facts?.caseOpenSignals, 1)
    assert.equal(d.classification?.facts?.firstSignalSource, 'regression-bisect')
  })

  it('反证：无信号且无重复证据 → CV3-open 不触发（不降低原阈值）', () => {
    const d = createCvmVectorEvaluator().evaluate(stagnantNoRepetition())
    assert.notEqual(d.candidate?.ruleId, 'CV3-open')
  })

  it('反证：信号在场但 convergence level < 2 → 不触发（信号不降低 convergence 门）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.8, level: 1, textRepetitionPenalty: 1.0, oscillationPenalty: 1.0 },
      attack: null,
      attackLayerEnabled: true,
      caseOpenSignals: [openSignal()],
    }))
    assert.notEqual(d.candidate?.ruleId, 'CV3-open')
  })

  it('反证：gate 在场时信号也到不了 CV3（让位矩阵第一层先行）', () => {
    const d = createCvmVectorEvaluator().evaluate(stagnantNoRepetition({
      caseOpenSignals: [openSignal()],
      obligations: storeWith(obligation({ risk: 'high', state: 'open' })),
    }))
    assert.equal(d.classification?.kind, 'gate-blocked')
    assert.equal(d.candidate, null)
  })

  it('反证：有活跃健康案件时信号不触发开案（open 只服务无案件场景）', () => {
    const d = createCvmVectorEvaluator().evaluate(stagnantNoRepetition({
      attack: { activeCases: 1, anyNeedsUser: false, anyStalled: false },
      caseOpenSignals: [openSignal()],
    }))
    assert.notEqual(d.candidate?.ruleId, 'CV3-open')
  })

  it('二次送达：同锚跨冷却第二发挂 observe（到期强制送达）；首发即时', () => {
    const ev = createCvmVectorEvaluator()
    const first = ev.evaluate(stagnantNoRepetition({ turn: 10, caseOpenSignals: [openSignal()] }))
    assert.equal(first.candidate?.ruleId, 'CV3-open')
    assert.equal(first.candidate?.entry.observe, undefined)
    assert.equal(first.classification?.facts?.secondChallenge, undefined)
    const second = ev.evaluate(stagnantNoRepetition({
      turn: 10 + CVM_VECTOR_RULE_COOLDOWN_TURNS,
      caseOpenSignals: [openSignal()],
    }))
    assert.equal(second.candidate?.ruleId, 'CV3-open')
    assert.deepEqual(second.candidate?.entry.observe, { turns: 2 })
    assert.equal(second.classification?.facts?.secondChallenge, true)
  })

  it('反证：换锚的第二发不是 second challenge（per-anchor 语义）', () => {
    const ev = createCvmVectorEvaluator()
    ev.evaluate(stagnantNoRepetition({ turn: 10, caseOpenSignals: [openSignal('a')] }))
    const second = ev.evaluate(stagnantNoRepetition({
      turn: 10 + CVM_VECTOR_RULE_COOLDOWN_TURNS,
      caseOpenSignals: [openSignal('b')],
    }))
    assert.equal(second.candidate?.ruleId, 'CV3-open')
    assert.equal(second.candidate?.entry.observe, undefined)
  })

  it('无信号的纯重复 CV3-open 保持原文案（无锚骨架，不带 observe）', () => {
    const d = createCvmVectorEvaluator().evaluate(healthyInput({
      convergence: { score: 0.3, level: 2, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
      attack: null,
      attackLayerEnabled: true,
      caseOpenSignals: [],
    }))
    assert.equal(d.candidate?.ruleId, 'CV3-open')
    assert.match(d.candidate?.entry.content ?? '', /深度空转/)
    assert.equal(d.candidate?.entry.observe, undefined)
  })
})
