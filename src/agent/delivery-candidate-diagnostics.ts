import type { TaskLedgerEvent } from './task-ledger.js'
import type { TestExecutionGroup } from '../tools/test-execution-plan.js'
import { getEffectiveVerifications } from './verification-attribution.js'

export interface CandidateDiagnostics {
  currentRef: string
  latestExcludedPassedRef?: string
  onlyInCurrent: string[]
  onlyInPassed: string[]
  excludedCandidateProofs: number
  unboundProofs: number
  currentFailure?: string
  nextRun?: string
}

/** Explain evidence identity without treating another candidate's pass as proof. */
export function diagnoseCandidateEvidence(
  events: readonly TaskLedgerEvent[], currentRef: string, currentFiles: readonly string[],
  nextBatch?: TestExecutionGroup,
): CandidateDiagnostics {
  const proofs = events.filter(event => event.type === 'verification' && event.meta?.stale !== true)
  const refOf = (event: TaskLedgerEvent) => typeof event.meta?.snapshotRef === 'string' ? event.meta.snapshotRef : undefined
  const excluded = proofs.filter(event => refOf(event) && refOf(event) !== currentRef)
  const unbound = proofs.filter(event => !refOf(event))
  const prior = [...excluded].reverse().find(event => event.status === 'passed' && Array.isArray(event.meta?.candidateFiles))
  const priorFiles = prior?.meta?.candidateFiles as string[] | undefined
  const current = new Set(currentFiles)
  const previous = new Set(priorFiles ?? [])
  const failure = [...getEffectiveVerifications(events, currentRef, true).effective].reverse().find(event => event.status === 'failed')
  const failedTargets = Array.isArray(failure?.targetFiles)
    ? failure.targetFiles.filter((file): file is string => typeof file === 'string' && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) : []
  const nextFiles = nextBatch?.files.length ? nextBatch.files : failedTargets
  const options = nextBatch
    ? `${nextBatch.projects?.length ? `, projects=${JSON.stringify(nextBatch.projects)}` : ''}${nextBatch.shard === false ? ', shard=false' : ''}` : ''
  return {
    currentRef,
    ...(prior ? { latestExcludedPassedRef: refOf(prior) } : {}),
    onlyInCurrent: priorFiles ? [...current].filter(file => !previous.has(file)).sort() : [],
    onlyInPassed: priorFiles ? [...previous].filter(file => !current.has(file)).sort() : [],
    excludedCandidateProofs: excluded.length,
    unboundProofs: unbound.length,
    ...(failure?.command ? { currentFailure: failure.command } : {}),
    ...(nextFiles.length ? { nextRun: `run_tests(files=${JSON.stringify(nextFiles)}, deliveryFiles=${JSON.stringify(currentFiles)}${options})` } : {}),
  }
}

export function renderCandidateDiagnostics(diagnostic: CandidateDiagnostics): string[] {
  const lines = [`候选证据：${diagnostic.currentRef}`]
  if (diagnostic.currentFailure) lines.push(`  当前候选失败：${diagnostic.currentFailure}`)
  if (diagnostic.latestExcludedPassedRef) {
    lines.push(`  最近通过的 ${diagnostic.latestExcludedPassedRef} 不适用于当前候选；不同候选的结果不会相互覆盖。`)
    if (!diagnostic.onlyInCurrent.length && !diagnostic.onlyInPassed.length) lines.push('  文件集合相同，但内容或 HEAD 已变化；请对当前候选重新采证。')
    for (const [label, files] of [['仅当前候选', diagnostic.onlyInCurrent], ['仅通过候选', diagnostic.onlyInPassed]] as const) {
      if (files.length) lines.push(`  ${label} ${files.length} 个文件：${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等（其余 ${files.length - 5} 个见 verificationPlan.candidateDiagnostics）` : ''}`)
    }
  }
  if (diagnostic.excludedCandidateProofs || diagnostic.unboundProofs) lines.push(`  不适用证明：其他候选 ${diagnostic.excludedCandidateProofs} 条，无候选指纹 ${diagnostic.unboundProofs} 条。`)
  if (diagnostic.nextRun) lines.push(`  下一步：${diagnostic.nextRun}`)
  return lines
}
