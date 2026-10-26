import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reasoningPairEligibility, summarizeLatencyTrials, type LatencyTrial } from '../latency-comparison.js'

function complete(): LatencyTrial[] {
  return Array.from({ length: 20 }, (_, task) => Array.from({ length: 3 }, (_, repeat) => (['baseline', 'candidate'] as const).map(arm => ({
    runId: 'run', taskId: `task-${task}`, repeat, arm, experiment: 'reasoning', model: 'm', provider: 'p',
    tags: [task < 10 ? 'simple' : task < 15 ? 'routine' : 'complex'], quality: 'passed' as const, result: { status: 'passed' },
    observations: [{ cacheGenerationId: 'g1', effort: arm === 'baseline' ? 'high' : 'medium', runFirstTextMs: arm === 'baseline' ? 1000 : 700, input: 100, cacheRead: 0 },
      { cacheGenerationId: 'g1', input: 100, cacheRead: 98 }],
  })))).flat(2)
}

test('only a complete reviewed trial with genuine wire contrast can meet the release gates', () => {
  assert.equal(reasoningPairEligibility([{ effort: 'high' }], [{ effort: 'high' }]), 'wire_equivalent')
  assert.equal(reasoningPairEligibility([], []), 'unknown')
  const rows = complete(), result = summarizeLatencyTrials(rows)
  assert.equal(result.eligibleForDefault, true)
  assert.equal(result.firstTextImprovement, 0.3)
  assert.equal(result.candidateCache.totalInput, 12000, 'cold input remains in totals')
  assert.equal(result.candidateCache.steadyHitRate, 0.98)
  const unreviewed = rows.map(r => ({ ...r, quality: 'unreviewed' as const }))
  assert.equal(summarizeLatencyTrials(unreviewed).eligibleForDefault, false)
  assert.equal(summarizeLatencyTrials(rows.slice(1)).eligibleForDefault, false)
})

test('wire-equivalent effort and mixed model runs cannot manufacture a speed win', () => {
  const rows = complete()
  for (const r of rows) r.observations[0]!.effort = 'high'
  assert.ok(summarizeLatencyTrials(rows).reasons.includes('no_effective_reasoning_contrast'))
  rows[0]!.model = 'other'
  assert.ok(summarizeLatencyTrials(rows).reasons.includes('requires_one_run_model_provider_experiment'))
  assert.equal(summarizeLatencyTrials([...rows, rows[1]!]).eligibleForDefault, false)
})

test('a new image-budget generation is cold, never counted as steady cached input', () => {
  const rows = complete()
  for (const r of rows) r.observations.push({ cacheGenerationId: 'g2', input: 10_000, cacheRead: 0, generationReason: 'image_budget' })
  const report = summarizeLatencyTrials(rows)
  assert.equal(report.candidateCache.steadyHitRate, 0.98)
  assert.equal(report.candidateCache.coldOrTransitionRequests, 120)
  assert.equal(report.candidateCache.totalInput, 612000)
  for (const r of rows) delete r.observations[1]!.cacheGenerationId
  assert.ok(summarizeLatencyTrials(rows).reasons.includes('cache_observations_incomplete'))
})

test('release gates reject uneven repeat coverage even when all 60 pairs exist', () => {
  const rows = complete()
  for (const row of rows) if (row.taskId === 'task-18' && row.repeat === 2) {
    row.taskId = 'task-19'; row.repeat = 3
  }
  assert.equal(summarizeLatencyTrials(rows).eligibleForDefault, false)
})

test('release gates reject invalid latency and cache observations instead of reporting artificial wins', () => {
  const latency = complete()
  for (const row of latency) if (row.arm === 'candidate') row.observations[0]!.runFirstTextMs = -1
  assert.equal(summarizeLatencyTrials(latency).eligibleForDefault, false)
  const cache = complete()
  for (const row of cache) row.observations[1]!.cacheRead = 200
  assert.equal(summarizeLatencyTrials(cache).eligibleForDefault, false)
})
