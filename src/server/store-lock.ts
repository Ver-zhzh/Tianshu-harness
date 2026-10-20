/**
 * Store Lock — 会话库单写者独占锁（P0-1）
 *
 * 为什么需要它：多个 sidecar 进程（tauri dev、测试脚本、VSCode 插件）共用
 * 同一个桌面会话库（desktopDir()）时，每个进程启动都会跑 rehydrate()，把别人
 * 正在跑的会话标成『已中断』并写入 seq 高出 CRASH_RECOVERY_SEQ_GAP（100_000）
 * 的假中断标记；desktop 端 event-reducer 的 `ev.seq <= state.lastSeq` 守卫随后
 * 丢弃假标记之后的**全部真实输出**——即『假续跑』。会话库必须单写者：
 * 拿不到锁的进程不碰会话库（后续波次在 serve.ts 接线时拒绝启动并显示横幅）。
 *
 * 与 CronLock 的关系：同一套 PID 租约锁机制（O_EXCL 原子创建 + hard-link / 非空目录原子发布、
 * 存活探测、串行 reclaim），底层原语直接复用 src/server/cron-lock.ts 的导出，
 * 不复制实现。差异（本模块扩展的部分）：
 *   1. 有界重试 acquire（默认 5s 窗口）——覆盖监管器『杀旧进程 → 拉起新进程』的交接；
 *   2. 接管判据收紧为两条（2026-10-20），均需同主机 + 锁身份完整（ownerToken/startedAtMs 齐全）：
 *      ① pid_dead——持有者进程确认不存在（EPERM 视为活着，见 isPidAlive）；
 *      ② pid_reused——PID 活着，但真实创建时间与锁记录的 startedAtMs 不符（PID 已被复用）。
 *      **活进程心跳过期（mtime 陈旧）不再触发接管**，只在占用者摘要里透出
 *      （holder.heartbeatStale）——事件循环卡顿的进程不该因此丢库，进程真死由 ①② 兜住；
 *   3. 进程创建时间探测全平台**异步有界**（单次 2s，execFile 回调，绝不 execFileSync
 *      阻事件循环；win32 走 PowerShell CIM Win32_Process.CreationDate），探测耗时计入
 *      acquire 的 5s 窗口预算；取不到 = 不可核验 = 按占用处理；
 *   4. 心跳只刷新 mtime（utimesSync），**绝不重写锁文件内容**——writeFileSync 会
 *      先截断文件，并发读者可能读到半写 JSON 而误判『锁损坏』去抢锁（split-brain）；
 *   5. node:test 护栏：测试进程持默认真实目录锁路径时直接拒绝，防测试污染真实会话库；
 *   6. 升级过渡期判据：不认识 sidecar.lock 的旧版 sidecar 仍在写会话库时，它必然持有同目录的
 *      定时任务锁（scheduled_tasks.lock）——持有者是别的活进程就按占用处理（见 legacyWriter）；
 *   7. reclaim 前重读并比对**完整锁身份**（pid+hostname+startedAtMs+ownerToken 四元组）：
 *      身份变化 = 锁主已易人，放弃本轮回收；禁止只按 pid 相同就删（PID 复用下同 pid
 *      的已是另一个持有者）。主锁 / legacy writer 锁 / reclaim 锁复用同一套持有者判据。
 *
 * 失效方向（硬约束）：误判『仍被占用』= 拒绝启动 + 横幅（可恢复）；
 * 误判『已失效』= 两个进程同写会话库（数据损坏）。所有模糊情形一律偏向『占用』：
 *   - 进程创建时间取不到 / 锁身份字段缺失 → 不可核验，按占用（旧格式锁不自动清理）；
 *   - 跨主机锁 → 视为占用（本机 PID 判不了远端进程死活）；
 *   - 探测失败 / 超时 → 视为占用。
 */

import { existsSync, statSync, utimesSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname as osHostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread } from 'node:worker_threads'
import { desktopDir, defaultRivetHome } from '../config/paths.js'
import {
  createLockFileExclusive,
  isPidAlive,
  readLockFile,
  removeLockFile,
  type LockInfo,
} from './cron-lock.js'

export type { LockInfo }

// ─── Constants ────────────────────────────────────────────────

/** 锁文件名（位于 desktopDir() 下）。 */
export const STORE_LOCK_FILENAME = 'sidecar.lock'

/** 同目录的定时任务锁（serve.ts 的 CronLock）：升级过渡期判据读它认出旧版写者。 */
export const LEGACY_WRITER_LOCK_FILENAME = 'scheduled_tasks.lock'

/** acquire 默认重试窗口（毫秒）：覆盖监管器杀旧进程 → 拉起新进程的交接窗口。 */
export const DEFAULT_ACQUIRE_WINDOW_MS = 5_000

/** acquire 重试间隔（毫秒）。 */
export const DEFAULT_ACQUIRE_INTERVAL_MS = 250

/** 持有者刷新锁文件心跳的间隔（毫秒）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

/** 心跳超过该时长未刷新即在占用者摘要里标记 heartbeatStale（仅诊断，不触发接管）。 */
export const STORE_LOCK_HEARTBEAT_STALE_MS = 10 * 60_000

/**
 * 锁里记录的启动时间与该 PID 真实创建时间（ps/CIM，秒级）允许的偏差。超出 = PID 已被复用。
 * 记录值取自 owner 进程内的 `Date.now() - uptime`，与 ps 的差实测在 1s 量级。
 */
const PROCESS_START_MATCH_TOLERANCE_MS = 30_000

/** 单次进程创建时间探测上限（毫秒）：win32 的 PowerShell CIM 冷启动可达秒级。 */
const PROCESS_PROBE_TIMEOUT_MS = 2_000

const PROCESS_OWNER_TOKEN = randomUUID()
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1000)

// ─── Types ────────────────────────────────────────────────────

/** 占用者摘要：调用方拿它在横幅/health 里说明『谁占着会话库』。 */
export interface StoreLockHolder {
  pid: number
  startedAtMs?: number
  hostname?: string
  /** 诊断：持有者心跳已超过 heartbeatStaleMs 未刷新。活进程心跳过期不触发接管，仅供观测。 */
  heartbeatStale?: boolean
}

/** 未获得锁的原因（供横幅文案/健康上报区分场景）。 */
export type LockContentionReason =
  | 'pid_alive'          // 持有者进程存活且身份吻合（含心跳过期但进程活着的情形）
  | 'cross_host'         // 锁来自另一台主机，本机 PID 判不了死活 → 保守占用
  | 'reclaim_in_progress' // 陈旧锁回收被别的进程抢占（reclaim 锁竞争）
  | 'legacy_writer'      // 不认识 sidecar.lock 的旧版 sidecar 正持有同目录的定时任务锁
  | 'identity_unverifiable' // 旧格式锁缺 ownerToken/startedAtMs → 不可核验，按占用不自动清理

/** 判为可接管的依据（持有者确定消失）。 */
export type StaleReason =
  | 'pid_dead'    // 持有者 PID 不存在（含 Linux zombie；EPERM 视为活着，不在此列）
  | 'pid_reused'  // PID 活着但真实创建时间与锁记录 startedAtMs 不符 → PID 已被复用

export type StoreLockState =
  | { status: 'acquired'; acquired: true; info: LockInfo }
  | { status: 'stale_recovered'; acquired: true; previousOwner: LockInfo; info: LockInfo }
  | { status: 'contended'; acquired: false; holder: StoreLockHolder; reason: LockContentionReason }
  | { status: 'error'; acquired: false; reason: string }

export interface StoreLockConfig {
  /** 锁文件路径；缺省 desktopDir()/sidecar.lock。 */
  lockPath?: string
  /** 心跳刷新间隔（毫秒），默认 10s。 */
  heartbeatIntervalMs?: number
  /** 心跳过期阈值（毫秒），默认 10 分钟。仅诊断（holder.heartbeatStale），不触发接管。 */
  heartbeatStaleMs?: number
  /** 锁丢失回调：锁被删除或被其他进程接管时触发（上层据此停掉会话库写入）。 */
  onLockLost?: (state: StoreLockState) => void
  /** 升级过渡期判据读的锁文件；缺省为锁同目录的 scheduled_tasks.lock，传 [] 关闭。 */
  legacyWriterLockPaths?: string[]
  /** 进程真实创建时间（毫秒 since epoch）的**异步**探测；返回 undefined = 核验不了。测试可注入。 */
  processStartMs?: (pid: number) => Promise<number | undefined>
}

export interface StoreLockAcquireOptions {
  /** 重试窗口（毫秒）。0 = 只尝试一次。默认 5000。 */
  retryWindowMs?: number
  /** 重试间隔（毫秒），默认 250。 */
  retryIntervalMs?: number
}

// ─── Paths ────────────────────────────────────────────────────

/** 实际生效的锁路径：desktopDir()（受 RIVET_DESKTOP_DIR / RIVET_HOME 影响）。 */
export function storeLockPath(): string {
  return join(desktopDir(), STORE_LOCK_FILENAME)
}

/**
 * 平台默认真实目录的锁路径——**忽略** RIVET_DESKTOP_DIR / RIVET_HOME。
 * 它既是 node:test 护栏的比较基准（『解析到默认真实目录』），
 * 也让测试能在不依赖环境变量的情况下指认真实路径。
 */
export function platformDefaultStoreLockPath(): string {
  return join(defaultRivetHome(), 'desktop', STORE_LOCK_FILENAME)
}

// ─── Process Creation Time Probe ──────────────────────────────

/**
 * 进程真实创建时间（毫秒 since epoch，秒级精度）。取不到/超时 → undefined（调用方按
 * 『不可核验 = 占用』处理）。**异步**：探测绝不阻事件循环（win32 的 PowerShell 单次
 * 可达秒级），单次上限 PROCESS_PROBE_TIMEOUT_MS。
 *
 * macOS / Linux 的 `ps -o lstart=` 输出 `Sat Oct  3 22:59:17 2026`（本地时间），
 * LC_ALL=C 防止日期被本地化后解析失败；win32 走 PowerShell CIM Win32_Process.CreationDate
 * （ISO 8601 UTC 输出，culture-invariant）。
 */
export function probeProcessStartMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(undefined)
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return runProbe('ps', ['-o', 'lstart=', '-p', String(pid)], parseDateMs, { LC_ALL: 'C' })
  }
  if (process.platform === 'win32') {
    return runProbe('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
    ], parseDateMs)
  }
  return Promise.resolve(undefined)
}

function parseDateMs(out: string): number | undefined {
  const ms = Date.parse(out.trim())
  return Number.isFinite(ms) ? ms : undefined
}

/** 异步执行探测命令：出错/超时（execFile timeout 击杀后回调 error）/ 解析失败 → undefined。 */
function runProbe(
  cmd: string,
  args: string[],
  parse: (stdout: string) => number | undefined,
  extraEnv?: Record<string, string>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        cmd,
        args,
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: PROCESS_PROBE_TIMEOUT_MS,
          env: { ...process.env, ...extraEnv },
        },
        (error, stdout) => {
          if (error) return resolve(undefined)
          try {
            resolve(parse(stdout))
          } catch {
            resolve(undefined)
          }
        },
      )
    } catch {
      resolve(undefined)
      return
    }
    // 探测绝不能把进程钉在事件循环里
    child.unref?.()
  })
}

// ─── Identity ─────────────────────────────────────────────────

/**
 * 完整锁身份比对（pid+hostname+startedAtMs+ownerToken 四元组）——reclaim 前重读、
 * 自判（isOwnLockInfo）共用同一口径。禁止只按 pid 判同：PID 复用下同 pid 的已是
 * 另一个持有者。
 */
export function lockIdentityMatches(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid &&
    a.hostname === b.hostname &&
    a.ownerToken === b.ownerToken &&
    a.startedAtMs === b.startedAtMs
}

/** 旧格式锁缺 ownerToken/startedAtMs → 身份不可核验 → 一律按占用（保守兼容，不自动清理）。 */
function isIdentityComplete(info: LockInfo): boolean {
  return typeof info.ownerToken === 'string' && info.ownerToken.length > 0 &&
    typeof info.startedAtMs === 'number' && Number.isFinite(info.startedAtMs)
}

// ─── Store Lock ───────────────────────────────────────────────

export class StoreLock {
  private readonly lockPath: string
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatStaleMs: number
  private readonly legacyWriterLockPaths: string[]
  private readonly processStartMs: (pid: number) => Promise<number | undefined>
  private readonly lockLostHandlers = new Set<(state: StoreLockState) => void>()
  private state: StoreLockState | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: StoreLockConfig) {
    this.lockPath = config?.lockPath ?? storeLockPath()
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatStaleMs = config?.heartbeatStaleMs ?? STORE_LOCK_HEARTBEAT_STALE_MS
    this.legacyWriterLockPaths = config?.legacyWriterLockPaths
      ?? [join(dirname(this.lockPath), LEGACY_WRITER_LOCK_FILENAME)]
    this.processStartMs = config?.processStartMs ?? probeProcessStartMs
    if (config?.onLockLost) this.lockLostHandlers.add(config.onLockLost)
  }

  /**
   * 获取会话库独占锁，在 retryWindowMs 窗口内反复尝试（进程探测耗时计入窗口预算）。
   *
   * 返回结构同时给出『是否获得』（status/acquired）与占用者
   * （contended 分支的 holder: {pid, startedAtMs?, hostname?, heartbeatStale?}）。
   */
  async acquire(options?: StoreLockAcquireOptions): Promise<StoreLockState> {
    const guardError = this.testGuardError()
    if (guardError) {
      this.state = guardError
      return guardError
    }

    const windowMs = Math.max(0, options?.retryWindowMs ?? DEFAULT_ACQUIRE_WINDOW_MS)
    const intervalMs = Math.max(10, options?.retryIntervalMs ?? DEFAULT_ACQUIRE_INTERVAL_MS)
    const deadline = Date.now() + windowMs

    let state = await this.attemptAcquire()
    while (state.status === 'contended' && Date.now() + intervalMs <= deadline) {
      await sleep(intervalMs)
      state = await this.attemptAcquire()
    }

    this.state = state
    if (state.acquired) this.startHeartbeat()
    return state
  }

  /** 释放锁（仅当锁仍属于本进程完整身份；丢锁后是 no-op——绝不删别人的锁）。 */
  release(): void {
    this.stopHeartbeat()
    try {
      const owner = readLockFile(this.lockPath)
      if (owner && this.isOwnLockInfo(owner)) removeLockFile(this.lockPath)
    } catch {
      // 清理尽力而为
    }
    this.releaseReclaimLock()
    this.state = null
  }

  /** 当前锁状态。 */
  getState(): StoreLockState | null {
    return this.state
  }

  /** 本进程是否持有锁。 */
  isOwner(): boolean {
    return this.state?.acquired === true
  }

  /**
   * 当前占用者（health 上报用）。undefined = 本进程持有锁、或无人占用。
   * 未持有且没有争用记录时现读一次锁文件，让只探测 health 的实例也能报出占用者。
   */
  holder(): StoreLockHolder | undefined {
    if (this.isOwner()) return undefined
    if (this.state?.status === 'contended') return this.state.holder
    const owner = readLockFile(this.lockPath)
    return owner ? toHolder(owner) : undefined
  }

  /** 注册锁丢失回调。返回取消注册函数。 */
  onLockLost(handler: (state: StoreLockState) => void): () => void {
    this.lockLostHandlers.add(handler)
    return () => {
      this.lockLostHandlers.delete(handler)
    }
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * node:test 护栏（P0-1）：测试子进程若把锁路径解析到**默认真实目录**
   * （~/.rivet/desktop/sidecar.lock 或平台默认），直接拒绝——测试绝不能碰真实会话库。
   * RIVET_DESKTOP_DIR / RIVET_HOME 指向别处，或调用方显式传入其他 lockPath → 放行。
   */
  private testGuardError(): StoreLockState | null {
    if (!process.env.NODE_TEST_CONTEXT) return null
    if (resolve(this.lockPath) !== resolve(platformDefaultStoreLockPath())) return null
    return {
      status: 'error',
      acquired: false,
      reason:
        `拒绝在 node:test 进程中操作真实会话库锁（${this.lockPath}）：` +
        '请设置 RIVET_DESKTOP_DIR / RIVET_HOME 指向临时目录，或显式传入 lockPath。',
    }
  }

  /** 单次尝试（不等待）。成功 → 上层负责起心跳。 */
  private async attemptAcquire(): Promise<StoreLockState> {
    const legacy = await this.legacyWriter()
    if (legacy) return { status: 'contended', acquired: false, holder: toHolder(legacy), reason: 'legacy_writer' }

    const info = this.buildLockInfo()
    const created = createLockFileExclusive(this.lockPath, info)
    if (created.ok) return { status: 'acquired', acquired: true, info }
    if (created.reason === 'error') return { status: 'error', acquired: false, reason: created.message }

    const owner = readLockFile(this.lockPath)
    // 锁文件损坏/被截断 → 串行 reclaim（禁止裸删：可能删掉刚落地的活锁）
    if (!owner) return this.recoverLock(UNKNOWN_OWNER)

    if (this.isOwnLockInfo(owner)) return { status: 'acquired', acquired: true, info: owner }

    if (owner.hostname !== this.getHostname()) {
      return { status: 'contended', acquired: false, holder: toHolder(owner), reason: 'cross_host' }
    }

    // 旧格式锁缺身份字段 → 不可核验 → 按占用，不自动清理
    if (!isIdentityComplete(owner)) {
      return { status: 'contended', acquired: false, holder: this.toHolderWithDiagnostics(owner), reason: 'identity_unverifiable' }
    }

    const stale = await this.holderGoneReason(owner)
    if (stale) return this.recoverLock(owner)

    return { status: 'contended', acquired: false, holder: this.toHolderWithDiagnostics(owner), reason: 'pid_alive' }
  }

  /**
   * 升级过渡期判据：旧版 sidecar 不认识 sidecar.lock，单看它判不出会话库上还有写者；
   * 但每个 sidecar 都抢同目录的定时任务锁，常驻的那个必然持有它（2026-10-04 现场：
   * 旧版桌面端持有定时任务锁、没有 sidecar.lock，打包验证起的新版 sidecar 照样拿到锁并 rehydrate）。
   *
   * 失效方向：只在确认进程消失或 PID 被复用时放行。跨主机、缺创建时间、探测失败均保留占用，
   * 否则旧版写者没有 sidecar.lock，新实例会在无法核验时直接拿锁并恢复它的会话库。
   * 与主锁接管判据共用同一探测（processStartMs）与容差（PROCESS_START_MATCH_TOLERANCE_MS）。
   */
  private async legacyWriter(): Promise<LockInfo | null> {
    for (const path of this.legacyWriterLockPaths) {
      const owner = readLockFile(path)
      if (!owner || owner.pid === process.pid) continue
      if (owner.hostname !== this.getHostname()) return owner
      if (!isPidAlive(owner.pid)) continue
      if (typeof owner.startedAtMs !== 'number' || !Number.isFinite(owner.startedAtMs)) return owner
      const actualStartMs = await this.processStartMs(owner.pid)
      if (actualStartMs === undefined) return owner
      if (Math.abs(actualStartMs - owner.startedAtMs) > PROCESS_START_MATCH_TOLERANCE_MS) continue
      if (readLockFile(this.lockPath)?.pid === owner.pid) continue
      return owner
    }
    return null
  }

  /**
   * 接管判据（两条；主锁与 reclaim 锁共用）：null = 视为仍被占用。
   * 身份不完整（旧格式锁）→ 不可核验 → 按占用；探测失败同理。
   * 调用方负责先判同主机（跨主机本机 PID 判不了死活）。
   */
  private async holderGoneReason(owner: LockInfo): Promise<StaleReason | null> {
    if (!isIdentityComplete(owner)) return null
    if (!isPidAlive(owner.pid)) return 'pid_dead'
    const actual = await this.processStartMs(owner.pid)
    if (actual === undefined) return null
    return Math.abs(actual - owner.startedAtMs!) > PROCESS_START_MATCH_TOLERANCE_MS ? 'pid_reused' : null
  }

  /** 心跳 = 锁文件 mtime（只读，不重写内容）。stat 失败 → undefined（诊断不生效）。 */
  private readHeartbeatMs(): number | undefined {
    try {
      return statSync(this.lockPath).mtimeMs
    } catch {
      return undefined
    }
  }

  /** 占用者摘要 + 心跳诊断：mtime 过期只透出 heartbeatStale，不再触发接管。 */
  private toHolderWithDiagnostics(owner: LockInfo): StoreLockHolder {
    const holder = toHolder(owner)
    const lastBeatMs = this.readHeartbeatMs()
    if (lastBeatMs !== undefined && Date.now() - lastBeatMs > this.heartbeatStaleMs) {
      holder.heartbeatStale = true
    }
    return holder
  }

  /** 串行化回收：先抢 `<lockPath>.reclaim`，再重读比对完整锁身份、复查持有者是否真消失。 */
  private async recoverLock(previousOwner: LockInfo): Promise<StoreLockState> {
    const reclaim = await this.acquireReclaimLock()
    if (!reclaim.ok) {
      return {
        status: 'contended',
        acquired: false,
        holder: toHolder(readLockFile(this.lockPath) ?? previousOwner),
        reason: 'reclaim_in_progress',
      }
    }

    try {
      const current = readLockFile(this.lockPath)
      // reclaim 前重读并比对完整身份（四元组）：身份变化 = 锁主已易人，放弃本轮回收。
      if (current && !lockIdentityMatches(current, previousOwner)) {
        return { status: 'contended', acquired: false, holder: this.toHolderWithDiagnostics(current), reason: 'pid_alive' }
      }
      if (current && !this.isOwnLockInfo(current) && (await this.holderGoneReason(current)) === null) {
        // 复查发现锁主仍活/身份吻合（例如刚被别人接管）→ 放弃回收
        return { status: 'contended', acquired: false, holder: this.toHolderWithDiagnostics(current), reason: 'pid_alive' }
      }

      // 身份探测会让出事件循环；删除前同时复核目标与本轮 reclaim 所有权。
      const latest = readLockFile(this.lockPath)
      const reclaimer = readLockFile(this.reclaimLockPath())
      if (!reclaimer || !this.isOwnLockInfo(reclaimer) ||
          (current ? !latest || !lockIdentityMatches(current, latest) : latest !== null)) {
        return { status: 'contended', acquired: false, holder: toHolder(latest ?? previousOwner), reason: 'reclaim_in_progress' }
      }

      try {
        removeLockFile(this.lockPath)
      } catch {
        // 其他进程可能已经删掉旧锁；继续走 O_EXCL 竞争
      }

      const info = this.buildLockInfo()
      const recovered = createLockFileExclusive(this.lockPath, info)
      if (recovered.ok) return { status: 'stale_recovered', acquired: true, previousOwner, info }
      if (recovered.reason === 'error') return { status: 'error', acquired: false, reason: recovered.message }

      const owner = readLockFile(this.lockPath)
      return { status: 'contended', acquired: false, holder: toHolder(owner ?? previousOwner), reason: 'pid_alive' }
    } catch (error) {
      return { status: 'error', acquired: false, reason: errorMessage(error) }
    } finally {
      this.releaseReclaimLock()
    }
  }

  private reclaimLockPath(): string {
    return `${this.lockPath}.reclaim`
  }

  private async acquireReclaimLock(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const path = this.reclaimLockPath()
    const created = createLockFileExclusive(path, this.buildLockInfo())
    if (created.ok) return { ok: true }
    if (created.reason === 'error') return { ok: false, reason: created.message }

    const owner = readLockFile(path)
    if (owner && this.isOwnLockInfo(owner)) return { ok: true }
    // 与主锁同一套持有者判据（同主机 +（进程不存在 | 创建时间不符））才可接管 reclaim 锁。
    // 身份不完整/跨主机/探测失败 → 按占用（reclaim_in_progress）。
    if (
      owner &&
      owner.hostname === this.getHostname() &&
      (await this.holderGoneReason(owner)) !== null
    ) {
      const latest = readLockFile(path)
      if (!latest || !lockIdentityMatches(owner, latest)) return { ok: false, reason: 'owner_changed' }
      try {
        removeLockFile(path)
      } catch {
        // 其他进程可能已经接管 reclaim 锁
      }
      const retry = createLockFileExclusive(path, this.buildLockInfo())
      if (retry.ok) return { ok: true }
      return { ok: false, reason: retry.reason === 'error' ? retry.message : 'exists' }
    }
    return { ok: false, reason: 'exists' }
  }

  private releaseReclaimLock(): void {
    const path = this.reclaimLockPath()
    try {
      const owner = readLockFile(path)
      if (owner && this.isOwnLockInfo(owner)) removeLockFile(path)
    } catch {
      // 清理尽力而为
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (!isMainThread) return
    const timer = setInterval(() => {
      this.heartbeatTick()
    }, this.heartbeatIntervalMs)
    // 心跳绝不能把进程钉在事件循环里
    timer.unref?.()
    this.heartbeatTimer = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 刷新心跳前先确认锁仍属于自己；被别人接管 → 通知上层并停心跳。 */
  private heartbeatTick(): void {
    const owner = readLockFile(this.lockPath)
    if (!owner || !this.isOwnLockInfo(owner)) {
      this.markLockLost(owner ?? UNKNOWN_OWNER)
      return
    }
    try {
      const now = new Date()
      utimesSync(this.lockPath, now, now)
    } catch {
      // 心跳尽力而为：下一次 tick 再试
    }
  }

  private markLockLost(owner: LockInfo): void {
    const wasOwner = this.isOwner()
    const lostState: StoreLockState = {
      status: 'contended',
      acquired: false,
      holder: toHolder(owner),
      reason: 'pid_alive',
    }
    this.state = lostState
    this.stopHeartbeat()
    if (!wasOwner) return
    for (const handler of this.lockLostHandlers) {
      try {
        handler(lostState)
      } catch {
        // 观察者异常不能阻断其他观察者
      }
    }
  }

  private getHostname(): string {
    return osHostname() || 'unknown'
  }

  private buildLockInfo(): LockInfo {
    return {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: this.getHostname(),
      ownerToken: PROCESS_OWNER_TOKEN,
      startedAtMs: PROCESS_STARTED_AT_MS,
    }
  }

  private isOwnLockInfo(info: LockInfo): boolean {
    return lockIdentityMatches(info, this.ownIdentity())
  }

  private ownIdentity(): LockInfo {
    return {
      pid: process.pid,
      acquiredAt: '',
      hostname: this.getHostname(),
      ownerToken: PROCESS_OWNER_TOKEN,
      startedAtMs: PROCESS_STARTED_AT_MS,
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/** 锁文件损坏时用的占位 owner（pid -1 永不匹配现存活进程）。 */
const UNKNOWN_OWNER: LockInfo = { pid: -1, acquiredAt: '', hostname: '' }

function toHolder(info: LockInfo): StoreLockHolder {
  return { pid: info.pid, startedAtMs: info.startedAtMs, hostname: info.hostname }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 供上层（serve.ts 接线）判断是否拿到锁。 */
export function isStoreLockAcquired(state: StoreLockState): boolean {
  return state.acquired
}

/** 供 health / 横幅：未获得锁时的占用者摘要。 */
export function storeLockHolderOf(state: StoreLockState): StoreLockHolder | undefined {
  return state.status === 'contended' ? state.holder : undefined
}

/** 锁是否真的存在（存在性检查，不判定归属）。 */
export function storeLockExists(lockPath: string = storeLockPath()): boolean {
  return existsSync(lockPath)
}
