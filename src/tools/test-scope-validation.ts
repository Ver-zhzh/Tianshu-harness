import { testScopeDigest } from './test-project-identity.js'
import type { TestCompletionCoverage } from './types.js'

export function validScopeCoverage(c: TestCompletionCoverage): boolean {
  const catalog = c.catalog, selected = c.selectedScopes
  if (!catalog || !Array.isArray(catalog.scopes) || !Array.isArray(selected) || typeof catalog.canonical !== 'boolean'
    || ![catalog.origin, catalog.fingerprint, catalog.runnerVersion, catalog.inventoryDigest, catalog.digest].every(v => typeof v === 'string' && !!v)) return false
  const valid = (s: { path: string; project: string }) => s && typeof s.path === 'string' && !!s.path && !/^[A-Za-z]:|^[/\\]|\x00/.test(s.path)
    && !s.path.split(/[\\/]/).includes('..') && typeof s.project === 'string' && /^[a-f0-9]{64}$/.test(s.project)
  if (![...catalog.scopes, ...selected].every(valid)) return false
  if (catalog.digest !== testScopeDigest([catalog.origin, catalog.fingerprint, catalog.runnerVersion, catalog.inventoryDigest, catalog.scopes])) return false
  const key = (s: { path: string; project?: string }) => JSON.stringify([s.path, s.project])
  const all = new Set(catalog.scopes.map(key)), expected = new Set(selected.map(key))
  if (all.size !== catalog.scopes.length || expected.size !== selected.length || selected.some(s => !all.has(key(s)))) return false
  return !c.complete || catalog.canonical && expected.size === c.files.length && c.files.every(f => expected.has(key(f)))
}
