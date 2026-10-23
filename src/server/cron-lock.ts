/**
 * Cron Lock — PID 租约锁
 *
 * 保证多个天枢进程（各起 server）中恰好一个当 scheduler。
 *
 * 功能：
 * 1. O_EXCL 原子创建 .rivet/scheduled_tasks.lock
 * 2. PID 存活探测：ps -p <pid> -o state= | grep -v Z（避免 zombie 盲区）
 * 3. 陈旧锁回收（owner PID 不存在 → 接管）
 * 4. 退出清理（正常退出删锁）
 *
 * 部署假设：
 * - 锁仅在多进程各起 server 时有效
 * - 单 daemon 进程则锁 YAGNI —— scheduler 是进程内单例
 * - MVP 可降级为单进程无锁调度
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  linkSync,
  lstatSync,
  rmdirSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname as osHostname } from 'node:os'
import { probeLockMachineId } from './lock-machine-id.js'
import { isMainThread } from 'node:worker_threads'
import { publishLockDirectoryExclusive } from './lock-filesystem.js'

// ─── Types ────────────────────────────────────────────────────

export interface LockInfo {
  pid: number
  acquiredAt: string
  hostname: string
  ownerToken?: string
  startedAtMs?: number
  /** Hash of a stable hardware identity. Absent from locks written by older versions. */
  machineId?: string
}

function sameLockIdentity(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.ownerToken === b.ownerToken &&
    a.startedAtMs === b.startedAtMs && a.machineId === b.machineId
}

export interface CronLockConfig {
  /** 锁文件路径 */
  lockPath?: string
  /** PID 存活检查间隔（毫秒） */
  healthCheckIntervalMs?: number
  /** 锁丢失回调：锁被删除或被其他进程抢占时触发 */
  onLockLost?: (state: LockState) => void
  /** 僵尸进程探测（issue #530）；默认 probeProcessZombie。测试可注入。 */
  isProcessZombie?: (pid: number) => Promise<boolean>
  machineId?: () => Promise<string | undefined>
  hostname?: () => string
  allowLegacyHostRecovery?: boolean
}

export type LockState =
  | { status: 'acquired'; info: LockInfo }
  | { status: 'contended'; owner: LockInfo }
  | { status: 'stale_recovered'; previousOwner: LockInfo; info: LockInfo }
  | { status: 'error'; reason: string }

/** 原子锁文件创建结果。导出给其他 PID 租约锁（store-lock）复用，不改变 CronLock 行为。 */
export type CreateLockResult =
  | { ok: true }
  | { ok: false; reason: 'exists' }
  | { ok: false; reason: 'error'; message: string }

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_LOCK_PATH = '.rivet/scheduled_tasks.lock'
const DEFAULT_HEALTH_CHECK_MS = 10_000
const PROCESS_OWNER_TOKEN = randomUUID()
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1000)

// ─── PID Liveness ─────────────────────────────────────────────

/**
 * 检查 PID 是否存活（Linux 排除 zombie）。
 * ⚠ macOS/BSD 盲区（issue #530）：僵尸进程的 `kill(0)` 照样成功且此函数无法区分
 * （不 spawn 子进程，见 S-6）——需要「确定已死」语义（锁回收判死）的调用方改用
 * 异步的 `probeProcessZombie`。EPERM 视为活着（防脑裂）。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM = process exists but is owned by another user → still alive. Treat
    // it as alive so we never reclaim a lock from a process that may be live
    // (the safe direction for split-brain avoidance). Any other code (ESRCH
    // "no such process", etc.) means dead.
    if (errorCode(error) === 'EPERM') return true
    return false
  }
  // `kill(pid, 0)` succeeds for zombie processes too (the PID still occupies a
  // slot until reaped), but a zombie can no longer run the scheduler — treating
  // it as alive would block failover forever. On Linux, read /proc/<pid>/stat
  // (non-blocking, no subprocess) to exclude zombies, matching the old
  // `ps -o state=` behaviour. Other platforms fall through as alive.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      if (isProcStatZombie(stat)) return false
    } catch {
      // /proc unavailable (e.g. container without procfs) → fall through alive.
    }
  }
  return true
}

/**
 * True if a `/proc/<pid>/stat` line reports a zombie (state `Z`).
 *
 * The state char is the first field after the comm field. comm is wrapped in
 * parentheses and may itself contain `)` (e.g. `(foo) bar`), so we split after
 * the LAST `)` to skip comm reliably — matching how the kernel/procps parse it.
 */
export function isProcStatZombie(statLine: string): boolean {
  const afterComm = statLine.slice(statLine.lastIndexOf(')') + 1).trimStart()
  return afterComm[0] === 'Z'
}

/** 单次 ps state 探测上限（毫秒）。与 store-lock 的进程探测同一量级。 */
const ZOMBIE_PROBE_TIMEOUT_MS = 2_000

/**
 * ps state 输出是否表明僵尸（trim 后首字符 `Z`）。
 * 空输出/不可解析 → false：探测不可核验时不判死（误判占用可恢复，误判失效=双写）。
 */
export function isPsStateZombie(stateOutput: string): boolean {
  return stateOutput.trim()[0] === 'Z'
}

/**
 * 异步判定 PID 是否为**僵尸**进程（issue #530：睡眠唤醒后死进程收不回锁）。
 *
 * `kill(pid, 0)` 对僵尸进程照样成功（macOS 上 PID 占位直到被 reap），且僵尸保留真实
 * lstart——`isPidAlive` + 启动时间比对两条判据全失效，新进程永远收不回锁。
 * 判定分支：
 *   - linux：`/proc/<pid>/stat` 同步读（廉价，与 isPidAlive 同一判据）；
 *   - darwin/bsd：`ps -o state=` ——**异步有界**（execFile + 超时 + unref，绝不
 *     execFileSync 阻塞事件循环，见 S-6 教训）；
 *   - win32：恒 false（Windows 无僵尸概念，kill(0) 对已死进程直接抛 ESRCH）。
 * 探测失败/超时/进程不存在 → false（不判死，按不可核验=占用处理）。
 */
export function probeProcessZombie(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false)
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(isProcStatZombie(readFileSync(`/proc/${pid}/stat`, 'utf-8')))
    } catch {
      return Promise.resolve(false)
    }
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    return new Promise((resolve) => {
      let child
      try {
        child = execFile(
          'ps',
          ['-o', 'state=', '-p', String(pid)],
          {
            encoding: 'utf-8',
            windowsHide: true,
            timeout: ZOMBIE_PROBE_TIMEOUT_MS,
            env: { ...process.env, LC_ALL: 'C' },
          },
          (error, stdout) => {
            if (error) return resolve(false)
            resolve(isPsStateZombie(stdout))
          },
        )
      } catch {
        resolve(false)
        return
      }
      // 探测绝不能把进程钉在事件循环里
      child.unref?.()
    })
  }
  return Promise.resolve(false)
}

// ─── Lock File Operations ─────────────────────────────────────

/**
 * 读取锁文件（缺失/损坏 → null）。
 * 导出：store-lock 复用同一份原子锁文件机制，避免第二套实现漂移。
 */
export function readLockFile(path: string): LockInfo | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(lstatSync(path).isDirectory() ? join(path, 'owner.json') : path, 'utf-8')
    return JSON.parse(raw) as LockInfo
  } catch {
    return null
  }
}

/** 完整发布锁：优先 hard-link，不支持时原子 rename 非空目录（不能覆盖已有锁目录）。 */
export function createLockFileExclusive(path: string, info: LockInfo): CreateLockResult {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(info, null, 2), { encoding: 'utf-8', flag: 'wx' })
    try {
      linkSync(tmpPath, path)
    } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(errorCode(error) ?? '')) throw error
      return publishDirectoryLock(path, tmpPath, info)
    }
    unlinkSync(tmpPath)
    return { ok: true }
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 清理尽力而为
    }
    if (errorCode(error) === 'EEXIST') return { ok: false, reason: 'exists' }
    return { ok: false, reason: 'error', message: errorMessage(error) }
  }
}

function publishDirectoryLock(path: string, tmpPath: string, info: LockInfo): CreateLockResult {
  const directory = `${tmpPath}.d`
  try {
    mkdirSync(directory)
    writeFileSync(join(directory, 'owner.json'), JSON.stringify(info, null, 2), { flag: 'wx' })
    // Prepare everything before publication: readers never see a partial owner.
    publishLockDirectoryExclusive(directory, path)
    return { ok: true }
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '') && existsSync(path)) {
      return { ok: false, reason: 'exists' }
    }
    return { ok: false, reason: 'error', message: errorMessage(error) }
  } finally {
    try { unlinkSync(tmpPath) } catch { /* best effort */ }
    try { unlinkSync(join(directory, 'owner.json')) } catch { /* best effort */ }
    try { rmdirSync(directory) } catch { /* published or failed cleanup */ }
  }
}

/** Remove only our lock representation; never recursively delete unknown contents. */
export function removeLockFile(path: string): void {
  if (lstatSync(path).isDirectory()) {
    try { unlinkSync(join(path, 'owner.json')) } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    rmdirSync(path)
  } else {
    unlinkSync(path)
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── Cron Lock ────────────────────────────────────────────────

export class CronLock {
  private lockPath: string
  private healthCheckIntervalMs: number
  private readonly isProcessZombie: (pid: number) => Promise<boolean>
  private readonly machineIdResolver: () => Promise<string | undefined>
  private readonly hostnameResolver: () => string
  private readonly ownerHostname: string
  private readonly allowLegacyHostRecovery: boolean
  private machineIdPromise: Promise<string | undefined> | null = null
  private resolvedMachineId: string | undefined
  private state: LockState | null = null
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private lockLostHandlers = new Set<(state: LockState) => void>()

  constructor(config?: CronLockConfig) {
    this.lockPath = config?.lockPath ?? DEFAULT_LOCK_PATH
    this.healthCheckIntervalMs = config?.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_MS
    this.isProcessZombie = config?.isProcessZombie ?? probeProcessZombie
    this.machineIdResolver = config?.machineId ?? probeLockMachineId
    this.hostnameResolver = config?.hostname ?? osHostname
    this.ownerHostname = this.getHostname()
    this.allowLegacyHostRecovery = config?.allowLegacyHostRecovery ?? process.env.RIVET_STORE_LOCK_RECOVER_LEGACY_HOST === '1'
    if (config?.onLockLost) {
      this.lockLostHandlers.add(config.onLockLost)
    }
  }

  /** 持有者是否确定消失（进程不存在，或已死成僵尸——issue #530）。探测失败=不可核验=仍占用。 */
  private async isHolderGone(pid: number): Promise<boolean> {
    if (!isPidAlive(pid)) return true
    return this.isProcessZombie(pid)
  }

  /** 尝试获取锁。返回锁状态 */
  async acquire(): Promise<LockState> {
    this.machineIdPromise ??= Promise.resolve().then(() => this.machineIdResolver()).catch(() => undefined)
    this.resolvedMachineId = await this.machineIdPromise
    const info = this.buildLockInfo()
    const created = createLockFileExclusive(this.lockPath, info)

    if (created.ok) {
      // 成功创建 → 获得锁
      this.state = { status: 'acquired', info }
      this.startHealthCheck()
      return this.state
    }

    if (created.reason === 'error') {
      this.state = { status: 'error', reason: created.message }
      return this.state
    }

    // 锁文件已存在 → 检查 owner
    const owner = readLockFile(this.lockPath)
    if (!owner) {
      // 锁文件损坏 → 走 reclaim lock 串行回收；禁止裸 forceRelease，避免误删刚接管的活锁。
      return this.recoverInvalidLock()
    }

    // 检查 owner PID 是否存活
    if (this.isOwnLockInfo(owner)) {
      this.state = { status: 'acquired', info: owner }
      this.startHealthCheck()
      return this.state
    }

    if (!this.isSameMachine(owner)) {
      if (this.allowLegacyHostRecovery && !owner.machineId && await this.isHolderGone(owner.pid)) {
        return this.recoverStaleLock(owner)
      }
      // 跨主机共享锁不能用本机 PID 判定 owner 死亡；保守视为占用。
      this.state = { status: 'contended', owner }
      return this.state
    }

    if (await this.isHolderGone(owner.pid)) {
      // owner 已死（含僵尸）→ 陈旧锁回收
      return this.recoverStaleLock(owner)
    }

    // owner 存活 → 锁被占用
    this.state = { status: 'contended', owner }
    return this.state
  }

  /** 释放锁 */
  release(): void {
    this.stopHealthCheck()
    try {
      if (existsSync(this.lockPath)) {
        const owner = readLockFile(this.lockPath)
        if (owner && this.isOwnLockInfo(owner)) {
          removeLockFile(this.lockPath)
        }
      }
    } catch {
      // 清理尽力而为
    }
    this.state = null
  }

  /** 强制释放锁（不论 owner） */
  forceRelease(): void {
    this.stopHealthCheck()
    try {
      if (existsSync(this.lockPath)) {
        removeLockFile(this.lockPath)
      }
    } catch {
      // 清理尽力而为
    }
    this.state = null
  }

  /** 当前锁状态 */
  getState(): LockState | null {
    return this.state
  }

  /** 注册锁丢失回调。返回取消注册函数。 */
  onLockLost(handler: (state: LockState) => void): () => void {
    this.lockLostHandlers.add(handler)
    return () => {
      this.lockLostHandlers.delete(handler)
    }
  }

  /** 是否持有锁 */
  isOwner(): boolean {
    return this.state?.status === 'acquired' || this.state?.status === 'stale_recovered'
  }

  /**
   * issue #290 — human-readable owner for write-denial messages.
   * undefined = this process owns the lock (or has not contended yet).
   */
  ownerDescription(): string | undefined {
    if (this.isOwner()) return undefined
    const owner = (this.state?.status === 'contended' ? this.state.owner : undefined) ?? readLockFile(this.lockPath)
    if (!owner) {
      return '当前 sidecar 未持有调度器锁：定时任务写入由锁主进程受理，请在该实例的自动化面板操作，或稍后重试。'
    }
    const host = owner.hostname && owner.hostname !== this.getHostname() ? `，主机 ${owner.hostname}` : ''
    return `当前 sidecar 未持有调度器锁：定时任务写入由锁主进程受理（锁主 PID ${owner.pid}${host}），请在该实例的自动化面板操作，或稍后重试。`
  }

  // ─── Internal ──────────────────────────────────────────────

  private getHostname(): string {
    return this.hostnameResolver() || 'unknown'
  }

  private isSameMachine(owner: LockInfo): boolean {
    if (owner.machineId) return owner.machineId === this.resolvedMachineId
    return owner.hostname === this.getHostname()
  }

  private buildLockInfo(): LockInfo {
    return {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: this.ownerHostname,
      ownerToken: PROCESS_OWNER_TOKEN,
      startedAtMs: PROCESS_STARTED_AT_MS,
      ...(this.resolvedMachineId ? { machineId: this.resolvedMachineId } : {}),
    }
  }

  private isOwnLockInfo(info: LockInfo): boolean {
    return info.pid === process.pid &&
      info.hostname === this.ownerHostname &&
      info.ownerToken === PROCESS_OWNER_TOKEN &&
      info.startedAtMs === PROCESS_STARTED_AT_MS &&
      info.machineId === this.resolvedMachineId
  }

  private recoverInvalidLock(): Promise<LockState> {
    return this.recoverLock({ pid: -1, acquiredAt: '', hostname: '' })
  }

  private recoverStaleLock(previousOwner: LockInfo): Promise<LockState> {
    return this.recoverLock(previousOwner)
  }

  private async recoverLock(previousOwner: LockInfo): Promise<LockState> {
    const reclaimLock = await this.acquireReclaimLock()
    if (!reclaimLock.ok) {
      this.state = {
        status: 'contended',
        owner: readLockFile(this.lockPath) ?? previousOwner,
      }
      return this.state
    }

    try {
      const currentOwner = readLockFile(this.lockPath)
      if (currentOwner && !sameLockIdentity(currentOwner, previousOwner)) {
        this.state = { status: 'contended', owner: currentOwner }
        return this.state
      }
      if (currentOwner && !(await this.isHolderGone(currentOwner.pid))) {
        this.state = { status: 'contended', owner: currentOwner }
        return this.state
      }
      const latest = readLockFile(this.lockPath)
      const reclaimer = readLockFile(this.reclaimLockPath())
      if (!reclaimer || !this.isOwnLockInfo(reclaimer) ||
          (currentOwner ? !latest || !sameLockIdentity(currentOwner, latest) : latest !== null)) {
        this.state = { status: 'contended', owner: latest ?? previousOwner }
        return this.state
      }

      try {
        removeLockFile(this.lockPath)
      } catch {
        // 其他进程可能已经删除旧锁；继续走 O_EXCL 竞争
      }

      const info = this.buildLockInfo()
      const recovered = createLockFileExclusive(this.lockPath, info)
      if (recovered.ok) {
        this.state = { status: 'stale_recovered', previousOwner, info }
        this.startHealthCheck()
        return this.state
      }
      if (recovered.reason === 'error') {
        this.state = { status: 'error', reason: recovered.message }
        return this.state
      }

      const owner = readLockFile(this.lockPath)
      this.state = {
        status: 'contended',
        owner: owner ?? previousOwner,
      }
      return this.state
    } catch (error) {
      this.state = { status: 'error', reason: errorMessage(error) }
      return this.state
    } finally {
      this.releaseReclaimLock()
    }
  }

  private reclaimLockPath(): string {
    return `${this.lockPath}.reclaim`
  }

  private async acquireReclaimLock(): Promise<CreateLockResult> {
    const path = this.reclaimLockPath()
    const created = createLockFileExclusive(path, this.buildLockInfo())
    if (created.ok) return created
    if (created.reason === 'error') return created

    const owner = readLockFile(path)
    if (owner && this.isOwnLockInfo(owner)) return { ok: true }
    if (owner && (this.isSameMachine(owner) || this.allowLegacyHostRecovery && !owner.machineId) && await this.isHolderGone(owner.pid)) {
      const latest = readLockFile(path)
      if (!latest || !sameLockIdentity(owner, latest)) return { ok: false, reason: 'exists' }
      try {
        removeLockFile(path)
      } catch {
        // 其他进程可能已经接管 reclaim lock
      }
      return createLockFileExclusive(path, this.buildLockInfo())
    }
    return created
  }

  private releaseReclaimLock(): void {
    const path = this.reclaimLockPath()
    try {
      const owner = readLockFile(path)
      if (owner && this.isOwnLockInfo(owner)) {
        removeLockFile(path)
      }
    } catch {
      // 清理尽力而为
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck()
    // 仅主线程运行 health check（worker threads 不需要）
    if (!isMainThread) return
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth()
    }, this.healthCheckIntervalMs)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private checkHealth(): void {
    // 验证锁文件仍归自己所有
    const owner = readLockFile(this.lockPath)
    if (!owner || !this.isOwnLockInfo(owner)) {
      // 锁被意外篡改/丢失 → 标记 contended，并通知上层停掉 scheduler
      this.markLockLost(owner ?? { pid: -1, acquiredAt: '', hostname: '' })
    }
  }

  private markLockLost(owner: LockInfo): void {
    const wasOwner = this.isOwner()
    const lostState: LockState = { status: 'contended', owner }
    this.state = lostState
    this.stopHealthCheck()
    if (!wasOwner) return

    for (const handler of this.lockLostHandlers) {
      try {
        handler(lostState)
      } catch {
        // lock-loss handlers are best-effort; one bad observer must not restart the scheduler
      }
    }
  }
}
