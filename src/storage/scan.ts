import { lstat, opendir, open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { canonicalStoragePath } from '../platform/test-session-isolation.js'

export interface StorageEntry { root: string; path: string; relative: string; bytes: number; allocatedBytes: number; mtimeMs: number; dev: number; ino: number; symlink: boolean }
export interface ScanError { path: string; error: string; code?: string }
export function distinctStorageRoots(roots: string[]): string[] {
  const sorted = [...new Set(roots.map(canonicalStoragePath))].sort((a, b) => a.length - b.length)
  return sorted.filter((root, i) => !sorted.slice(0, i).some(parent => {
    const rel = relative(parent, root)
    return rel === '' || !rel.startsWith('..') && !isAbsolute(rel)
  }))
}

/** Streaming traversal, one directory handle and bounded work per event-loop slice. */
export async function* scanStorage(roots: string[], errors: ScanError[], signal?: AbortSignal, options: { skipControl?: boolean } = {}): AsyncGenerator<StorageEntry> {
  let visited = 0
  for (const root of distinctStorageRoots(roots)) {
    const stack = [root]
    while (stack.length) {
      signal?.throwIfAborted()
      const directory = stack.pop()!
      try {
        if ((await lstat(directory)).isSymbolicLink()) { errors.push({ path: directory, error: 'Symbolic directory skipped' }); continue }
        for await (const entry of await opendir(directory)) {
          signal?.throwIfAborted()
          if (options.skipControl && directory === root && entry.name === '_storage-control') continue
          const path = join(directory, entry.name)
          try {
            const st = await lstat(path)
            if (st.isDirectory()) stack.push(path)
            else if (st.isFile() || st.isSymbolicLink()) yield { root, path, relative: relative(root, path).replaceAll('\\', '/'), bytes: st.size,
              allocatedBytes: typeof st.blocks === 'number' ? st.blocks * 512 : st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, symlink: st.isSymbolicLink() }
          } catch (error) { errors.push({ path, error: String(error) }) }
          if (++visited % 128 === 0) await yieldToLoop()
        }
      } catch (error) {
        signal?.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory !== root) errors.push({ path: directory, error: String(error) })
      }
    }
  }
}

export async function readSnapshotVersion(path: string): Promise<number | 'unknown'> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(128), { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const match = /^\s*\{\s*"v"\s*:\s*(\d+)/.exec(bytes.subarray(0, bytesRead).toString())
    return match ? Number(match[1]) : 'unknown'
  } finally { await file.close() }
}
