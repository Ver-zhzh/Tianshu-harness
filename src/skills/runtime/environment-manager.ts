/**
 * 技能 Python 环境管理器（issue #523 WP2）。
 *
 * 目录：`rivetHome()/skill-runtimes/<envKey>/`；envKey = sha256(workspace 规范
 * 路径, skill 身份(scope:skillId), packageRef, 解释器身份(realPath+version+abi),
 * os/arch, buildPolicy) 截前 32 hex——任一要素变化都落到不同环境目录。
 *
 * 状态机：无 ready.json = not-prepared（目录残留仅是半成品）；preparing 期间
 * 持有跨进程锁（O_EXCL 锁文件 + PID 存活探测 + 陈旧回收，复用 cron-lock.ts
 * 原语；锁文件放环境目录旁 `<envKey>.lock`）；全部成功才原子写 ready.json；
 * 任何失败/取消清理半成品目录，绝不留假 ready。
 *
 * venv 原地建于最终路径（Python 官方明示 venv 不可移动，禁止建后重命名）。
 * 跨进程并发：等锁（带截止与 abort）后复查 ready 再决定是否复跑；进程内
 * 同 envKey 并发 prepare join 同一 Promise。
 *
 * 解释器失效：ready 命中时重探 realPath 二进制版本，与记录不符 →
 * environment_stale（报「需重建」），不自动替换成当前技能库版本。
 * 删除仅显式调用：锁被存活进程持有或活跃 run 计数 > 0 时拒绝。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, lstatSync } from 'node:fs'
import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { rivetHome } from '../../config/paths.js'
import { writeFileAtomicSync } from '../../fs-atomic.js'
import { createLockFileExclusive, readLockFile, removeLockFile } from '../../server/cron-lock.js'
import { buildSanitizedEnv, execProcess, ownedProcessTreeAlive, type ProcessExecResult } from '../../tools/process-exec.js'
import type { MirrorsConfig } from '../../config/schema.js'
import { checkRuntimeDeclarationPaths, type RuntimeDeclaration } from './declaration.js'
import type { PythonInterpreter } from './interpreter.js'
import { buildInstallPreview, installRequirements, type InstallPreview } from './installer.js'
import type { RuntimeResult, RuntimeStatus } from './run-contract.js'
import { EnvironmentLeases, EnvironmentBusyError, leaseAlive } from './leases.js'
import type { ProcessLease } from './leases.js'

export interface EnvKeyComponents {
  /** 规范路径（realpath，缺失则 resolve）。 */
  workspace: string
  /** scope:skillId */
  skillIdentity: string
  packageRef: string
  interpreterRealPath: string
  interpreterVersion: string
  interpreterAbi?: string
  platform: string
  arch: string
  buildPolicy: 'wheel' | 'source'
}

export function computeEnvKey(c: EnvKeyComponents): string {
  return createHash('sha256').update(JSON.stringify([
    c.workspace, c.skillIdentity, c.packageRef,
    c.interpreterRealPath, c.interpreterVersion, c.interpreterAbi ?? '',
    c.platform, c.arch, c.buildPolicy,
  ])).digest('hex').slice(0, 32)
}

export interface ReadyMarker {
  schemaVersion: 2
  runtimePolicyVersion: 2
  requirementsDigest: string
  envKey: string
  skill: { scope: string; name: string; skillId: string }
  packageRef: string
  interpreter: { path: string; realPath: string; version: string; abi?: string }
  buildPolicy: 'wheel' | 'source'
  /** venv 内的 python。 */
  python: string
  createdAt: string
}

export interface PrepareInput {
  workspace: string
  skill: { scope: string; name: string; skillId: string }
  packageRef: string
  interpreter: PythonInterpreter
  declaration: RuntimeDeclaration
  /** 包根（requirements 读取与 -r/-c 递归基准；会话快照 resume 时指快照目录）。 */
  packageRoot: string
  mirrors: MirrorsConfig
  buildPolicy?: 'wheel' | 'source'
  abortSignal?: AbortSignal
  /** pip install 超时（缺省 10 分钟）。 */
  installTimeoutMs?: number
  onOutput?: (text: string) => void
  /** 每次调用的执行器覆盖（issue #523 WP3：调用方包沙箱 argv 包装）；
   *  缺省用管理器构造时的 exec。 */
  exec?: (options: Parameters<typeof execProcess>[0]) => Promise<ProcessExecResult>
  /** 沙箱后端标识（如实进 RuntimeResult.sandbox；无沙箱传 'none'）。 */
  sandboxLabel?: string
  rebuild?: boolean
  preview?: InstallPreview
}

export interface PrepareOutcome {
  status: RuntimeStatus
  envKey: string
  envDir: string
  result: RuntimeResult
}

export interface EnvManagerOptions {
  /** 缺省 rivetHome()；测试注入仓库外 tmpdir。 */
  home?: string
  exec?: (options: Parameters<typeof execProcess>[0]) => Promise<ProcessExecResult>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 等跨进程锁的截止（缺省 5 分钟；超时按 timeout 归类，abort 随时生效）。 */
  lockWaitTimeoutMs?: number
  platform?: NodeJS.Platform
  arch?: string
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class SkillEnvironmentManager {
  private readonly home: string
  private readonly exec: NonNullable<EnvManagerOptions['exec']>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly lockWaitTimeoutMs: number
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly inflight = new Map<string, Promise<PrepareOutcome>>()
  private readonly leases: EnvironmentLeases

  constructor(options: EnvManagerOptions = {}) {
    this.home = options.home ?? rivetHome()
    this.leases = new EnvironmentLeases(join(this.home, 'skill-runtimes'))
    this.exec = options.exec ?? execProcess
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Date.now())
    this.lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 300_000
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
  }

  private canonicalWorkspace(workspace: string): string {
    try { return realpathSync(workspace) } catch { return resolve(workspace) }
  }

  envKey(input: Pick<PrepareInput, 'workspace' | 'skill' | 'packageRef' | 'interpreter' | 'buildPolicy'>): string {
    return computeEnvKey({
      workspace: this.canonicalWorkspace(input.workspace),
      skillIdentity: `${input.skill.scope}:${input.skill.skillId}`,
      packageRef: input.packageRef,
      interpreterRealPath: input.interpreter.realPath,
      interpreterVersion: input.interpreter.version,
      ...(input.interpreter.abi ? { interpreterAbi: input.interpreter.abi } : {}),
      platform: this.platform,
      arch: this.arch,
      buildPolicy: input.buildPolicy ?? 'wheel',
    })
  }

  envDir(envKey: string): string {
    return join(this.home, 'skill-runtimes', envKey)
  }

  private lockPath(envKey: string): string {
    return join(this.home, 'skill-runtimes', `${envKey}.lock`)
  }

  private readReady(envDir: string): ReadyMarker | undefined {
    try {
      const marker = JSON.parse(readFileSync(join(envDir, 'ready.json'), 'utf8')) as ReadyMarker
      return [1, 2].includes(marker.schemaVersion) ? marker : undefined
    } catch {
      return undefined
    }
  }

  /** 重探 ready 记录的解释器二进制版本；漂移 → environment_stale（不自动重建）。 */
  private async verifyInterpreter(marker: ReadyMarker, exec = this.exec): Promise<boolean> {
    if (marker.schemaVersion !== 2 || marker.runtimePolicyVersion !== 2 || !marker.requirementsDigest) return false
    const probed = await exec({ argv: [marker.interpreter.realPath, '--version'], env: buildSanitizedEnv(), timeoutMs: 5000 })
    if (probed.exitCode !== 0) return false
    const match = (probed.stdout + probed.stderr).match(/(\d+\.\d+\.\d+)/)
    return match?.[1] === marker.interpreter.version
  }

  /**
   * 无子进程的状态查询：ready.json 存在 → ready；锁被存活进程持有 → preparing；
   * 否则 not-prepared（半成品目录不算任何状态）。解释器二进制级校验见
   * verifyReady（prepare 命中 ready 与 WP3 运行前走它）。
   */
  status(input: Pick<PrepareInput, 'workspace' | 'skill' | 'packageRef' | 'interpreter' | 'buildPolicy'>): { status: RuntimeStatus; envKey: string; envDir: string } {
    const envKey = this.envKey(input)
    const envDir = this.envDir(envKey)
    const marker = this.readReady(envDir)
    if (marker) {
      const identityMatch = marker.schemaVersion === 2 && marker.runtimePolicyVersion === 2 && !!marker.requirementsDigest && marker.envKey === envKey && marker.packageRef === input.packageRef && marker.interpreter.realPath === input.interpreter.realPath
        && marker.interpreter.version === input.interpreter.version
        && (marker.interpreter.abi ?? '') === (input.interpreter.abi ?? '')
      return { status: identityMatch ? 'ready' : 'environment_stale', envKey, envDir }
    }
    if (this.leases.exclusiveAlive(envKey)) return { status: 'preparing', envKey, envDir }
    return { status: 'not-prepared', envKey, envDir }
  }

  /** 运行前校验（WP3 消费）：ready + 解释器二进制未漂移。 */
  async verifyReady(input: Pick<PrepareInput, 'workspace' | 'skill' | 'packageRef' | 'interpreter' | 'buildPolicy'>, exec = this.exec): Promise<{ status: RuntimeStatus; envKey: string; envDir: string; marker?: ReadyMarker }> {
    const base = this.status(input)
    if (base.status !== 'ready') return base
    const marker = this.readReady(base.envDir)!
    const ok = await this.verifyInterpreter(marker, exec)
    return ok ? { ...base, marker } : { ...base, status: 'environment_stale' }
  }

  beginRun(envKey: string) { return this.leases.beginRun(envKey) }

  remove(input: Pick<PrepareInput, 'workspace' | 'skill' | 'packageRef' | 'interpreter' | 'buildPolicy'>): { removed: boolean; reason?: string } {
    const key = this.envKey(input)
    try {
      return this.leases.gate(key, () => {
        if (this.leases.hasRuns(key) || this.leases.exclusiveAlive(key)) return { removed: false, reason: '环境存在活跃运行或准备操作，拒绝删除' }
        const dir = this.envDir(key)
        if (!existsSync(dir)) return { removed: false, reason: '环境不存在' }
        rmSync(dir, { recursive: true, force: true })
        return { removed: true }
      })
    } catch (error) { return { removed: false, reason: String(error) } }
  }

  /** 进程内并发 join：同 envKey 复用同一 Promise。 */
  prepare(input: PrepareInput): Promise<PrepareOutcome> {
    const envKey = this.envKey(input)
    const inflightKey = `${envKey}:${input.rebuild === true ? 'rebuild' : 'prepare'}`
    const existing = this.inflight.get(inflightKey)
    if (existing) return existing
    const promise = this.prepareLocked(envKey, input)
    this.inflight.set(inflightKey, promise)
    // 不用 promise.finally——其派生 Promise 在原 Promise reject 时会产生未处理拒绝。
    void promise.then(
      () => this.inflight.delete(inflightKey),
      () => this.inflight.delete(inflightKey),
    )
    return promise
  }

  private async acquireLock(envKey: string, signal?: AbortSignal): Promise<RuntimeResult | undefined> {
    const lockPath = this.lockPath(envKey)
    const deadline = this.now() + this.lockWaitTimeoutMs
    for (;;) {
      let created
      try { created = this.leases.gate(envKey, () => {
        if (this.leases.hasRuns(envKey)) throw new EnvironmentBusyError('环境存在活跃运行')
        return createLockFileExclusive(lockPath, {
        pid: process.pid,
        ...{ phase: 'idle', nonce: envKey },
        acquiredAt: new Date(this.now()).toISOString(),
        hostname: hostname() || 'unknown',
      }) }) } catch (error) {
        return { stage: 'prepare', errorCode: 'environment_busy', message: String(error) }
      }
      if (created.ok) return undefined
      if (created.reason === 'error') {
        return { stage: 'prepare', errorCode: 'permission_denied', message: `环境锁不可写：${created.message}` }
      }
      const owner = readLockFile(lockPath)
      if (owner && !leaseAlive(owner)) {
        try { this.leases.gate(envKey, () => {
          const current = readLockFile(lockPath)
          if (current && current.pid === owner.pid && !leaseAlive(current)) removeLockFile(lockPath)
        }) } catch { /* Another admission owns the metadata lock. */ }
        continue
      }
      if (signal?.aborted) return { stage: 'prepare', errorCode: 'cancelled', message: '等待环境锁时取消' }
      if (this.now() > deadline) return { stage: 'prepare', errorCode: 'timeout', message: '等待环境锁超时（另一进程仍在准备）' }
      await this.sleep(150)
    }
  }

  private releaseLock(envKey: string): void {
    const lockPath = this.lockPath(envKey)
    try {
      const owner = readLockFile(lockPath)
      if (owner && owner.pid === process.pid) removeLockFile(lockPath)
    } catch { /* 锁清理尽力而为 */ }
  }

  private venvPython(envDir: string): string {
    return this.platform === 'win32' ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python')
  }

  /** 清空目录内容但保留目录本身（沙箱 bind 的目标路径必须全程存在——
   *  删目录会让 bwrap/landlock 的 --bind 在下次 exec 时失目标）。 */
  private emptyDir(dir: string): void {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }

  private async prepareLocked(envKey: string, input: PrepareInput): Promise<PrepareOutcome> {
    const envDir = this.envDir(envKey)
    const baseExec = input.exec ?? this.exec
    let cleanupPending = false
    let childPid: number | undefined
    const update = (phase: ProcessLease['phase']) => {
      const lockPath = this.lockPath(envKey)
      const path = lstatSync(lockPath).isDirectory() ? join(lockPath, 'owner.json') : lockPath
      writeFileAtomicSync(path, JSON.stringify({ pid: process.pid, nonce: envKey, phase, childPid, hostname: hostname(), acquiredAt: new Date(this.now()).toISOString() }))
    }
    const exec: typeof baseExec = async options => {
      if (cleanupPending) return { exitCode: -1, cancelled: false, timedOut: false, cleanupConfirmed: false, stdout: '', stderr: '前一进程尚未确认停止', durationMs: 0 }
      update('starting')
      const result = await baseExec({ ...options, onSpawn: pid => { childPid = pid; update('running'); options.onSpawn?.(pid) } })
      if (result.cleanupConfirmed === false) cleanupPending = true
      else update('idle')
      return cleanupPending ? { ...result, exitCode: -1 } : result
    }
    const sandbox = input.sandboxLabel
    const fail = (result: RuntimeResult): PrepareOutcome => ({ status: 'failed', envKey, envDir, result: { ...result, ...(cleanupPending ? { errorCode: 'process_cleanup_failed' as const, message: '进程树清理尚未确认，环境受保护' } : {}), ...(sandbox ? { sandbox } : {}) } })

    if (input.abortSignal?.aborted) return fail({ stage: 'prepare', errorCode: 'cancelled', message: '操作已取消' })
    const lockError = await this.acquireLock(envKey, input.abortSignal)
    if (lockError) return fail(lockError)
    try {
      // 锁内复查：等待期间另一进程可能已完成。
      const recheck = this.readReady(envDir)
      if (recheck && !input.rebuild) {
        const valid = await this.verifyInterpreter(recheck, exec)
        if (cleanupPending) return fail({ stage: 'prepare', errorCode: 'process_cleanup_failed', message: '健康检查的进程树尚未确认停止' })
        if (valid) {
          return { status: 'ready', envKey, envDir, result: { stage: 'prepare', message: '环境已就绪', interpreter: recheck.interpreter.realPath, packageVersion: recheck.packageRef } }
        }
        return { status: 'environment_stale', envKey, envDir, result: { stage: 'prepare', errorCode: 'environment_stale', message: '环境绑定的解释器已失效，需重建，请显式确认 rebuild。', interpreter: recheck.interpreter.realPath, packageVersion: recheck.packageRef } }
      }

      // 清掉上次崩溃留下的半成品（锁内安全：无 ready 即无有效环境；保目录清空
      // 以守住沙箱 bind 目标的存在性——bwrap/landlock 对不存在路径建规则即失败）。
      this.emptyDir(envDir)

      // 声明路径再校验（包在装载后可能被手改；requirements/entries 必须仍在包内）。
      const paths = checkRuntimeDeclarationPaths(input.packageRoot, input.declaration)
      if (!paths.ok) return fail({ stage: 'prepare', errorCode: 'invalid_declaration', message: paths.message })

      const buildPolicy = input.buildPolicy ?? 'wheel'
      const env = buildSanitizedEnv()

      // venv 原地建于最终路径。
      const venv = await exec({ argv: [input.interpreter.path, '-m', 'venv', envDir], env, timeoutMs: 120_000, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) })
      if (venv.cancelled) return fail({ stage: 'prepare', errorCode: 'cancelled', message: 'venv 创建已取消' })
      if (venv.timedOut) return fail({ stage: 'prepare', errorCode: 'timeout', message: 'venv 创建超时' })
      if (venv.exitCode !== 0) {
        const missing = /No module named venv|ensurepip is not available/i.test(venv.stderr)
        return fail({
          stage: 'prepare', ...(missing ? { errorCode: 'venv_missing' as const } : {}),
          message: missing ? `解释器缺少 venv 模块：${input.interpreter.realPath}` : `venv 创建失败：${venv.stderr.trim().slice(-400)}`,
          stderr: venv.stderr, exitCode: venv.exitCode,
        })
      }

      // 健康检查：venv python 存在且 --version 可跑。
      const envPython = this.venvPython(envDir)
      const health = await exec({ argv: [envPython, '--version'], env, timeoutMs: 15_000 })
      if (health.exitCode !== 0) return fail({ stage: 'prepare', errorCode: 'venv_missing', message: 'venv 创建成功但解释器不可用（健康检查失败）', stderr: health.stderr })

      // requirements 可缺席（仅标准库）→ installRequirements 内部跳过 pip 但仍落报告。
      const previewResult = input.preview ? { ok: true as const, preview: input.preview } : this.buildPreview(input, envDir, buildPolicy)
      if (!previewResult.ok) return fail(previewResult.result)
      if (previewResult.preview.requirements) {
        const pip = await exec({ argv: [envPython, '-m', 'pip', '--version'], env, timeoutMs: 15_000 })
        if (pip.exitCode !== 0) return fail({ stage: 'prepare', errorCode: 'pip_missing', message: 'venv 内 pip 不可用', stderr: pip.stderr })
      }
      const installed = await installRequirements({
        preview: previewResult.preview, envPython,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        timeoutMs: input.installTimeoutMs ?? 600_000,
        exec, now: this.now,
        ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      })
      if (installed.errorCode || (installed.exitCode !== undefined && installed.exitCode !== 0)) return fail(installed)

      // 全部成功才原子发布 ready。
      const marker: ReadyMarker = {
        schemaVersion: 2, runtimePolicyVersion: 2, requirementsDigest: createHash('sha256').update(JSON.stringify(previewResult.preview.requirements?.files ?? {})).digest('hex'), envKey, skill: input.skill, packageRef: input.packageRef,
        interpreter: previewResult.preview.interpreter, buildPolicy, python: envPython,
        createdAt: new Date(this.now()).toISOString(),
      }
      writeFileAtomicSync(join(envDir, 'ready.json'), JSON.stringify(marker, null, 2))
      return { status: 'ready', envKey, envDir, result: { stage: 'prepare', message: '环境准备完成', interpreter: marker.interpreter.realPath, packageVersion: input.packageRef, ...(sandbox ? { sandbox } : {}) } }
    } finally {
      // 失败/取消：清理半成品，绝不留假 ready。
      if (!cleanupPending) {
        if (!this.readReady(envDir)) this.emptyDir(envDir)
        this.releaseLock(envKey)
      } else if (childPid) {
        const pid = childPid
        const reaper = setInterval(() => {
          if (!ownedProcessTreeAlive(pid)) { this.emptyDir(envDir); this.releaseLock(envKey); clearInterval(reaper) }
        }, 1000)
        reaper.unref()
      }
    }
  }

  private buildPreview(input: PrepareInput, envDir: string, buildPolicy: 'wheel' | 'source'): ReturnType<typeof buildInstallPreview> {
    return buildEnvironmentPreview(input, envDir, buildPolicy)
  }
}

/** 预览载荷构造（模块级，prepare 与 previewEnvironment 共用）。 */
function buildEnvironmentPreview(input: PrepareInput, envDir: string, buildPolicy: 'wheel' | 'source'): ReturnType<typeof buildInstallPreview> {
  let requirementsSource: string | undefined
  const declared = input.declaration.python.requirements
  if (declared) requirementsSource = readFileSync(join(input.packageRoot, declared), 'utf8')
  return buildInstallPreview({
    skill: input.skill, packageRef: input.packageRef, interpreter: input.interpreter,
    packageRoot: input.packageRoot, declarationRequirements: declared, ...(requirementsSource !== undefined ? { requirementsSource } : {}),
    mirrors: input.mirrors, envDir, buildPolicy,
  })
}

/** 预览载荷（prepare 前审批/展示用），不触发任何安装。 */
export function previewEnvironment(manager: SkillEnvironmentManager, input: PrepareInput): { envKey: string; envDir: string; preview: ReturnType<typeof buildInstallPreview> } {
  const envKey = manager.envKey(input)
  const envDir = manager.envDir(envKey)
  return { envKey, envDir, preview: buildEnvironmentPreview(input, envDir, input.buildPolicy ?? 'wheel') }
}
