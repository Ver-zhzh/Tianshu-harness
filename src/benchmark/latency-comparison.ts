export interface LatencyObservation {
  cacheGenerationId?: string
  runFirstTextMs?: number
  effort?: string
  input?: number
  cacheRead?: number
  generationReason?: string
}

export function reasoningPairEligibility(baseline: LatencyObservation[], candidate: LatencyObservation[]): 'eligible' | 'wire_equivalent' | 'unknown' {
  const a = baseline[0]?.effort, b = candidate[0]?.effort
  if (!a || !b) return 'unknown'
  return a === b ? 'wire_equivalent' : 'eligible'
}

export interface LatencyTrial {
  runId: string
  taskId: string
  repeat: number
  arm: 'baseline' | 'candidate'
  experiment: string
  model: string
  provider: string
  tags: string[]
  quality: 'unreviewed' | 'passed' | 'failed'
  result: { status: string }
  observations: LatencyObservation[]
}

function percentile95(values: number[]): number | undefined {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : undefined
}

/** Report incomplete and ineffective experiments; never turn missing data into a win. */
export function summarizeLatencyTrials(rows: LatencyTrial[]) {
  const runs = new Set(rows.map(r => `${r.runId}:${r.experiment}:${r.provider}:${r.model}`))
  const paired = new Map<string, Partial<Record<LatencyTrial['arm'], LatencyTrial>>>()
  const duplicates: string[] = []
  for (const row of rows) {
    const key = `${row.taskId}:${row.repeat}`
    const pair = paired.get(key) ?? {}
    if (pair[row.arm]) duplicates.push(`${key}:${row.arm}`)
    pair[row.arm] = row; paired.set(key, pair)
  }
  const reasons: string[] = []
  if (runs.size !== 1) reasons.push('requires_one_run_model_provider_experiment')
  if (duplicates.length) reasons.push('duplicate_trials')
  const pairs = [...paired.values()]
  const tasks = new Set(rows.map(r => r.taskId))
  if (tasks.size !== 20 || pairs.length !== 60 || pairs.some(p => !p.baseline || !p.candidate)) reasons.push('requires_20_tasks_three_complete_pairs')
  const kinds = ['simple', 'routine', 'complex'] as const
  const taskKinds = new Map<string, string>()
  let validCoverage = rows.length === 120
  for (const taskId of tasks) {
    const trials = rows.filter(row => row.taskId === taskId)
    const tags = trials[0]!.tags.filter(tag => kinds.includes(tag as typeof kinds[number]))
    if (trials.length !== 6 || tags.length !== 1 || trials.some(row => ![0, 1, 2].includes(row.repeat)
      || row.tags.filter(tag => kinds.includes(tag as typeof kinds[number])).join() !== tags[0])) validCoverage = false
    taskKinds.set(taskId, tags[0] ?? '')
  }
  if (!validCoverage || kinds.some((kind, index) => [...taskKinds.values()].filter(value => value === kind).length !== [10, 5, 5][index])) reasons.push('invalid_task_repeat_coverage')
  if (rows.some(row => !['reasoning', 'prompt'].includes(row.experiment)
    || row.observations.some(o => [o.runFirstTextMs, o.input, o.cacheRead].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
      || (o.input !== undefined && o.cacheRead !== undefined && o.cacheRead > o.input)))) reasons.push('invalid_observations')
  const qualityReviewed = rows.every(r => r.quality === 'passed' || r.quality === 'failed')
  if (!qualityReviewed) reasons.push('quality_unreviewed')
  const passed = (arm: LatencyTrial['arm']) => rows.filter(r => r.arm === arm && r.quality === 'passed').length
  if (passed('candidate') < passed('baseline') || rows.some(r => r.result.status !== 'passed')) reasons.push('quality_or_execution_regression')
  const simple = rows.filter(r => r.tags.includes('simple'))
  if (rows[0]?.experiment === 'reasoning' && pairs.some(p => p.baseline?.tags.includes('simple')
    && reasoningPairEligibility(p.baseline.observations, p.candidate?.observations ?? []) !== 'eligible')) reasons.push('no_effective_reasoning_contrast')
  const firstText = (arm: LatencyTrial['arm']) => simple.filter(r => r.arm === arm).map(r => r.observations.find(o => Number.isFinite(o.runFirstTextMs))?.runFirstTextMs)
  const a = firstText('baseline'), b = firstText('candidate')
  if (a.length !== 30 || b.length !== 30 || [...a, ...b].some(v => v === undefined)) reasons.push('missing_end_to_end_first_text')
  const baselineP95 = percentile95(a.filter((v): v is number => v !== undefined))
  const candidateP95 = percentile95(b.filter((v): v is number => v !== undefined))
  const improvement = baselineP95 && candidateP95 !== undefined ? (baselineP95 - candidateP95) / baselineP95 : undefined
  if (improvement === undefined || improvement < 0.2) reasons.push('first_text_p95_below_20_percent')
  const cache = (arm: LatencyTrial['arm']) => {
    const observations = rows.filter(r => r.arm === arm).flatMap(r => r.observations)
    // Report cold generations separately; steady-state excludes each trial's first request.
    const steady = rows.filter(r => r.arm === arm).flatMap(r => r.observations.filter((observation, index) => index > 0
      && !!observation.cacheGenerationId && observation.cacheGenerationId === r.observations[index - 1]?.cacheGenerationId))
    const measured = steady.filter(o => typeof o.input === 'number' && typeof o.cacheRead === 'number')
    const input = measured.reduce((n, o) => n + o.input!, 0), read = measured.reduce((n, o) => n + o.cacheRead!, 0)
    return { steadyHitRate: input > 0 ? read / input : undefined,
      totalInput: observations.reduce((n, o) => n + (o.input ?? 0), 0), totalCacheRead: observations.reduce((n, o) => n + (o.cacheRead ?? 0), 0),
      measuredRequests: measured.length, unknownRequests: steady.length - measured.length,
      unclassifiedRequests: observations.filter(o => !o.cacheGenerationId).length,
      coldOrTransitionRequests: observations.length - steady.length }
  }
  const baselineCache = cache('baseline'), candidateCache = cache('candidate')
  if (baselineCache.steadyHitRate === undefined || candidateCache.steadyHitRate === undefined
    || baselineCache.unknownRequests || candidateCache.unknownRequests || baselineCache.unclassifiedRequests || candidateCache.unclassifiedRequests) reasons.push('cache_observations_incomplete')
  else if (candidateCache.steadyHitRate < 0.95 || baselineCache.steadyHitRate - candidateCache.steadyHitRate > 0.01) reasons.push('cache_gate_not_met')
  // Currency pricing must be verified separately against the selected provider's actual bill.
  return { eligibleForDefault: reasons.length === 0, reasons, baselineP95Ms: baselineP95, candidateP95Ms: candidateP95,
    firstTextImprovement: improvement, baselineCache, candidateCache, qualityReviewed,
    coldGenerationCost: 'requires_provider_billing_review' }
}
