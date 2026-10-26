import { randomUUID } from 'node:crypto'
import { runTestCommandIn, type RunnableTestCommand } from './run-tests.js'
import type { ToolCallParams, ToolResult } from './types.js'
import { snapshotTestResult } from './run-tests-snapshot-result.js'
import { candidateSnapshotRef } from '../agent/candidate-snapshot-ref.js'

export async function runTestPhases(params: ToolCallParams, testCommand: RunnableTestCommand, filter: string | undefined, remaining: () => number): Promise<ToolResult> {
  const plan = params.verificationSnapshot
  if (!plan) return runTestCommandIn(params.cwd, testCommand, params, filter, remaining())

  // Record both executions; only matched complete proofs can waive integration failure.
  const comparisonId = randomUUID()
  const phaseA = await runTestCommandIn(plan.path, testCommand, params, filter, remaining(), undefined, plan.repositoryRoot)
  tagVerification(phaseA, 'isolated', plan.snapshotRef, plan.candidateOnly ? params.input.deliveryFiles as string[] : undefined)
  if (plan.candidateOnly && candidateSnapshotRef(plan.path, params.input.deliveryFiles as string[]) !== plan.snapshotRef) {
    phaseA.isError = true
    phaseA.content += '\n候选快照在验证期间发生变化；本批结果不可作为交付证明。'
    if (phaseA.verification) phaseA.verification = { ...phaseA.verification, status: 'blocked', stale: true, blockedReason: 'unknown_runner', userGuidance: '候选快照已变化，需重新构建并验证。' }
  }

  // A candidate snapshot already starts at current HEAD and overlays only the
  // selected commit files. The live tree contains unrelated dirty files; a
  // second run there cannot prove or disprove this candidate.
  if (params.input.environment !== 'compare') return snapshotTestResult(phaseA, plan)

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

function tagVerification(result: ToolResult, phase: 'isolated' | 'integration', snapshotRef: string, candidateFiles?: string[]): void {
  if (!result.verification) return
  result.verification = { ...result.verification, verificationPhase: phase, snapshotRef, ...(candidateFiles ? { candidateFiles } : {}) }
}

