import { currentScopeCatalogs, scopeGeneration } from './verification-scope-current.js'
import { hasIsolatedComparison } from './verification-comparison.js'
import type { VerificationMetadata } from '../tools/types.js'
import { readCompletionCoverage } from '../tools/test-completion.js'
import type { TestScope } from '../tools/test-scope-catalog.js'
import type { TaskLedgerEvent } from './task-ledger.js'

/** Delivery consumes persisted observations only; it never loads a test configuration. */
export function deliveryScopeProgress(required: readonly string[], evidence: readonly TaskLedgerEvent[], currentSnapshotRef?: string, requireBoundCandidate = false) {
  const scopes = new Map<string, TestScope>(), passed = new Map<string, boolean>()
  const key = (s: TestScope) => JSON.stringify([s.path, s.project])
  const verifications = evidence.map(e => ({ ...e.meta, command: e.command ?? '', status: e.status ?? 'passed' } as VerificationMetadata))
  const catalogs = currentScopeCatalogs(verifications)
  for (const [index, event] of evidence.entries()) {
    const c = readCompletionCoverage(event.meta?.coverage)
    const v = verifications[index]!
    if (hasIsolatedComparison(v, verifications)) continue
    if (!c || c.version !== 3 || !c.catalog?.canonical || catalogs.get(c.catalog.origin) !== scopeGeneration(c.catalog) || event.meta?.stale || c.workspaceChanged
      || currentSnapshotRef && event.meta?.snapshotRef !== currentSnapshotRef && (event.meta?.snapshotRef || requireBoundCandidate)) continue
    for (const s of c.catalog.scopes) if (required.includes(s.path)) scopes.set(key(s), s)
    for (const f of c.files) if (f.project && (f.outcome === 'failed' || c.complete && !c.filtered)) passed.set(key({ ...f, project: f.project }), c.complete && !c.filtered && f.outcome === 'passed' && f.tests > f.skipped && !f.cancelled)
  }
  const requiredScopes = [...scopes.values()]
  return { requiredScopes, coveredScopes: requiredScopes.filter(s => passed.get(key(s))), pendingScopes: requiredScopes.filter(s => !passed.get(key(s))) }
}
