import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactBoundaryCoordinator, type CompactBoundaryDeps } from '../compact-boundary-coordinator.js'
import type { CompactCircuitBreakerState } from '../../context/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * C-line: CompactBoundaryCoordinator is the extracted compaction-boundary brain
 * of the loop and shipped with no dedicated tests. The riskiest invariant it
 * guards is P2-5: history-rewriting compaction must only happen at user
 * boundaries (turn 0) — off-boundary rewrites shatter the prefix cache. These
 * tests lock that, plus abort short-circuiting and the compaction-failure
 * immune signal.
 */

interface Calls {
  maybeCompact: number
  replaceMessages: number
  immuneSignals: Array<{ kind: string; severity: number; turn: number; source: string }>
  pendingStaleCompact: boolean
  pendingHeapCompact: boolean
  lastCompactTurn: number | null
  setFailures: CompactCircuitBreakerState | null
}

function bigMsgs(n: number, charsEach = 200): OaiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(charsEach),
  })) as OaiMessage[]
}

function makeCoord(overrides: Partial<CompactBoundaryDeps> & {
  aborted?: boolean
  failures?: CompactCircuitBreakerState
  splitConsumes?: boolean
  compacted?: boolean
} = {}) {
  const calls: Calls = {
    maybeCompact: 0,
    replaceMessages: 0,
    immuneSignals: [],
    pendingStaleCompact: false,
    pendingHeapCompact: false,
    lastCompactTurn: null,
    setFailures: null,
  }
  const { aborted, failures: failuresOverride, splitConsumes, compacted, ...depOverrides } = overrides
  const failures = failuresOverride ?? { consecutiveFailures: 0 }
  const msgs = overrides.getMessages ? overrides.getMessages() : bigMsgs(4)

  const deps: CompactBoundaryDeps = {
    getCompactFailures: () => failures,
    setCompactFailures: (f) => { calls.setFailures = f },
    getLastCompactTurn: () => calls.lastCompactTurn,
    setLastCompactTurn: (t) => { calls.lastCompactTurn = t },
    getPendingStaleCompact: () => calls.pendingStaleCompact,
    setPendingStaleCompact: (v) => { calls.pendingStaleCompact = v },
    getPendingHeapCompact: () => calls.pendingHeapCompact,
    setPendingHeapCompact: (v) => { calls.pendingHeapCompact = v },
    getPrevPhaseHint: () => undefined,
    setPrevPhaseHint: () => {},
    getAbortSignal: () => (aborted ? ({ aborted: true } as AbortSignal) : undefined),
    getContextWindow: () => 200_000,
    getPhaseHint: () => undefined,
    getEstimatedTokens: () => 0,
    getMessages: () => msgs,
    replaceMessages: () => { calls.replaceMessages++ },
    dietMessages: (m) => ({ removedCount: 0, messages: m }),
    trySessionSplit: async () => splitConsumes ?? false,
    maybeCompact: async () => {
      calls.maybeCompact++
      return { compacted: compacted ?? false, failures }
    },
    tryPartialCompact: async () => false,
    shouldDelayCompact: () => false,
    getStalePreviewChars: () => 0,
    isCachePreservingProvider: () => false,
    injectImmuneSignal: (s) => { calls.immuneSignals.push(s) },
    ...depOverrides,
  }
  return { coord: new CompactBoundaryCoordinator(deps), calls }
}

describe('legacy compaction triggers cannot rewrite published history', () => {
  for (const window of [32000, 200000, 1_000_000]) for (const turn of [0, 1, 20]) {
    it(`window=${window}, turn=${turn}: stale, cold-cache, phase and heap pressure remain observational`, async () => {
      let split = 0, partial = 0, diet = 0
      const { coord, calls } = makeCoord({ getContextWindow: () => window, getEstimatedTokens: () => window * .9,
        getPendingStaleCompact: () => true, getPendingHeapCompact: () => true,
        shouldOpportunisticCompact: () => true, getPhaseHint: () => 'verification',
        trySessionSplit: async () => { split++; return true }, tryPartialCompact: async () => { partial++; return true },
        dietMessages: m => { diet++; return { removedCount: 1, messages: m } }, compacted: true })
      await coord.preUserMessageSplit()
      assert.deepEqual(await coord.runCompaction(turn, { memory: { heapUsedBytes: 99, memoryLimitBytes: 100 } }), { compacted: false, shouldAbort: false, userMessageConsumed: false })
      assert.equal(split + partial + diet + calls.maybeCompact + calls.replaceMessages, 0)
    })
  }
  it('cancellation remains observable without consuming a message or starting a split', async () => {
    const { coord, calls } = makeCoord({ aborted: true, splitConsumes: true })
    assert.deepEqual(await coord.runCompaction(0, null), { compacted: false, shouldAbort: true, userMessageConsumed: false })
    assert.equal(calls.maybeCompact, 0)
  })
})
