/** The delivery object is the requested intent, not the ownership delta. */
export function deliveryCandidateScope(
  requested: readonly string[] | undefined,
  adopt: readonly string[] | undefined,
  owned: readonly string[],
  dirty: readonly string[] | undefined,
): string[] {
  const dirtySet = dirty ? new Set(dirty) : undefined
  const base = requested ?? owned.filter(file => !dirtySet || dirtySet.has(file))
  return [...new Set([...base, ...(adopt ?? [])])].sort()
}
