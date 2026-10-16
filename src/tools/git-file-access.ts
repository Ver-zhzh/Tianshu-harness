import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertSingleLinkFile } from '../utils/file-links.js'
import { detectSensitiveFile } from './sensitive-file-detector.js'

/** Git receives only exact files; a directory would expand the checked scope. */
export function inspectDiffFile(path: string): Stats | null {
  if (detectSensitiveFile(path).sensitive) throw new Error('Sensitive file blocked')
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Expected a single file')
    assertSingleLinkFile(path, stat)
    if (detectSensitiveFile(realpathSync(path)).sensitive) throw new Error('Sensitive file blocked')
    return stat
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

type GitReader = (args: string[], cwd: string) => Promise<{ ok: boolean; output: string }>
const MAX_COUNT_BYTES = 1_000_000

/** Filter before numstat reads worktree bytes, and bound argv size on Windows. */
export async function safeNumstat(cwd: string, base: string, paths: string[], run: GitReader): Promise<string> {
  const batches: string[][] = [[]]
  let bytes = 0
  for (const path of new Set(paths)) {
    try { inspectDiffFile(resolve(cwd, path)) } catch { continue }
    const cost = Buffer.byteLength(path, 'utf8') + 1
    if (cost > 12_000) continue
    if (bytes + cost > 12_000) { batches.push([]); bytes = 0 }
    batches[batches.length - 1]!.push(path)
    bytes += cost
  }
  const output: string[] = []
  for (const batch of batches) {
    if (!batch.length) continue // Empty pathspec would expose the entire worktree.
    const result = await run(['--literal-pathspecs', 'diff', base, '--numstat', '--', ...batch], cwd)
    if (result.ok) output.push(result.output)
  }
  return output.join('\n')
}

export async function backfillUntrackedAdditions(cwd: string, files: Array<{ path: string; status: string; additions: number }>): Promise<void> {
  await Promise.all(files.filter(file => file.status === 'untracked' && file.additions === 0).map(async file => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const path = resolve(cwd, file.path)
      const expected = inspectDiffFile(path)
      if (!expected?.isFile() || expected.size > MAX_COUNT_BYTES) return
      handle = await open(path, 'r')
      const actual = await handle.stat()
      assertSingleLinkFile(path, actual)
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size > MAX_COUNT_BYTES) return
      const buffer = Buffer.alloc(actual.size + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
        if (!read.bytesRead) break
        bytes += read.bytesRead
      }
      if (bytes > actual.size) return
      const content = buffer.subarray(0, bytes).toString('utf8')
      if (!content || content.includes('\u0000')) return
      file.additions = content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    } catch { /* Unreadable or unsafe: retain the zero badge. */ }
    finally { await handle?.close() }
  }))
}
