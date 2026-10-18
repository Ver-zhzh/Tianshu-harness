/** Compatibility API: automatic history eviction is disabled; explicit deletion stays separate. */
export function evictOldSessions(_keepSessionId: string, _cwd: string): string[] {
  return []
}
