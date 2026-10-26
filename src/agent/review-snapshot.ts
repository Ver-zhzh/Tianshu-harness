import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { gitCommand } from '../tools/git-command.js'
import { openCandidateDeliveryTree } from './candidate-delivery-tree.js'
import { createVerificationSnapshot } from './verification-snapshot.js'

export interface ReviewSnapshotTarget {
  kind: 'dirty-diff' | 'commit' | 'range'
  files: string[]
  baseRef?: string
  headRef?: string
  capturedAt: number
}
export interface FrozenReviewSnapshot {
  cwd: string
  ref: string
  baseRef?: string
  headRef: string
  files: string[]
  diffFile: string
  isCurrent(): boolean
  destroy(): void
}

// Only snapshots created by this host may change a review worker's execution root.
const activeSnapshots = new Map<string, FrozenReviewSnapshot>()
export function reviewSnapshotCwd(snapshot: { cwd: string; ref: string }): string {
  const active = activeSnapshots.get(snapshot.ref)
  if (!active || active.cwd !== snapshot.cwd) throw new Error('Review snapshot is unavailable or not owned by this host')
  return active.cwd
}

export async function freezeReviewSnapshot(cwd: string, target: ReviewSnapshotTarget, signal?: AbortSignal): Promise<FrozenReviewSnapshot> {
  const git = async (args: string[]) => {
    const r = await gitCommand(cwd, args, { signal, timeoutMs: 30_000 })
    if (r.status !== 0) throw new Error(`Cannot capture review target: ${r.stderr || r.stdout}`)
    return r.stdout
  }
  const revision = async (ref: string) => (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
  let files = [...new Set(target.files)]
  if (files.some(file => !file || isAbsolute(file) || relative(cwd, resolve(cwd, file)).startsWith('..') || file.split(/[\\/]/).includes('.git'))) throw new Error('Review files must stay inside the repository')
  const headRef = await revision(target.kind === 'dirty-diff' ? 'HEAD' : target.headRef!)
  let baseRef: string | undefined
  let diff: string
  if (target.kind === 'dirty-diff') {
    baseRef = headRef
    diff = await git(['diff', '--no-ext-diff', '--no-color', headRef, '--', ...files])
  } else {
    if (target.kind === 'range') baseRef = await revision(target.baseRef!)
    else {
      const parents = (await git(['rev-list', '--parents', '-n', '1', headRef])).trim().split(/\s+/)
      baseRef = parents[1]
    }
    files = (await git(baseRef ? ['diff', '--name-only', '-z', baseRef, headRef, '--'] : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', headRef, '--'])).split('\0').filter(Boolean)
    diff = await git(baseRef ? ['diff', '--no-ext-diff', '--no-color', baseRef, headRef, '--'] : ['show', '--format=', '--no-ext-diff', '--no-color', headRef, '--'])
  }
  const tree = target.kind === 'dirty-diff'
    ? await openCandidateDeliveryTree(cwd, files, signal)
    : await createVerificationSnapshot({ baseCwd: cwd, sessionId: `review-${randomUUID()}`, baselineHead: headRef, ownedFiles: [] })
  try {
    if (target.kind === 'dirty-diff') {
      const captured = await gitCommand(tree.path, ['diff', '--no-ext-diff', '--no-color', headRef, '--', ...files], { signal, timeoutMs: 30_000 })
      if (captured.status !== 0 || captured.stdout !== diff) throw new Error('Review target changed while capturing its diff')
      const added = await gitCommand(tree.path, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files], { signal })
      const newFiles = added.stdout.split('\0').filter(Boolean)
      if (newFiles.length) {
        const indexed = await gitCommand(tree.path, ['add', '--intent-to-add', '--', ...newFiles], { signal })
        if (indexed.status !== 0) throw new Error('Cannot capture added review files')
        const complete = await gitCommand(tree.path, ['diff', '--no-ext-diff', '--no-color', headRef, '--', ...files], { signal })
        if (complete.status !== 0) throw new Error('Cannot capture review diff')
        diff = complete.stdout
      }
    }
    const diffFile = `.review-${randomUUID()}.patch`
    writeFileSync(join(tree.path, diffFile), diff)
    const snapshot: FrozenReviewSnapshot = { cwd: tree.path, ref: `review-${randomUUID()}`, baseRef, headRef, files, diffFile,
      isCurrent: () => 'isCurrent' in tree ? tree.isCurrent() : true,
      destroy() { activeSnapshots.delete(snapshot.ref); tree.destroy() },
    }
    activeSnapshots.set(snapshot.ref, snapshot)
    return snapshot
  } catch (error) { tree.destroy(); throw error }
}
