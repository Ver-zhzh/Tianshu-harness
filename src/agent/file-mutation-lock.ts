import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { dirname, basename, resolve } from 'node:path'

const held = new AsyncLocalStorage<ReadonlySet<string>>()
const tails = new Map<string, Promise<void>>()
function key(path: string): string {
  try { return realpathSync(path) } catch {
    try { return resolve(realpathSync(dirname(path)), basename(path)) } catch { return resolve(path) }
  }
}

/** Process-local serialization complements, rather than replaces, claims and version checks. */
export async function withFileMutationLocks<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  const inherited = held.getStore() ?? new Set<string>()
  const keys = [...new Set(paths.map(key))].filter(p => !inherited.has(p)).sort()
  const releases: Array<() => void> = []
  try {
    for (const path of keys) {
      const prior = tails.get(path) ?? Promise.resolve()
      let release!: () => void
      const tail = new Promise<void>(resolve => { release = resolve })
      tails.set(path, tail)
      await prior
      releases.push(() => { release(); if (tails.get(path) === tail) tails.delete(path) })
    }
    return await held.run(new Set([...inherited, ...keys]), run)
  } finally { releases.reverse().forEach(release => release()) }
}
