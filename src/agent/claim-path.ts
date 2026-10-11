import { posix, win32 } from 'node:path'

/** One lexical key for write guards, workers, ledgers and persisted claims.
 * Keep outside-workspace absolute paths absolute; never turn them into a
 * workspace-relative alias. win32 is explicit so Windows fixtures and stored
 * Windows paths behave identically on every host. */
export function normalizeClaimPath(cwd: string | undefined, filePath: string): string {
  const slash = (value: string) => value.replace(/\\/g, '/')
  const path = slash(filePath)
  const windows = /^[a-z]:[/]/i.test(path) || /^[a-z]:[/]/i.test(slash(cwd ?? '')) || path.startsWith('//')
  const api = windows ? win32 : posix
  if (!cwd) return slash(api.normalize(path))
  const root = slash(cwd)
  const abs = api.resolve(root, path)
  const rel = slash(api.relative(root, abs))
  return rel !== '..' && !rel.startsWith('../') && !api.isAbsolute(rel)
    ? rel || '.'
    : slash(api.normalize(abs))
}
