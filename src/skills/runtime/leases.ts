import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { createLockFileExclusive, isPidAlive, readLockFile, removeLockFile } from '../../server/cron-lock.js'
import { writeFileAtomicSync } from '../../fs-atomic.js'
import { ownedProcessTreeAlive } from '../../tools/process-exec.js'

export class EnvironmentBusyError extends Error {}
export interface ProcessLease {
  pid: number
  nonce: string
  phase: 'idle' | 'starting' | 'running'
  childPid?: number
}

/** A dead owner alone is insufficient: it may have left an interpreter running. */
export function leaseAlive(lease: { pid: number; phase?: string; childPid?: number }): boolean {
  if (!Number.isInteger(lease.pid) || lease.pid <= 0 || !['idle', 'starting', 'running'].includes(lease.phase ?? '')) return true
  if (isPidAlive(lease.pid)) return true
  if (lease.phase === 'starting') return true
  return lease.phase === 'running' && (!Number.isInteger(lease.childPid) || lease.childPid! <= 0 || ownedProcessTreeAlive(lease.childPid!))
}

export class EnvironmentLeases {
  constructor(private root: string) {}
  private path(key: string) { return join(this.root, `${key}.lock`) }
  private runs(key: string) { return join(this.root, '.leases', key) }

  gate<T>(key: string, work: () => T): T {
    const path = this.path(key) + '.gate'
    let made = createLockFileExclusive(path, { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() })
    if (!made.ok) {
      const recoveryPath = path + '.recovery'
      const recovery = createLockFileExclusive(recoveryPath, { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() })
      if (recovery.ok) {
        try {
          const owner = readLockFile(path)
          if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && !isPidAlive(owner.pid)) removeLockFile(path)
          made = createLockFileExclusive(path, { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() })
        } finally { removeLockFile(recoveryPath) }
      }
    }
    if (!made.ok) throw new EnvironmentBusyError('环境元数据正被另一进程操作，请重试')
    try { return work() } finally { removeLockFile(path) }
  }

  hasRuns(key: string): boolean {
    let names: string[]
    try { names = readdirSync(this.runs(key)) } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    for (const name of names) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) return true
      const path = join(this.runs(key), name)
      try {
        const lease = JSON.parse(readFileSync(path, 'utf8')) as ProcessLease
        if (!Number.isInteger(lease.pid) || leaseAlive(lease)) return true
        rmSync(path)
      } catch { return true }
    }
    return false
  }

  exclusiveAlive(key: string): boolean {
    const owner = readLockFile(this.path(key))
    if (!owner) return existsSync(this.path(key))
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true
    return leaseAlive(owner)
  }

  beginRun(key: string): (() => void) & { onSpawn(pid: number): void; retain(): void } {
    const path = join(this.runs(key), randomUUID() + '.json')
    const lease: ProcessLease = { pid: process.pid, nonce: randomUUID(), phase: 'starting' }
    this.gate(key, () => {
      if (this.exclusiveAlive(key)) throw new EnvironmentBusyError('环境正在准备或删除')
      mkdirSync(this.runs(key), { recursive: true })
      writeFileAtomicSync(path, JSON.stringify(lease))
    })
    let retained = false
    const release = Object.assign(() => { if (!retained) rmSync(path, { force: true }) }, {
      onSpawn: (pid: number) => { lease.phase = 'running'; lease.childPid = pid; writeFileAtomicSync(path, JSON.stringify(lease)) },
      retain: () => {
        retained = true
        const timer = setInterval(() => {
          if (lease.childPid && !ownedProcessTreeAlive(lease.childPid)) {
            try { rmSync(path, { force: true }); clearInterval(timer) } catch {}
          }
        }, 1000)
        timer.unref()
      },
    })
    return release
  }
}
