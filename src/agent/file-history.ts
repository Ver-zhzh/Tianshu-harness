import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { OaiMessage } from '../api/oai-types.js'
import { cpuPool } from '../workers/cpu-pool.js'
import { diffLinesRaw } from '../workers/cpu-tasks.js'
import type { RawChange } from '../workers/cpu-tasks.js'
import { WRITE_TOOL_NAMES } from '../tools/write-tool-helpers.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { claimPathCandidates, makePathClaimResolver, type ClaimRef, type PathClaimLookup } from './pre-write-claims.js'

const MAX_SNAPSHOTS = 100

/**
 * A rewind target another live session is editing. The path must be skipped:
 * undo/rewind is a workspace write and has to follow the same exclusive-claim
 * discipline as write_file/edit_file/hash_edit/ast_edit/apply_patch. Before
 * this guard existed the two paths were asymmetric — the write tools blocked
 * but rewind wrote straight through, so an idle session could clobber a peer's
 * in-flight edit and still report restored=true.
 */
export interface BlockedRewindFile {
  path: string
  sessionId: string
  claimType: string
}

/** Structural guard injected into FileHistory. Consumers can pass the shared
 *  makeOwnershipGuard(), a plain { isOwnedByOther } stub, or a predicate —
 *  tests and lightweight callers stay decoupled from SessionRegistry. */
export interface RewindClaimGuard {
  blockerOf?(filePath: string): ClaimRef | null
  isOwnedByOther?(filePath: string): boolean
  /** Raw SessionRegistry support for probe/test callers that inject the
   *  registry directly. Checks the exact tracked path first, then the standard
   *  claim-key candidates derived from process.cwd(). Prefer blockerOf /
   *  makeOwnershipGuard in production so the real workspace cwd is used. */
  checkClaim?(filePath: string, excludeSessionId?: string): ClaimRef | null
  reapStaleClaims?(): unknown
}
export type RewindGuard = RewindClaimGuard | ((filePath: string) => boolean)

/** Convenience wrapper accepted by the same parameters: existing callers can
 *  pass a guard directly (or a registry via constructor/setClaimGuard), while
 *  newer call sites can pass the workspace context alongside. */
export interface RewindGuardOptions {
  guard?: RewindGuard
  claimGuard?: RewindGuard
  registry?: PathClaimLookup
  cwd?: string
  sessionId?: string
}
export type RewindGuardInput = RewindGuard | RewindGuardOptions

/**
 * Rewind's return value keeps the historical `string[]` shape (callers and
 * tests deep-equal it), with the report attached as non-enumerable properties.
 * That lets guarded callers read changed/skipped without a breaking API
 * change: `const changed = await fh.rewindToBoundary(ids, guard)` still works
 * as an array, and `changed.skipped` names the peer-claimed files left alone.
 */
export type RewindOutcome = string[] & {
  readonly filesChanged: string[]
  readonly restored: string[]
  readonly skipped: string[]
  readonly skippedBy: BlockedRewindFile[]
  readonly blocked: BlockedRewindFile[]
}

function unwrapRewindGuard(input: RewindGuardInput | undefined, mySessionId: string): RewindGuard | undefined {
  if (!input) return undefined
  if (typeof input === 'function') return input
  const opts = input as RewindGuardOptions
  const nested = opts.guard ?? opts.claimGuard
  if (nested) return nested
  if (opts.registry && typeof opts.registry.checkClaim === 'function') {
    return makePathClaimResolver(opts.registry, opts.sessionId ?? mySessionId, opts.cwd ?? process.cwd())
  }
  return input as RewindGuard
}

function resolveRewindBlocker(
  input: RewindGuardInput | undefined,
  filePath: string,
  mySessionId: string,
): BlockedRewindFile | null {
  const guard = unwrapRewindGuard(input, mySessionId)
  if (!guard) return null
  if (typeof guard === 'function') {
    return guard(filePath) ? { path: filePath, sessionId: 'another-session', claimType: 'exclusive' } : null
  }
  if (typeof guard.blockerOf === 'function') {
    const claim = guard.blockerOf(filePath)
    if (claim) return { path: filePath, sessionId: claim.sessionId, claimType: claim.claimType }
  }
  if (typeof guard.checkClaim === 'function') {
    // Raw registry injected by probes/lightweight callers: exact path first,
    // then the same candidate key forms the production resolver uses. Reap
    // crashed sessions first so a dead peer cannot permanently block rewind.
    try { guard.reapStaleClaims?.() } catch { /* best-effort */ }
    const keys = new Set([filePath, ...claimPathCandidates(process.cwd(), filePath)])
    for (const key of keys) {
      const claim = guard.checkClaim.call(guard, key, mySessionId)
      if (claim && claim.sessionId !== mySessionId) {
        return { path: filePath, sessionId: claim.sessionId, claimType: claim.claimType }
      }
    }
  }
  if (typeof guard.isOwnedByOther === 'function' && guard.isOwnedByOther(filePath)) {
    return { path: filePath, sessionId: 'another-session', claimType: 'exclusive' }
  }
  return null
}

function attachRewindOutcome(filesChanged: string[], blocked: BlockedRewindFile[]): RewindOutcome {
  const skipped = blocked.map((b) => b.path)
  Object.defineProperties(filesChanged, {
    filesChanged: { value: filesChanged, enumerable: false },
    restored: { value: filesChanged, enumerable: false },
    skipped: { value: skipped, enumerable: false },
    skippedBy: { value: blocked, enumerable: false },
    blocked: { value: blocked, enumerable: false },
  })
  return filesChanged as RewindOutcome
}

/**
 * Atomic restore write: temp file + rename, so a crash mid-write cannot leave a
 * truncated file (the old bare writeFile could). writeFileAtomicAsync creates
 * the temp with mode 0600, so an existing file's permission bits are copied
 * back afterwards — restoring source files must not silently strip 0644/exec
 * bits.
 */
async function writeRestoredFile(filePath: string, content: string): Promise<void> {
  let mode: number | undefined
  try { mode = (await stat(filePath)).mode & 0o777 } catch { /* new file */ }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFileAtomicAsync(filePath, content)
  if (mode !== undefined) {
    try { await chmod(filePath, mode) } catch { /* contents already restored; mode best-effort */ }
  }
}

/**
 * The write-tool tool_use ids whose calls occurred at or after `messageIndex`
 * — i.e. edits made after a conversation boundary. These key the FileHistory
 * snapshots a precise rewind to that boundary undoes. The tool roster is the
 * shared WRITE_TOOL_NAMES (write_file / edit_file / hash_edit / ast_edit /
 * apply_patch) — the same set tool-pipeline tracks via trackEdit, so every
 * agent-edited file is rewindable regardless of which write tool made the
 * edit. Shared by the server (session-manager) and the in-process TUI rewind
 * flow so both compute the boundary identically.
 */
export function collectPostBoundaryEditIds(messages: OaiMessage[], messageIndex: number): Set<string> {
  const ids = new Set<string>()
  for (let i = messageIndex; i < messages.length; i++) {
    const m = messages[i]
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name
        if (name && WRITE_TOOL_NAMES.has(name)) ids.add(tc.id)
      }
    }
  }
  return ids
}

export interface FileBackup {
  backupFileName: string | null
  version: number
  timestamp: number
  /** 旧内容存在但备份读取失败（AV/EDR 锁、EBUSY…）。rewind 必须跳过该文件：
   *  此时「没有备份」≠「文件当时不存在」，null-only 语义会把 undo 变成删除。 */
  unreadable?: true
}

export interface FileSnapshot {
  messageId: string
  trackedFileBackups: Record<string, FileBackup>
  timestamp: number
}

export interface DiffStats {
  filesChanged: string[]
  insertions: number
  deletions: number
}

export class FileHistory {
  private snapshots: FileSnapshot[] = []
  private trackedFiles = new Set<string>()

  constructor(
    private backupDir: string,
    private sessionId: string,
    private claimGuard?: RewindGuardInput,
  ) {}

  /** Late-bind the cross-session guard (bootstrap creates the registry before
   *  /cd can move the workspace, so the guard can also be swapped with cwd). */
  setClaimGuard(claimGuard?: RewindGuardInput): void {
    this.claimGuard = claimGuard
  }

  /**
   * /cd 换工作区后按新备份根重建实例（备份根焊死构造期 cwd，不能原地复用）。
   * 备份文件已随 migrateSessionFiles 整体迁到新 slug 目录，内存快照与 tracked
   * 名单原样随迁——新实例对接管前的全部 undo 历史仍然可读可回滚，无缝接管。
   * 继续复用旧实例的后果：rewind 读旧路径备份 ENOENT 被当「missing」静默跳过
   * （撤销无声丢失）、新编辑在旧项目路径 mkdir 复活旧会话目录（跨项目状态脑裂）。
   * claim guard 随迁（cwd 变了，调用方可在重建后 setClaimGuard 指向新工程）。
   */
  withBackupRoot(backupDir: string): FileHistory {
    const next = new FileHistory(backupDir, this.sessionId, this.claimGuard)
    next.snapshots = this.snapshots
    next.trackedFiles = this.trackedFiles
    return next
  }

  /** First blocker among the per-call guard and the instance guard. Both are
   *  consulted so a stronger caller guard can never accidentally weaken a
   *  configured one (and vice versa). */
  private blockerFor(filePath: string, guard?: RewindGuardInput): BlockedRewindFile | null {
    return resolveRewindBlocker(guard, filePath, this.sessionId)
      ?? resolveRewindBlocker(this.claimGuard, filePath, this.sessionId)
  }

  async trackEdit(filePath: string, messageId: string): Promise<void> {
    this.trackedFiles.add(filePath)

    const lastSnapshot = this.snapshots.at(-1)
    if (lastSnapshot?.messageId === messageId && lastSnapshot.trackedFileBackups[filePath]) {
      return
    }

    let version = 1
    for (const s of this.snapshots) {
      const b = s.trackedFileBackups[filePath]
      if (b && b.version >= version) version = b.version + 1
    }

    let backup: FileBackup
    try {
      const content = await readFile(filePath, 'utf-8')
      const fileNameHash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
      const backupFileName = `${fileNameHash}@v${version}`
      const backupPath = join(this.backupDir, this.sessionId, backupFileName)
      await mkdir(dirname(backupPath), { recursive: true })
      await writeFile(backupPath, content, 'utf-8')
      backup = { backupFileName, version, timestamp: Date.now() }
    } catch (err) {
      // null 哨兵只保留一个含义：「trackEdit 时文件不存在」（rewind 据此 unlink）。
      // 存在但读不了是另一个世界——标记 unreadable，让 rewind 跳过而不是删掉原文。
      const unreadable = (err as NodeJS.ErrnoException)?.code !== 'ENOENT'
      backup = { backupFileName: null, version, timestamp: Date.now(), ...(unreadable ? { unreadable: true } : {}) }
    }

    if (lastSnapshot && lastSnapshot.messageId === messageId) {
      lastSnapshot.trackedFileBackups[filePath] = backup
    } else {
      const snapshot: FileSnapshot = {
        messageId,
        trackedFileBackups: { [filePath]: backup },
        timestamp: Date.now(),
      }
      this.snapshots.push(snapshot)
      if (this.snapshots.length > MAX_SNAPSHOTS) {
        const evicted = this.snapshots.slice(0, this.snapshots.length - MAX_SNAPSHOTS)
        this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
        for (const s of evicted) {
          for (const b of Object.values(s.trackedFileBackups)) {
            if (b.backupFileName) {
              try { await unlink(join(this.backupDir, this.sessionId, b.backupFileName)) } catch { /* already gone */ }
            }
          }
        }
      }
    }
  }

  async rewind(targetMessageId: string, guard?: RewindGuardInput): Promise<RewindOutcome> {
    let targetSnapshot: FileSnapshot | undefined
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.messageId === targetMessageId) {
        targetSnapshot = this.snapshots[i]
        break
      }
    }
    if (!targetSnapshot) {
      throw new Error(`Snapshot for ${targetMessageId} not found`)
    }

    const filesChanged: string[] = []
    const blocked: BlockedRewindFile[] = []
    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue

      // Undo is a workspace write: never touch a path another live session is
      // editing. Both delete and restore branches must be blocked (a null
      // backup means this edit created the file; deleting under a peer's
      // exclusive claim would destroy their work).
      const blocker = this.blockerFor(filePath, guard)
      if (blocker) {
        blocked.push(blocker)
        continue
      }

      if (targetBackup.backupFileName === null) {
        if (targetBackup.unreadable) continue // 备份没拿到 ≠ 文件当时不存在——不能拿 undo 当删除用
        try {
          await unlink(filePath)
          filesChanged.push(filePath)
        } catch { /* already gone */ }
        continue
      }

      const backupPath = join(this.backupDir, this.sessionId, targetBackup.backupFileName)
      try {
        const content = await readFile(backupPath, 'utf-8')
        await writeRestoredFile(filePath, content)
        filesChanged.push(filePath)
      } catch { /* backup missing, skip */ }
    }
    return attachRewindOutcome(filesChanged, blocked)
  }

  /**
   * Precise rewind to a conversation boundary: restore every tracked file that
   * was edited AFTER the boundary back to its content as of that boundary, and
   * delete files first created after it.
   *
   * `postBoundaryIds` = the set of write-tool tool_use ids (all of
   * WRITE_TOOL_NAMES — write_file / edit_file / hash_edit / ast_edit /
   * apply_patch) whose calls occurred after the boundary, in message order.
   * For each file the
   * EARLIEST post-boundary snapshot that touched it holds the file's pre-edit
   * content — which is exactly its state at the boundary (no edits happened
   * between the boundary and that first post-boundary edit). Restoring that
   * backup (or deleting it when the backup is null, i.e. the file did not yet
   * exist at the boundary) rewinds the file precisely to the boundary while
   * preserving any edits made before it. Entries whose backup read failed at
   * edit time are skipped: no backup ≠ file absent, and deleting it would turn
   * a rewind into data loss. Files exclusively claimed by another live session
   * are skipped and reported via `.skipped` / `.skippedBy` on the returned
   * array — same write-path discipline as the five write tools.
   */
  async rewindToBoundary(postBoundaryIds: Set<string>, guard?: RewindGuardInput): Promise<RewindOutcome> {
    const targets = this.firstBackupPerFile(postBoundaryIds)
    const filesChanged: string[] = []
    const blocked: BlockedRewindFile[] = []
    for (const [filePath, backup] of targets) {
      const blocker = this.blockerFor(filePath, guard)
      if (blocker) {
        blocked.push(blocker)
        continue
      }
      if (backup.backupFileName === null) {
        if (backup.unreadable) continue
        try {
          await unlink(filePath)
          filesChanged.push(filePath)
        } catch { /* already gone */ }
        continue
      }
      const backupPath = join(this.backupDir, this.sessionId, backup.backupFileName)
      try {
        const content = await readFile(backupPath, 'utf-8')
        await writeRestoredFile(filePath, content)
        filesChanged.push(filePath)
      } catch { /* backup missing, skip */ }
    }
    return attachRewindOutcome(filesChanged, blocked)
  }

  /** Files a boundary rewind would touch, for a pre-confirm preview. Each entry
   *  is marked `blocked` when another live session's claim currently guards it,
   *  so the UI can warn before the user confirms a partial rewind. */
  getBoundaryFiles(
    postBoundaryIds: Set<string>,
    guard?: RewindGuardInput,
  ): { path: string; action: 'restore' | 'delete' | 'unreadable' | 'blocked'; blockedBy?: string }[] {
    return [...this.firstBackupPerFile(postBoundaryIds)].map(([path, b]) => {
      const blocker = this.blockerFor(path, guard)
      if (blocker) {
        return {
          path,
          action: 'blocked' as const,
          ...(blocker.sessionId !== 'another-session' ? { blockedBy: blocker.sessionId } : {}),
        }
      }
      return {
        path,
        action: b.backupFileName === null ? (b.unreadable ? 'unreadable' : 'delete') : 'restore',
      }
    })
  }

  /** For each file, the backup captured by its earliest post-boundary edit. */
  private firstBackupPerFile(postBoundaryIds: Set<string>): Map<string, FileBackup> {
    const firstPer = new Map<string, FileBackup>()
    // snapshots are held in chronological push order
    for (const snap of this.snapshots) {
      if (!postBoundaryIds.has(snap.messageId)) continue
      for (const [filePath, backup] of Object.entries(snap.trackedFileBackups)) {
        if (!firstPer.has(filePath)) firstPer.set(filePath, backup)
      }
    }
    return firstPer
  }

  async getDiffStats(targetMessageId: string): Promise<DiffStats | undefined> {
    let targetSnapshot: FileSnapshot | undefined
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.messageId === targetMessageId) {
        targetSnapshot = this.snapshots[i]
        break
      }
    }
    if (!targetSnapshot) return undefined

    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0

    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue
      if (targetBackup.unreadable) continue // 无备份可比对，避免把「撤不了」误报成整文件删除

      let oldContent = ''
      if (targetBackup.backupFileName !== null) {
        try {
          oldContent = await readFile(join(this.backupDir, this.sessionId, targetBackup.backupFileName), 'utf-8')
        } catch { /* skip */ }
      }

      let newContent = ''
      try {
        newContent = await readFile(filePath, 'utf-8')
      } catch { /* file deleted */ }

      if (oldContent === newContent) continue
      filesChanged.push(filePath)

      // Bounded diff: Myers on a heavily-rewritten large file is unbounded
      // sync CPU (blocks the event loop — same root cause as edit-diff.ts).
      // Stats are display-only; on timeout fall back to a coarse line-count
      // estimate instead of exact insert/delete counts.
      // Try worker pool first (4s, non-blocking), then inline (1s).
      const POOL_TIMEOUT = 4000
      const INLINE_TIMEOUT = 1000
      let changes: RawChange[] | undefined
      if (cpuPool.available) {
        try {
          changes = (await cpuPool.run('diffLinesRaw', [
            oldContent,
            newContent,
            POOL_TIMEOUT,
          ])) as RawChange[] | undefined
        } catch {
          // Pool unavailable or timed out — fall through to inline
        }
      }
      if (changes === undefined) {
        changes = diffLinesRaw(oldContent, newContent, INLINE_TIMEOUT)
      }
      if (changes === undefined) {
        insertions += newContent.length === 0 ? 0 : newContent.split('\n').length
        deletions += oldContent.length === 0 ? 0 : oldContent.split('\n').length
        continue
      }
      for (const c of changes) {
        if (c.added) insertions += c.count ?? 0
        if (c.removed) deletions += c.count ?? 0
      }
    }

    return { filesChanged, insertions, deletions }
  }

  hasSnapshot(messageId: string): boolean {
    return this.snapshots.some(s => s.messageId === messageId)
  }

  getLatestSnapshotId(): string | undefined {
    return this.snapshots.at(-1)?.messageId
  }

  getAllSnapshots(): FileSnapshot[] {
    return this.snapshots
  }

  async cleanupOrphans(): Promise<number> {
    const sessionDir = join(this.backupDir, this.sessionId)
    let dirEntries: string[]
    try {
      dirEntries = await readdir(sessionDir)
    } catch {
      return 0
    }

    const referencedBackups = new Set<string>()
    for (const snapshot of this.snapshots) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName) {
          referencedBackups.add(backup.backupFileName)
        }
      }
    }

    let removed = 0
    for (const entry of dirEntries) {
      if (!referencedBackups.has(entry)) {
        try {
          await unlink(join(sessionDir, entry))
          removed++
        } catch {
          // File already gone or permission issue — skip
        }
      }
    }
    return removed
  }
}
