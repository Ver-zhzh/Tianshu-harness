import { listWorktrees, hasUnlandedWork, commitAll, revParseHead, removeWorktree } from '../agent/worktree.js'
import type { SessionRecord } from './protocol.js'

/** Called only after the external-script ownership barrier has settled. */
export function cleanupArchivedWorktree(record: SessionRecord, shared: boolean): boolean {
  if (!record.worktreePath || shared) return false
  try {
    const origin = record.worktreeOriginCwd ?? listWorktrees(record.worktreePath)[0]?.path
    if (!origin) return false
    const work = hasUnlandedWork(origin, record.worktreePath, record.worktreeBranch)
    if (work.dirty) commitAll(record.worktreePath, 'rivet: archive checkpoint', { noVerify: true })
    const after = work.dirty || work.unmergedCommits > 0
      ? hasUnlandedWork(origin, record.worktreePath, record.worktreeBranch) : work
    const landed = Boolean(record.landedHead) && revParseHead(record.worktreePath) === record.landedHead
    const branchKept = Boolean(record.worktreeBranch) && after.unmergedCommits > 0 && !landed
    removeWorktree(origin, record.worktreePath, record.worktreeBranch, { keepBranch: branchKept })
    return branchKept
  } catch { return false }
}
