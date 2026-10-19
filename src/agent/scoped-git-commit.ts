import type { CommitVersion } from './commit-version.js'
import { captureCommitVersionAsync } from './commit-version-async.js'
import { gitCommand } from '../tools/git-command.js'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
  expectedVersion?: CommitVersion
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ScopedCommitResult {
  ok: boolean
  output: string
}

// ── Transient git lock retry ─────────────────────────────────────────
// index.lock contention is transient in multi-session workspaces (another
// git process exiting, a concurrent session mid-add). Bubbling it up to the
// LLM costs a full outer deliver_task retry (all pre-commit gates re-run,
// and the retried commit spawns a duplicate post-commit review worker).
// Retry in place with bounded backoff instead. The lock is NEVER deleted —
// it is likely held by a live process; on exhaustion the original error is
// returned unchanged.
const LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000]

function isLockContention(output: string): boolean {
  const lower = output.toLowerCase()
  return lower.includes('index.lock') && (lower.includes('file exists') || lower.includes('another git process'))
}

/** Classify owned paths before `git add`: a path missing from BOTH the worktree
 *  and the git index is stale — its deletion was already committed by another
 *  session. Staging it fails with a raw "pathspec did not match" error that
 *  costs a full outer deliver_task retry. Skip and report instead. A missing
 *  worktree copy still present in the index is a staged deletion (D status):
 *  `git add -- <path>` stages the removal, so it must be kept. */
async function classifyStalePaths(cwd: string, files: string[], signal?: AbortSignal): Promise<{ addable: string[]; stale: string[] }> {
  const addable: string[] = []
  const missing: string[] = []
  for (const f of files) {
    if (existsSync(join(cwd, f))) addable.push(f)
    else missing.push(f)
  }
  if (missing.length === 0) return { addable, stale: [] }
  const ls = await runGit(cwd, ['ls-files', '-z', '--', ...missing], signal)
  const inIndex = new Set(ls.ok ? ls.output.split('\0').filter(Boolean) : [])
  const stale: string[] = []
  for (const f of missing) {
    if (inIndex.has(f)) addable.push(f) // deletion not yet staged — git add stages it
    else stale.push(f)                  // gone from the index too — committed externally
  }
  return { addable, stale }
}

export async function commitScopedFiles(input: ScopedCommitInput): Promise<ScopedCommitResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs ?? 120_000), ...(input.signal ? [input.signal] : [])])
  signal.throwIfAborted()
  if (!input.message.trim()) return { ok: false, output: 'Commit message is required.' }

  const files = normalizeFiles(input.cwd, input.files)
  if (files.length === 0) return { ok: false, output: 'No owned files to commit.' }

  const { addable, stale } = await classifyStalePaths(input.cwd, files, signal)
  if (addable.length === 0) {
    return {
      ok: false,
      output: `No owned files to commit: every owned path is stale — already deleted and committed by another session: ${stale.join(', ')}. Refresh the owned set before retrying.`,
    }
  }
  const staleNote = stale.length > 0
    ? `⚠ Skipped ${stale.length} stale path(s) already committed externally: ${stale.join(', ')}\n`
    : ''

  const expected = input.expectedVersion ?? await captureCommitVersionAsync(input.cwd, addable, { signal })
  const current = await captureCommitVersionAsync(input.cwd, addable, { signal })
  if (!expected || !current || JSON.stringify(expected) !== JSON.stringify(current)) return { ok: false, output: 'Selected files, HEAD or index changed; refresh the commit preview.' }
  const staged = await runGit(input.cwd, ['diff', '--cached', '--name-only', '-z', '--', ...addable], signal)
  const unstaged = await runGit(input.cwd, ['diff', '--name-only', '-z', '--', ...addable], signal)
  if (!staged.ok || !unstaged.ok) return { ok: false, output: 'Cannot verify selected index contents.' }
  const unstagedPaths = new Set(unstaged.output.split('\0').filter(Boolean))
  if (staged.output.split('\0').some(file => unstagedPaths.has(file))) return { ok: false, output: 'Selected file is partially staged. Separate its hunks or explicitly commit the reviewed index in Git; no files were staged.' }

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const retryVersion = await captureCommitVersionAsync(input.cwd, addable, { signal })
    if (!retryVersion || retryVersion.head !== expected.head || retryVersion.files !== expected.files) return { ok: false, output: 'Selected snapshot changed during retry; refresh the commit preview.' }
    // add is idempotent — safe to re-run when the commit step hit a lock.
    const add = await runGit(input.cwd, ['add', '--', ...addable], signal)
    if (!add.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(add.output)) {
        await delayWait(delay, signal)
        continue
      }
      return add
    }

    const ready = await captureCommitVersionAsync(input.cwd, addable, { signal })
    if (!ready || ready.head !== expected.head || ready.files !== expected.files) return { ok: false, output: 'Selected snapshot changed during staging; changes remain available for review.' }
    const commit = await runGit(input.cwd, ['commit', '-m', input.message, '--only', '--', ...addable], signal)
    if (!commit.ok && commit.interrupted) {
      const observed = await captureCommitVersionAsync(input.cwd, addable)
      return { ok: false, output: observed?.head !== expected.head ? 'Commit outcome uncertain: HEAD changed. Inspect Git before retrying.' : 'Commit interrupted; inspect Git before retrying.' }
    }
    if (!commit.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(commit.output)) {
        await delayWait(delay, signal)
        continue
      }
      // Provide friendlier error for common "nothing changed" case
      const lower = commit.output.toLowerCase()
      if (lower.includes('nothing to commit') || lower.includes('no changes')) {
        return { ok: false, output: `No changes in owned files to commit (${addable.join(', ')}). Files may have been committed already or not modified.` }
      }
    }
    if (!commit.ok) return commit
    return { ok: true, output: staleNote + commit.output }
  }
}

function normalizeFiles(cwd: string, files: string[]): string[] {
  const normalized = files
    .map(file => {
      const resolved = resolve(cwd, file)
      const rel = relative(cwd, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      return rel
    })
    .filter((file): file is string => file !== null)
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

async function delayWait(ms: number, signal: AbortSignal): Promise<void> { await delay(ms, undefined, { signal }) }

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<ScopedCommitResult & { interrupted?: boolean }> {
  const result = await gitCommand(cwd, args, { signal })
  const output = `${result.stdout}${result.stderr}`.trim()
  return { ok: result.status === 0, output: output || (result.status === 0 ? '' : `git ${args[0] ?? 'command'} failed`), interrupted: result.interrupted }
}
