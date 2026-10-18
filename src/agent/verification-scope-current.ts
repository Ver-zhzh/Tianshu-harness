import { readCompletionCoverage } from '../tools/test-completion.js'
import type { VerificationMetadata } from '../tools/types.js'

/** A changed catalog starts a new obligation set; prior partial results cannot fill its gaps. */
export function currentScopeCatalogs(verifications: readonly VerificationMetadata[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const v of verifications) {
    const c = readCompletionCoverage(v.coverage)
    if (!v.stale && c?.version === 3 && c.catalog?.canonical && !c.workspaceChanged) result.set(c.catalog.origin, JSON.stringify([c.catalog.fingerprint, c.catalog.inventoryDigest]))
  }
  return result
}

export const scopeGeneration = (c: NonNullable<import('../tools/types.js').TestCompletionCoverage['catalog']>) => JSON.stringify([c.fingerprint, c.inventoryDigest])
