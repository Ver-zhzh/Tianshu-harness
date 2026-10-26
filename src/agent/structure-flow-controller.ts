/**
 * P2 阴阳调度连续控制器 —— 纯决策函数。
 *
 * 把 EFE（认知不确定性/目标推进/新颖性/precision）、P1 心流信号、PAL 案件状态、
 * 验证债务与用户干预归一化为一个可解释、可回退的控制快照：
 *
 * - `mode`：tighten（收紧结构）/ balanced / flow（允许有界放松）
 * - `relaxation`：[0, 0.25] 的软阈值偏移量，仅 flow 模式非零；
 *   **只**用于 score-based 收敛软阈值，绝不触碰 no-tool 熔断、
 *   verification/交付闸或用户审批。
 * - `planRecommendation`：advisory-only，不直接改 plan mode 生命周期。
 * - `tddRecommendation`：只影响提示文案频率，不改 evaluateTddGate 的 allow/block。
 *
 * Fail-closed 原则：EFE 任一分量非有限 → missing-data 中性态；flow 样本
 * 不足资格门（requiredFlowSamples = P1 FLOW_MIN_SAMPLES）→ flow 分量归零但
 * 不作废其它健康信号；用户干预 / 验证债务 / 连续失败 ≥2 / PAL needs_user
 * 或停滞 → hardTighten 将放松归零。健康探案（活跃案件但探针在推进）
 * 不触发收紧——与 PAL 激励机制（鼓励开案/探针）保持一致。
 *
 * 设计出处：docs/superpowers/plans/2026-07-18-yinyang-scheduling-p2.md 任务 1。
 */

import type { EFEComponents } from './prediction-error.js'

export type StructureFlowMode = 'tighten' | 'balanced' | 'flow'

export type StructureFlowReason =
  | 'unknown-domain'
  | 'stable-execution'
  | 'mixed-signals'
  | 'missing-data'
  | 'pal-uncertain'
  | 'user-intervened'

export interface StructureFlowInputs {
  repairActive?: boolean
  efe: EFEComponents
  /** P1 computeFlowBeacon 的 score；无数据时 null。 */
  flowScore: number | null
  /** flow 样本数（窗口内已结算工具数）。 */
  flowSampleCount: number
  /** 资格门样本数——生产取值 = P1 的 FLOW_MIN_SAMPLES（4，跨 tier 恒定）。 */
  requiredFlowSamples: number
  todoCompletedDelta: number
  activePlan: boolean
  /** PAL 案件卡在 needs_user（等用户裁决）——snapshotForCvm().anyNeedsUser。 */
  palNeedsUser: boolean
  /** PAL 案件停滞（无计划探针推进）——snapshotForCvm().anyStalled。 */
  palStalled: boolean
  hasVerificationDebt: boolean
  consecutiveFailures: number
  userIntervened: boolean
}

export interface StructureFlowSnapshot {
  mode: StructureFlowMode
  /** 0 = no relaxation; 最大 0.25。已是最终可用偏移量，消费方不得二次缩放。 */
  relaxation: number
  /** Advisory-only plan recommendation; never mutates plan mode. */
  planRecommendation: 'enter' | 'stay' | 'exit' | 'none'
  /** TDD remains fail-closed; this is only an advisory projection. */
  tddRecommendation: 'suggest' | 'neutral'
  reasons: StructureFlowReason[]
}

/** relaxation 上限——detector 侧映射为 1 + relaxation 倍率（≤1.25）。 */
export const STRUCTURE_FLOW_MAX_RELAXATION = 0.25

const REASON_ORDER: readonly StructureFlowReason[] = [
  'missing-data',
  'user-intervened',
  'pal-uncertain',
  'unknown-domain',
  'stable-execution',
  'mixed-signals',
]

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function sortReasons(reasons: Set<StructureFlowReason>): StructureFlowReason[] {
  return REASON_ORDER.filter(r => reasons.has(r))
}

export function computeStructureFlowControl(input: StructureFlowInputs): StructureFlowSnapshot {
  const { efe } = input

  // TDD 建议独立于模式求值——missing-data 也不吞掉验证债务提示。
  const tddRecommendation: StructureFlowSnapshot['tddRecommendation'] =
    input.hasVerificationDebt || input.consecutiveFailures > 0 ? 'suggest' : 'neutral'

  const efeFinite = Number.isFinite(efe.epistemicValue)
    && Number.isFinite(efe.pragmaticValue)
    && Number.isFinite(efe.noveltyBonus)
    && Number.isFinite(efe.precision)
  if (!efeFinite) {
    return {
      mode: 'balanced',
      relaxation: 0,
      planRecommendation: 'none',
      tddRecommendation,
      reasons: ['missing-data'],
    }
  }

  const epi = clamp01(efe.epistemicValue)
  const prag = clamp01(efe.pragmaticValue)
  const novelty = clamp01(efe.noveltyBonus)
  const precision = clamp01(efe.precision)

  const progress = clamp01(input.todoCompletedDelta / 3)
  // 样本资格门：不足时 flow 分数只能作诊断，不进入 flowPotential（fail-closed）。
  const qualifiedFlow = input.flowScore !== null
    && Number.isFinite(input.flowScore)
    && input.flowSampleCount >= input.requiredFlowSamples
    ? clamp01(input.flowScore)
    : 0

  const structurePressure = clamp01(
    0.45 * epi
    + 0.20 * novelty
    + 0.20 * (1 - precision)
    + 0.15 * clamp01(input.consecutiveFailures / 3),
  )
  const flowPotential = clamp01(
    0.35 * prag
    + 0.25 * precision
    + 0.25 * qualifiedFlow
    + 0.15 * progress,
  )

  // hardTighten：一切放松归零。consecutiveFailures 阈值为 ≥2——单次偶发失败
  // 只通过 structurePressure 的 0.15 权重项软性加压，不硬收紧。
  const palUncertain = input.palNeedsUser || input.palStalled
  const hardTighten = input.repairActive === true || input.userIntervened
    || input.hasVerificationDebt
    || input.consecutiveFailures >= 2
    || palUncertain

  let mode: StructureFlowMode
  const reasons = new Set<StructureFlowReason>()
  if (hardTighten) {
    mode = 'tighten'
    if (input.userIntervened) reasons.add('user-intervened')
    if (palUncertain) reasons.add('pal-uncertain')
    if (input.hasVerificationDebt || input.consecutiveFailures >= 2) reasons.add('mixed-signals')
  } else if (
    flowPotential - structurePressure >= 0.20
    && (progress > 0 || qualifiedFlow >= 0.75)
  ) {
    mode = 'flow'
    reasons.add('stable-execution')
  } else if (structurePressure - flowPotential >= 0.15) {
    mode = 'tighten'
    reasons.add('unknown-domain')
  } else {
    mode = 'balanced'
    reasons.add('mixed-signals')
  }

  // 仅 flow 模式给出放松；输出即最终偏移量，不再二次乘 0.25。
  const relaxation = mode === 'flow'
    ? Math.min(
      STRUCTURE_FLOW_MAX_RELAXATION,
      STRUCTURE_FLOW_MAX_RELAXATION * clamp01((flowPotential - structurePressure - 0.20) / 0.40),
    )
    : 0

  let planRecommendation: StructureFlowSnapshot['planRecommendation'] = 'none'
  if (mode === 'tighten' && structurePressure >= 0.55) {
    planRecommendation = input.activePlan ? 'stay' : 'enter'
  } else if (
    mode === 'flow'
    && input.activePlan
    && prag >= 0.70
    && epi <= 0.30
    && progress > 0
  ) {
    planRecommendation = 'exit'
  }

  return { mode, relaxation, planRecommendation, tddRecommendation, reasons: sortReasons(reasons) }
}
