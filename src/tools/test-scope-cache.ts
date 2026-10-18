import type { TestScope } from './test-scope-catalog.js'

const inventories = new Map<string, TestScope[]>()
/** Bounded process cache; only a successfully checked native execution may populate it. */
export function cachedTestScopes(key: string): TestScope[] | undefined {
  const value = inventories.get(key)
  return value && structuredClone(value)
}
export function cacheTestScopes(key: string, scopes: TestScope[]): void {
  inventories.delete(key)
  inventories.set(key, structuredClone(scopes))
  while (inventories.size > 8) inventories.delete(inventories.keys().next().value!)
}
