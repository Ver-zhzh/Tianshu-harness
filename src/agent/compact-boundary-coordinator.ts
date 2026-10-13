import type { CompactionProfile } from '../compact/compaction-profile.js'
import type { ReclaimDecisionRecord } from '../compact/reclaim-estimate.js'
import type { ArchiveForRecovery } from '../compact/boundary-archive.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
import type { DangerSignal } from './immune-types.js'

/** T9 quality-compaction trigger ratios. Mirrors compactSchema.qualityCompact
 *  defaults — used when config does not supply overrides. */
export interface QualityCompactThresholds {
  perTokenThreshold: number
  subscriptionThreshold: number
  subscriptionCeiling: number
}

export const DEFAULT_QUALITY_COMPACT_THRESHOLDS: QualityCompactThresholds = {
  perTokenThreshold: 0.55,
  subscriptionThreshold: 0.45,
  subscriptionCeiling: 0.6,
}

/** Heap-usage ratio (heapUsed / real V8 limit) above which an in-turn micro-compact
 *  is forced regardless of the 1M-window turn-0 deferral. Below this, heap pressure
 *  on a 1M window is deferred to the next user boundary (turn 0) to protect the
 *  prefix cache; at/above it, deferring risks OOMing the whole process before the
 *  next turn 0 ever arrives (a long/wedged run never returns to turn 0), so we
 *  accept the cache reprefill as the far lesser evil. */
export const HEAP_EMERGENCY_RATIO = 0.85

/** Token-ratio floor for opportunistic (cold-cache) stale-round compaction.
 *  Below this there is too little stale history for the rewrite to pay off
 *  even when the prefix cache is already expired. */
export const OPPORTUNISTIC_COMPACT_RATIO = 0.3

export interface CompactBoundaryDeps {
  // Field accessors
  getCompactFailures: () => CompactCircuitBreakerState
  setCompactFailures: (f: CompactCircuitBreakerState) => void
  getLastCompactTurn: () => number | null
  setLastCompactTurn: (t: number | null) => void
  getPendingStaleCompact: () => boolean
  setPendingStaleCompact: (v: boolean) => void
  getPendingHeapCompact: () => boolean
  setPendingHeapCompact: (v: boolean) => void
  getPrevPhaseHint: () => string | undefined
  setPrevPhaseHint: (h: string | undefined) => void

  // External deps
  getAbortSignal: () => AbortSignal | undefined
  getContextWindow: () => number
  getPhaseHint: () => string | undefined
  getEstimatedTokens: () => number
  getMessages: () => import('../api/oai-types.js').OaiMessage[]
  replaceMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => void
  dietMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => { removedCount: number; messages: import('../api/oai-types.js').OaiMessage[] }
  trySessionSplit: () => Promise<boolean>
  maybeCompact: (opts: { loopTurn: number; failures: CompactCircuitBreakerState }) => Promise<{ compacted: boolean; failures: CompactCircuitBreakerState }>
  tryPartialCompact: (targetTurnAge: number) => Promise<boolean>
  shouldDelayCompact: (turnThreshold: number, ctx?: { estimatedTokens?: number; contextWindow?: number }) => boolean
  /**
   * CacheAdvisor 机会压缩判断：缓存已冷（上次 API 调用超过 provider TTL）时为 true。
   * 冷缓存下「延迟压缩保前缀」失去意义（服务端缓存已过期，重建成本反正要付），
   * 顺势在 turn 0 用更低的 ratio 门槛压缩陈旧轮。缓存热/温时此路径不参与，
   * 现有 shouldDelayCompact 纪律原样保留。
   */
  shouldOpportunisticCompact?: () => boolean
  getStalePreviewChars: () => number
  isCachePreservingProvider: () => boolean
  /** True when the provider is NOT billed per token (flat subscription / coding-plan).
   *  Such providers may compact more eagerly at turn-0 for a leaner context, since
   *  shrinking the prefix cache costs latency but no money. */
  isCostInsensitiveProvider?: () => boolean
  getProviderName?: () => string | undefined
  /** T9 trigger ratios from config; falls back to DEFAULT_QUALITY_COMPACT_THRESHOLDS. */
  getQualityThresholds?: () => QualityCompactThresholds
  injectImmuneSignal: (signal: DangerSignal) => void
  /**
   * W1-A3: archive originals of marker-less tool messages before a lossy
   * rewrite. Returns `message index → artifactId`; failed saves are simply
   * absent and the transforms keep those originals (fail-open). Optional —
   * when absent, transforms behave exactly as before.
   */
  archiveForRecovery?: ArchiveForRecovery
  /**
   * Cost-aware reclaim profile (2026-07-16 plan task 3). Deterministic stale /
   * micro candidates must clear its floors before replacing history; absent,
   * a conservative per-token profile is derived from the cache classification.
   */
  getCompactionProfile?: () => CompactionProfile | undefined
  /** Structured sink for reclaim-gate decisions (committed AND rejected). */
  onReclaimDecision?: (record: ReclaimDecisionRecord) => void
}

export interface RunCompactionResult {
  compacted: boolean
  shouldAbort: boolean
  userMessageConsumed: boolean
}

/** Legacy boundary hooks observe cancellation only. Final request budgeting owns rewrites. */
export class CompactBoundaryCoordinator {
  constructor(private deps: CompactBoundaryDeps) {}
  async preUserMessageSplit(): Promise<void> {}
  async runCompaction(_turn: number, _snap: { memory: { heapUsedBytes: number; memoryLimitBytes: number } } | null): Promise<RunCompactionResult> {
    return { compacted: false, shouldAbort: this.deps.getAbortSignal()?.aborted === true, userMessageConsumed: false }
  }
}
