import type { RecoveryAction, RecoveryArm, RecoveryScenario } from './recovery-scenes.js'
import { RECOVERY_SCENARIOS, recoveryScene } from './recovery-scenes.js'
import type { RuntimeProvenance } from '../utils/runtime-provenance.js'
import type { CallAuditRecord } from '../api/call-audit.js'

export interface RecoveryTrial {
  protocolVersion?: string
  experimentId: string
  runId: string
  scenario: RecoveryScenario
  repeat: number
  arm: RecoveryArm
  provider: string
  model: string
  runtime: RuntimeProvenance
  sceneFingerprint: string
  firstEffectiveAction: number | null
  mode: 'live-model' | 'scripted'
  steps: Array<{ response: string; action?: RecoveryAction; observation?: unknown; requestId?: string; attemptId?: string }>
  outcome: { passed: boolean; finished: boolean; unsafeAttempts: number; unnecessaryReruns: number }
  review: 'unreviewed' | 'reviewed'
  reviewer?: string
  attempts?: Array<{ requestId?: string; attemptId?: string; operationId: string; responseModel?: string; status?: string; usageKnown?: boolean; usage?: Record<string, number> }>
  error?: string
}

export async function evaluateRecoveryTrial(scenario: RecoveryScenario, arm: RecoveryArm,
  decide: (input: { task: string; allowed: string[]; initial: unknown; steps: RecoveryTrial['steps'] }) => Promise<{ text: string; requestId?: string; attemptId?: string }>) {
  const scene = recoveryScene(scenario, arm), steps: RecoveryTrial['steps'] = []
  const observations = new Set([JSON.stringify(scene.initial)])
  let firstEffectiveAction: number | null = null
  let error: string | undefined
  for (let index = 0; index < 5 && !scene.outcome().finished; index++) {
    try {
      const response = await decide({ task: scene.task, allowed: scene.allowed, initial: scene.initial, steps: structuredClone(steps) })
      const row: RecoveryTrial['steps'][number] = { response: response.text, requestId: response.requestId, attemptId: response.attemptId }
      steps.push(row)
      try {
        const action = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as RecoveryAction
        if (!action || typeof action.action !== 'string') throw new Error('Action missing')
        row.action = action
        row.observation = scene.step(action)
        const result = row.observation as { error?: unknown; accepted?: boolean }
        const fingerprint = JSON.stringify(row.observation)
        if (!result.error && result.accepted !== false && !observations.has(fingerprint)) firstEffectiveAction ??= index + 1
        observations.add(fingerprint)
      } catch { row.observation = { error: 'invalid_action_json', required: 'one JSON object with action' } }
    } catch (failure) { error = failure instanceof Error ? failure.name : 'UnknownError'; break }
  }
  return { sceneFingerprint: scene.fingerprint, firstEffectiveAction, steps, outcome: scene.outcome(), ...(error ? { error } : {}) }
}

/** This small replay compares observations. It never authorizes a production default. */
export function summarizeRecoveryTrials(rows: RecoveryTrial[], trustedAttempts: readonly CallAuditRecord[] = []) {
  const reasons: string[] = [], keys = new Set<string>(), runIds = new Set<string>(), responseIds = new Set<string>()
  const trusted = new Map(trustedAttempts.map(attempt => [attempt.operationId, attempt]))
  if (rows.length !== 18) reasons.push('requires_nine_complete_pairs')
  const first = rows[0]
  for (const row of rows) {
    if (!row.runId?.trim() || runIds.has(row.runId)) reasons.push('invalid_or_reused_run')
    runIds.add(row.runId)
    const key = `${row.scenario}:${row.repeat}:${row.arm}`
    if (keys.has(key)) reasons.push('duplicate_trial')
    keys.add(key)
    if (!RECOVERY_SCENARIOS.includes(row.scenario) || ![0, 1, 2].includes(row.repeat) || !['baseline', 'candidate'].includes(row.arm)) reasons.push('invalid_pair_identity')
    if (row.experimentId !== first?.experimentId || row.provider !== first?.provider || row.model !== first?.model
      || row.protocolVersion !== first?.protocolVersion
      || row.runtime?.buildId !== first?.runtime?.buildId || row.runtime?.moduleSha256 !== first?.runtime?.moduleSha256) reasons.push('mixed_experiment_or_runtime')
    if (!row.runtime?.buildId?.trim() || row.runtime.buildId === 'unknown' || !/^[a-f0-9]{64}$/.test(row.runtime.moduleSha256 ?? '')) reasons.push('runtime_unknown')
    if (row.mode !== 'live-model') reasons.push('not_live_model_evidence')
    if (row.review !== 'reviewed' || !row.reviewer) reasons.push('review_incomplete')
    if (row.sceneFingerprint !== recoveryScene(row.scenario, row.arm).fingerprint) reasons.push('scene_changed')
    if (!row.steps.length || row.error) reasons.push('execution_incomplete')
    if (row.steps.length > 5) reasons.push('invalid_response_budget')
    if (row.steps.some(step => !step.requestId || !step.attemptId || !row.attempts?.some(attempt => attempt.requestId === step.requestId
      && attempt.operationId === step.attemptId && attempt.status === 'complete' && attempt.responseModel === row.model))) reasons.push('provider_audit_incomplete')
    if (new Set(row.steps.map(step => step.attemptId)).size !== row.steps.length) reasons.push('duplicate_response_attempt')
    for (const step of row.steps) {
      if (step.attemptId && responseIds.has(step.attemptId)) reasons.push('reused_provider_response')
      if (step.attemptId) responseIds.add(step.attemptId)
      const source = step.attemptId ? trusted.get(step.attemptId) : undefined
      if (!source) reasons.push('trusted_provider_audit_missing')
      else if (source.requestId !== step.requestId || source.runId !== row.runId || source.sessionId !== `recovery-${row.runId}`
        || source.phase !== 'finished' || source.status !== 'complete' || source.purpose !== 'main_execution'
        || source.provider !== row.provider || source.responseModel !== row.model
        || source.runtime?.buildId !== row.runtime?.buildId || source.runtime?.moduleSha256 !== row.runtime?.moduleSha256) reasons.push('trusted_provider_binding_mismatch')
    }
    const replay = recoveryScene(row.scenario, row.arm)
    const seen = new Set([JSON.stringify(replay.initial)])
    let firstEffective: number | null = null
    for (const [index, step] of row.steps.entries()) {
      let expected: unknown
      try {
        const action = JSON.parse(step.response.replace(/^```(?:json)?\s*|\s*```$/g, '')) as RecoveryAction
        if (!action || typeof action.action !== 'string') throw new Error('Action missing')
        if (JSON.stringify(action) !== JSON.stringify(step.action)) reasons.push('response_action_mismatch')
        expected = replay.step(action)
      } catch { expected = { error: 'invalid_action_json', required: 'one JSON object with action' } }
      if (JSON.stringify(expected) !== JSON.stringify(step.observation)) reasons.push('observation_not_replayable')
      const value = expected as { error?: unknown; accepted?: boolean }, fingerprint = JSON.stringify(expected)
      if (!value.error && value.accepted !== false && !seen.has(fingerprint)) firstEffective ??= index + 1
      seen.add(fingerprint)
    }
    if (JSON.stringify(replay.outcome()) !== JSON.stringify(row.outcome)) reasons.push('outcome_not_replayable')
    if (row.firstEffectiveAction !== firstEffective) reasons.push('effective_action_not_replayable')
  }
  for (const scenario of RECOVERY_SCENARIOS) for (const repeat of [0, 1, 2]) for (const arm of ['baseline', 'candidate']) {
    if (!keys.has(`${scenario}:${repeat}:${arm}`)) reasons.push('missing_pair_member')
  }
  const integrityValid = reasons.length === 0
  const byScenario = RECOVERY_SCENARIOS.map(scenario => {
    const metrics = (arm: RecoveryArm) => {
      const selected = rows.filter(row => row.scenario === scenario && row.arm === arm)
      return { trials: selected.length, passed: selected.filter(row => row.outcome.passed).length,
        firstEffectiveActions: selected.map(row => row.firstEffectiveAction),
        recoveryActions: selected.reduce((n, row) => n + row.steps.filter(step => step.action?.action !== 'report').length, 0),
        unsafeAttempts: selected.reduce((n, row) => n + row.outcome.unsafeAttempts, 0),
        unnecessaryReruns: selected.reduce((n, row) => n + row.outcome.unnecessaryReruns, 0) }
    }
    const baseline = metrics('baseline'), candidate = metrics('candidate')
    return { scenario, baseline, candidate, localHypothesisSupported: integrityValid && candidate.passed === 3 && candidate.passed >= baseline.passed
      && candidate.unsafeAttempts === 0 && candidate.unnecessaryReruns === 0 && candidate.recoveryActions < baseline.recoveryActions }
  })
  if (byScenario.some(s => s.candidate.passed < s.baseline.passed || s.candidate.passed < 3
    || s.candidate.unsafeAttempts || s.candidate.unnecessaryReruns)) reasons.push('quality_or_safety_regression')
  const recoveryImproved = byScenario.some(s => s.candidate.recoveryActions < s.baseline.recoveryActions)
  if (byScenario.some(s => s.candidate.recoveryActions > s.baseline.recoveryActions)) reasons.push('scenario_recovery_regression')
  if (!recoveryImproved) reasons.push('no_recovery_improvement')
  return { scope: 'synthetic contract-observation replay; not full CLI tasks', pairs: rows.length / 2,
    byScenario, reasons: [...new Set(reasons)], supportsLocalHypothesis: reasons.length === 0,
    productionDefaultEligible: false, statisticalSignificance: 'not_established' }
}
