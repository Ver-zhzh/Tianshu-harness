import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export function canonicalStoragePath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonicalStoragePath(parent), relative(parent, absolute))
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(canonicalStoragePath(root), canonicalStoragePath(path))
  return rel === '' || !rel.startsWith('..') && !isAbsolute(rel)
}

const protectedTestRoots = new Set<string>()
function temporaryTestPath(path: string): boolean {
  return within(tmpdir(), path) || within(join(process.cwd(), '.test-tmp'), path)
}

/** paths.ts invokes this before consumers evaluate, including direct node --test imports. */
export function isolateTestSessionHome(defaultHome: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return
  for (const key of ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_DESKTOP_DIR', 'RIVET_DESKTOP_SESSION_DIR']) {
    if (process.env[key] && !temporaryTestPath(process.env[key]!)) protectedTestRoots.add(canonicalStoragePath(process.env[key]!))
  }
  if (!process.env.RIVET_HOME || within(defaultHome, process.env.RIVET_HOME) || !temporaryTestPath(process.env.RIVET_HOME)) {
    const home = mkdtempSync(join(tmpdir(), 'rivet-direct-test-'))
    process.env.RIVET_HOME = home
    process.once('exit', () => { rmSync(home, { recursive: true, force: true }) })
  }
  for (const key of ['RIVET_SESSION_DIR', 'RIVET_DESKTOP_DIR', 'RIVET_DESKTOP_SESSION_DIR']) {
    if (process.env[key] && (within(defaultHome, process.env[key]!) || !temporaryTestPath(process.env[key]!))) delete process.env[key]
  }
}

export function assertTestSessionWrite(path: string, defaultHome: string): void {
  if (process.env.NODE_TEST_CONTEXT && [defaultHome, ...protectedTestRoots].some(root => within(root, path))) {
    throw sessionStorageSafetyError('RIVET_TEST_SESSION_WRITE: refusing to write real runtime data from a test; use an isolated RIVET_HOME/RIVET_SESSION_DIR')
  }
}

export function sessionStorageSafetyError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'RIVET_SESSION_STORAGE_BLOCKED' })
}

export function isSessionStorageSafetyError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'RIVET_SESSION_STORAGE_BLOCKED'
}
