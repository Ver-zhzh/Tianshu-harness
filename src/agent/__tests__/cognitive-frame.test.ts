import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleCognitiveFrame,
  projectStructureFlowInputs,
  type CognitiveFrameInput,
} from '../cognitive-frame.js'
import { computeStructureFlowControl } from '../structure-flow-controller.js'
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

function frameInput(overrides: Partial<CognitiveFrameInput> = {}): CognitiveFrameInput {
  return {
    turn: 8,
    phaseClass: 'explore',
    efe: efe(),
    sensorium: { momentum: 1, momentumHasData: true, stability: 1 },
    flow: { score: 0.9, sampleCount: 4, requiredSamples: 4 },
    pal: { activeCases: 0, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: false },
    evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 0 },
    user: { intervened: false },
    plan: { activePlanFile: false, planModeState: 'off' },
    progress: { todoCompletedDelta: 2 },
    ...overrides,
  }
}

describe('assembleCognitiveFrame', () => {
  describe('确定性与 fingerprint', () => {
    it('同输入、不同对象引用 → 深相等 frame + 同 fingerprint', () => {
      const a = assembleCognitiveFrame(frameInput())
      const b = assembleCognitiveFrame(frameInput({ efe: { ...efe() } }))
      assert.deepEqual(a, b)
      assert.equal(a.inputFingerprint, b.inputFingerprint)
    })

    it('改变任一事实 → fingerprint 变化', () => {
      const base = assembleCognitiveFrame(frameInput())
      const variants = [
        frameInput({ turn: 9 }),
        frameInput({ phaseClass: 'execute' }),
        frameInput({ efe: efe({ epistemicValue: 0.16 }) }),
        frameInput({ sensorium: { momentum: 0.5, momentumHasData: true, stability: 1 } }),
        frameInput({ flow: { score: 0.8, sampleCount: 4, requiredSamples: 4 } }),
        frameInput({ pal: { activeCases: 1, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: true } }),
        frameInput({ evidence: { hasVerificationDebt: true, deliveryStatus: 'failed', consecutiveFailures: 1 } }),
        frameInput({ user: { intervened: true } }),
        frameInput({ plan: { activePlanFile: true, planModeState: 'planning' } }),
        frameInput({ progress: { todoCompletedDelta: 0 } }),
      ]
      for (const v of variants) {
        const f = assembleCognitiveFrame(v)
        assert.notEqual(f.inputFingerprint, base.inputFingerprint,
          `变体应产生不同 fingerprint: ${JSON.stringify(v).slice(0, 80)}`)
      }
    })

    it('fingerprint 稳定：连续两次装配同值（无时间戳/随机成分）', () => {
      const input = frameInput()
      const first = assembleCognitiveFrame(input).inputFingerprint
      const second = assembleCognitiveFrame(input).inputFingerprint
      assert.equal(first, second)
    })

    it('frame 不含控制结果字段（relaxation / planRecommendation / mode）', () => {
      const serialized = JSON.stringify(assembleCognitiveFrame(frameInput()))
      for (const banned of ['relaxation', 'planRecommendation', 'tddRecommendation', '"mode"']) {
        assert.ok(!serialized.includes(banned), `frame 不得含控制结果: ${banned}`)
      }
    })

    it('深拷贝隔离：装配后修改输入对象不影响 frame', () => {
      const input = frameInput()
      const frame = assembleCognitiveFrame(input)
      input.efe!.epistemicValue = 0.99
      input.pal!.anyNeedsUser = true
      assert.equal(frame.facts.efe!.epistemicValue, 0.15)
      assert.equal(frame.facts.pal!.anyNeedsUser, false)
    })

    it('v=2 schema 版本恒在', () => {
      assert.equal(assembleCognitiveFrame(frameInput()).v, 2)
    })
  })

  describe('质量语义（fail-closed）', () => {
    it('全量健康输入 → 全 source measured', () => {
      const frame = assembleCognitiveFrame(frameInput())
      for (const source of ['efe', 'sensorium', 'flow', 'pal', 'evidence', 'user', 'plan', 'progress'] as const) {
        assert.equal(frame.quality[source], 'measured', `${source} 应为 measured`)
      }
    })

    it('efe=null → missing；任一分量非有限 → vacuous', () => {
      assert.equal(assembleCognitiveFrame(frameInput({ efe: null })).quality.efe, 'missing')
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const frame = assembleCognitiveFrame(frameInput({ efe: efe({ precision: bad }) }))
        assert.equal(frame.quality.efe, 'vacuous')
      }
    })

    it('sensorium=null → missing；momentumHasData=false → partial', () => {
      assert.equal(assembleCognitiveFrame(frameInput({ sensorium: null })).quality.sensorium, 'missing')
      const noData = assembleCognitiveFrame(frameInput({
        sensorium: { momentum: 0, momentumHasData: false, stability: 1 },
      }))
      assert.equal(noData.quality.sensorium, 'partial')
    })

    it('flow score=null → missing；样本不足 → partial', () => {
      const missing = assembleCognitiveFrame(frameInput({ flow: { score: null, sampleCount: 0, requiredSamples: 4 } }))
      assert.equal(missing.quality.flow, 'missing')
      const short = assembleCognitiveFrame(frameInput({ flow: { score: 0.9, sampleCount: 3, requiredSamples: 4 } }))
      assert.equal(short.quality.flow, 'partial')
    })

    it('pal=null（无案件）→ missing，不伪装成 measured', () => {
      assert.equal(assembleCognitiveFrame(frameInput({ pal: null })).quality.pal, 'missing')
    })

    it('一个 source 缺失不抹掉其它 source 的质量', () => {
      const frame = assembleCognitiveFrame(frameInput({ efe: null, sensorium: null }))
      assert.equal(frame.quality.efe, 'missing')
      assert.equal(frame.quality.sensorium, 'missing')
      assert.equal(frame.quality.evidence, 'measured')
      assert.equal(frame.quality.progress, 'measured')
    })
  })
})

describe('projectStructureFlowInputs', () => {
  it('健康 frame → 投影输出与 P2 现行装配逐字段等价', () => {
    const frame = assembleCognitiveFrame(frameInput())
    const inputs = projectStructureFlowInputs(frame)
    assert.ok(inputs)
    assert.deepEqual(inputs, {
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
      // work 观测缺省时投影显式给 undefined（cognitive-frame.ts:209 可选链）——
      // 消费方 structure-flow-controller 以 `=== true` 判定，undefined ≡ 缺席。
      repairActive: undefined,
      userIntervened: false,
    })
  })

  it('efe missing → null（对应 P2「EFE 缺失 → 旧行为」路径）', () => {
    assert.equal(projectStructureFlowInputs(assembleCognitiveFrame(frameInput({ efe: null }))), null)
  })

  it('efe vacuous（非有限）→ null（fail-closed，不把坏数据递给控制器）', () => {
    const frame = assembleCognitiveFrame(frameInput({ efe: efe({ epistemicValue: Number.NaN }) }))
    assert.equal(projectStructureFlowInputs(frame), null)
  })

  it('activePlan = 计划文件 OR planning 态（P2 控制器语义）', () => {
    const planning = assembleCognitiveFrame(frameInput({ plan: { activePlanFile: false, planModeState: 'planning' } }))
    assert.equal(projectStructureFlowInputs(planning)?.activePlan, true)
    const file = assembleCognitiveFrame(frameInput({ plan: { activePlanFile: true, planModeState: 'off' } }))
    assert.equal(projectStructureFlowInputs(file)?.activePlan, true)
  })

  it('pal=null → palNeedsUser/palStalled 均 false（无案件 ≠ 收紧）', () => {
    const inputs = projectStructureFlowInputs(assembleCognitiveFrame(frameInput({ pal: null })))
    assert.equal(inputs?.palNeedsUser, false)
    assert.equal(inputs?.palStalled, false)
  })

  it('投影 → computeStructureFlowControl 端到端：稳定执行输入复现 P2 手推数值', () => {
    const inputs = projectStructureFlowInputs(assembleCognitiveFrame(frameInput()))
    assert.ok(inputs)
    const snap = computeStructureFlowControl(inputs)
    assert.equal(snap.mode, 'flow')
    assert.ok(Math.abs(snap.relaxation - 0.25) < 1e-9)
  })

  it('投影是纯读取：调用两次输出深相等，且不修改 frame', () => {
    const frame = assembleCognitiveFrame(frameInput())
    const before = JSON.stringify(frame)
    const a = projectStructureFlowInputs(frame)
    const b = projectStructureFlowInputs(frame)
    assert.deepEqual(a, b)
    assert.equal(JSON.stringify(frame), before)
  })
})
