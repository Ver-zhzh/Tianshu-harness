import { randomUUID } from 'node:crypto'
import { runTestCommandIn, type RunnableTestCommand } from './run-tests.js'
import type { ToolCallParams, ToolResult, VerificationSnapshotPlan } from './types.js'
import { snapshotOmissionNote, snapshotTestResult } from './run-tests-snapshot-result.js'

export async function runTestPhases(params: ToolCallParams, testCommand: RunnableTestCommand, filter: string | undefined, remaining: () => number): Promise<ToolResult> {
  const plan = params.verificationSnapshot
  if (!plan) {
    // Default in-place verification — unchanged single-phase path.
    const inPlace = await runTestCommandIn(params.cwd, testCommand, params, filter, remaining())

    // C3 compares live failure with the owned snapshot; the gate checks proof.
    if (inPlace.isError && !params.abortSignal?.aborted && remaining() > 0 && inPlace.verification?.failureKind !== 'timeout' && params.prepareRetrySnapshot) {
      let retryPlan: VerificationSnapshotPlan | null = null
      try { retryPlan = await params.prepareRetrySnapshot() } catch { /* degrade: keep in-place result */ }
      if (retryPlan) {
        const isolated = await runTestCommandIn(retryPlan.path, testCommand, params, filter, remaining(), undefined, retryPlan.repositoryRoot)
        tagVerification(isolated, 'isolated', retryPlan.snapshotRef)
        if (!isolated.isError) {
          const comparisonId = randomUUID()
          tagVerification(inPlace, 'integration', retryPlan.snapshotRef)
          for (const phase of [isolated, inPlace]) if (phase.verification) phase.verification.comparisonId = comparisonId
          const note = `\n\n[C3 归因重试] 测试在实时工作区 FAILED，但在归属变更的隔离快照中 PASSED。两个环境结果不一致；保留失败记录并检查失败位置或隔离对照，不能仅据此认定由其他会话引入。`
          const result: ToolResult = {
            ...isolated,
            content: `[实时工作区] FAILED\n${typeof inPlace.content === 'string' ? inPlace.content.slice(0, 1500) : ''}\n\n[隔离快照] PASSED\n${isolated.content}${snapshotOmissionNote(retryPlan)}${note}`,
            isError: false,
          }
          if (inPlace.verification) result.extraVerifications = [inPlace.verification]
          return result
        }
        // Keep live failure; an incomplete retry cannot establish isolation failure.
        inPlace.content += `${snapshotOmissionNote(retryPlan)}\n\n[C3 归因重试] ${isolated.verification?.status === 'blocked' ? `未完成 — ${isolated.content}` : '在隔离快照中也 FAILED——两个环境均失败；尚不能区分归属缺陷与共同基线问题。'}`
        if (isolated.verification) inPlace.extraVerifications = [isolated.verification]
      }
    }
    return inPlace
  }

  // Record both executions; only matched complete proofs can waive integration failure.
  const comparisonId = randomUUID()
  const phaseA = await runTestCommandIn(plan.path, testCommand, params, filter, remaining(), undefined, plan.repositoryRoot)
  tagVerification(phaseA, 'isolated', plan.snapshotRef)

  // 阶段 A（隔离）失败即已定论：门禁只在「隔离通过」时才认集成差异
  // （isolatedPassed）。此时再跑一遍实时工作区只会多付一整轮测试时间
  // （2026-10-06 全量实测每次多约 64s）并把失败信息翻倍。
  if (phaseA.isError) {
    return snapshotTestResult(phaseA, plan)
  }

  const phaseB = await runTestCommandIn(params.cwd, testCommand, params, filter, remaining())
  tagVerification(phaseB, 'integration', plan.snapshotRef)
  for (const phase of [phaseA, phaseB]) if (phase.verification) phase.verification.comparisonId = comparisonId
  if (phaseB.verification) phaseB.verification.isolatedPassed = !phaseA.isError && phaseA.verification?.status === 'passed'

  return snapshotTestResult(phaseA, plan, phaseB)
}

function tagVerification(result: ToolResult, phase: 'isolated' | 'integration', snapshotRef: string): void {
  if (!result.verification) return
  result.verification = { ...result.verification, verificationPhase: phase, snapshotRef }
}

