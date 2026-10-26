import type { VerificationMetadata } from './types.js'

/** Only completed reporter receipts supply counts; excerpts cannot prove totals. */
export function summarizeVerification(events: VerificationMetadata[], requestedBatches: number, completedBatches: number, blockedBatches = 0) {
  const unique = [...new Map(events.filter(v => v.executionId).map(v => [v.executionId!, v])).values()]
  const reliable = unique.length > 0 && unique.every(v => v.countsReliable === true && v.coverageStatus === 'complete' && v.executionState === 'exited' && v.passed !== undefined && v.failed !== undefined)
  const byPhase: Record<string, { passed: number; failed: number; skipped: number }> = {}
  if (reliable) for (const v of unique) {
    const phase = v.verificationPhase ?? 'workspace', prior = byPhase[phase] ?? { passed: 0, failed: 0, skipped: 0 }
    byPhase[phase] = { passed: prior.passed + v.passed!, failed: prior.failed + v.failed!, skipped: prior.skipped + (v.skipped ?? 0) }
  }
  const totals = Object.keys(byPhase).length === 1 ? Object.values(byPhase)[0] : undefined
  const complete = completedBatches === requestedBatches && !blockedBatches && unique.length > 0
    && unique.every(v => v.executionState === 'exited' && v.coverageStatus === 'complete')
  const outcome = unique.some(v => v.outcome === 'failed') ? 'failed' : complete && reliable && Object.values(byPhase).every(count => count.passed > 0) && unique.every(v => v.outcome === 'passed') ? 'passed' : 'unknown'
  return { executionIds: unique.map(v => v.executionId!), requestedBatches, completedBatches, countsReliable: reliable, totals, byPhase,
    coverageStatus: complete ? 'complete' as const : 'partial' as const, outcome }
}
