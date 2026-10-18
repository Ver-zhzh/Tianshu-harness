import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { defaultRivetHome, desktopDir, sessionsDir } from '../config/paths.js'
import { assertTestSessionWrite, canonicalStoragePath, sessionStorageSafetyError } from '../platform/test-session-isolation.js'
import { createLockFileExclusive, isPidAlive, readLockFile, removeLockFile, type LockInfo } from '../server/cron-lock.js'

const leases = new Map<string, { path: string; owner: LockInfo }>()
const maintenance = new Map<string, LockInfo>()
const owner = (): LockInfo => ({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString(), ownerToken: randomUUID() })
const control = (root: string) => join(root, '_storage-control')
const lockPath = (root: string) => join(control(root), 'maintenance.lock')

function validateControl(root: string): void {
  assertTestSessionWrite(root, defaultRivetHome())
  for (const path of [root, control(root), join(control(root), 'runtime')]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw sessionStorageSafetyError('Storage control path cannot be a symbolic link')
  }
}

function alive(info: LockInfo | null): boolean {
  return !info || info.hostname !== hostname() || !Number.isInteger(info.pid) || info.pid <= 0 || isPidAlive(info.pid)
}

function releaseOwned(path: string, info: LockInfo): void {
  if (readLockFile(path)?.ownerToken === info.ownerToken) removeLockFile(path)
}

/** Register before writes; keep the lease through deferred writes until process exit. */
export function registerStorageRuntime(inputRoot: string): void {
  const root = canonicalStoragePath(inputRoot)
  validateControl(root)
  if (maintenance.has(root)) throw sessionStorageSafetyError('Storage maintenance in progress; runtime cannot start')
  const existing = leases.get(root)
  if (existing) {
    if (readLockFile(existing.path)?.ownerToken !== existing.owner.ownerToken || existsSync(lockPath(root))) throw sessionStorageSafetyError('Storage runtime lease lost or maintenance in progress')
    return
  }
  const info = owner(), path = join(control(root), 'runtime', `${process.pid}-${info.ownerToken}.lock`)
  if (!createLockFileExclusive(path, info).ok) throw sessionStorageSafetyError('Cannot register storage runtime lease')
  // Register then check: a maintainer either observes this lease or blocks this writer.
  if (existsSync(lockPath(root))) {
    releaseOwned(path, info)
    throw sessionStorageSafetyError('Storage maintenance in progress; runtime cannot start')
  }
  leases.set(root, { path, owner: info })
}

process.once('exit', () => {
  for (const { path, owner } of leases.values()) { try { releaseOwned(path, owner) } catch { /* dead PID is reclaimed later */ } }
})

export function registerSessionStorageRuntime(additionalRoot?: string): void {
  registerStorageRuntime(sessionsDir())
  if (additionalRoot) registerStorageRuntime(additionalRoot)
}

/** Only explicit maintenance stores may publish canonical versions under an exclusive lease. */
export function assertStorageMaintenance(inputRoot: string): void {
  const root = canonicalStoragePath(inputRoot), info = maintenance.get(root)
  if (!info || readLockFile(lockPath(root))?.ownerToken !== info.ownerToken) throw sessionStorageSafetyError('Exclusive storage maintenance lease is required')
}

/** Unknown ownership is busy; an alive process never expires by directory mtime. */
export function acquireStorageMaintenance(inputRoot: string): () => void {
  const root = canonicalStoragePath(inputRoot)
  validateControl(root)
  // Older desktop runtimes do not publish root leases, but already hold these locks.
  for (const name of ['sidecar.lock', 'scheduled_tasks.lock']) {
    const path = join(desktopDir(), name)
    if (lstatSync(path, { throwIfNoEntry: false }) && alive(readLockFile(path))) throw new Error('Desktop runtime is active or its ownership is unknown; stop it before maintenance')
  }
  if (maintenance.has(root)) throw new Error('Storage maintenance already active')
  mkdirSync(control(root), { recursive: true, mode: 0o700 })
  const path = lockPath(root), info = owner()
  let created = createLockFileExclusive(path, info)
  if (!created.ok && created.reason === 'exists' && !alive(readLockFile(path))) {
    const reclaimPath = path + '.reclaim', reclaim = owner()
    if (!createLockFileExclusive(reclaimPath, reclaim).ok) throw new Error('Storage maintenance recovery is busy or requires inspection')
    try {
      if (alive(readLockFile(path))) throw new Error('Storage maintenance is busy')
      removeLockFile(path)
      created = createLockFileExclusive(path, info)
    } finally { releaseOwned(reclaimPath, reclaim) }
  }
  if (!created.ok) throw new Error('Storage maintenance is busy or has unknown ownership')
  try {
    const directory = join(control(root), 'runtime')
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      const leasePath = join(directory, name)
      if (lstatSync(leasePath).isSymbolicLink() || !name.endsWith('.lock')) throw new Error('Unknown storage runtime occupancy')
      const runtime = readLockFile(leasePath)
      if (alive(runtime)) throw new Error('Storage runtime still active; stop all CLI, desktop and worker processes before applying')
      releaseOwned(leasePath, runtime!)
    }
    maintenance.set(root, info)
    return () => { maintenance.delete(root); releaseOwned(path, info) }
  } catch (error) { releaseOwned(path, info); throw error }
}
