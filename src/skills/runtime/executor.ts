/**
 * 技能运行时共享执行核心（issue #523 WP3）——skill_runtime 工具、HTTP 路由、
 * CLI 三方同源的 prepare/run 逻辑。工具参数面、审批与权限门在各接入层；
 * 本模块只管「解析可运行的技能 → 准备环境 → 执行脚本」。
 *
 * 关键约定：
 * - packageRef 一律是版本库引用（SkillVersionStore.reference/put），与会话快照
 *   的 pinned 值同口径——同一包内容只算出一个环境。
 * - run 从固定版本库重新物化独立资源副本（防会话中改写），在副本上重跑
 *   声明路径校验后才执行。
 * - 沙箱：RIVET_SANDBOX 请求时经 wrapArgvSandbox 包装 argv（prepare 授环境目录，
 *   run 授运行临时目录与输出目录——不授 skill-runtimes 根长期写）；结果如实
 *   带 sandbox 字段（后端名或 'none'）。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getInvokedSkills } from '../../agent/skill-gate.js'
import { readPackage, type PackageFile } from '../skill-package.js'
import { SkillVersionStore } from '../skill-version-store.js'
import { sessionsDir, rivetHome } from '../../config/paths.js'
import { buildSanitizedEnv, execProcess } from '../../tools/process-exec.js'
import { sandboxRequested, wrapArgvSandbox } from '../../tools/sandbox-profile.js'
import type { MirrorsConfig } from '../../config/schema.js'
import type { SkillDefinition, SkillRegistry } from '../skill-loader.js'
import { checkRuntimeDeclarationPaths, type RuntimeDeclaration } from './declaration.js'
import { SkillEnvironmentManager } from './environment-manager.js'
import { detectPythonInterpreter, matchesPythonRequirement, type DetectPythonOptions, type PythonProbeResult } from './interpreter.js'
import type { RuntimeResult, RuntimeStatus } from './run-contract.js'
import { RuntimeAccessError, runtimeSkillScope } from './policy.js'
import { captureRuntimePackage, type RuntimeExecutionPlan } from './operation.js'

/** run 超时的全局兜底（entry 声明值优先，调用方显式值再优先）。 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300

export interface ResolvedRuntimeSkill {
  skill: SkillDefinition
  declaration: RuntimeDeclaration
  /** 版本库引用（内容寻址）。 */
  packageRef: string
  files?: PackageFile[]
}

export type ResolveRuntimeSkillResult =
  | { ok: true; resolved: ResolvedRuntimeSkill }
  | { ok: false; result: RuntimeResult }

const resolveFail = (message: string, _status: RuntimeStatus = 'undeclared', errorCode?: RuntimeResult['errorCode']): ResolveRuntimeSkillResult =>
  ({ ok: false, result: { stage: 'run', ...(errorCode ? { errorCode } : {}), message } })

/**
 * 从会话注册表按名解析可运行的技能：拒模型提供的任意路径（只收名字）；
 * 目录型 + 有效 runtime 声明才可 prepare/run；off 硬拒；manual 须本会话
 * 显式加载过（skill-gate 的会话级记录——/skill 与 skill 工具共用同一落点）。
 * `userExplicit` 只满足手动选择条件；停用与硬权限不得跳过。
 */
export function resolveRuntimeSkill(
  registry: SkillRegistry,
  name: string,
  options: { sessionId?: string; store?: SkillVersionStore; userExplicit?: boolean; intent?: 'diagnose' | 'execute' } = {},
): ResolveRuntimeSkillResult {
  const skill = registry.get(name) ?? registry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return resolveFail(`未找到 skill：「${name}」`)
  {
    const mode = skill.mode ?? skill.metadata?.defaultMode ?? 'auto'
    if (options.intent !== 'diagnose' && mode === 'off') return { ok: false, result: { stage: 'run', errorCode: 'permission_denied', message: `Skill「${skill.name}」已停用。请先启用。` } }
    if (options.intent !== 'diagnose' && mode === 'manual' && !options.userExplicit && !getInvokedSkills(options.sessionId).has(skill.name.toLowerCase())) {
      return { ok: false, result: { stage: 'run', errorCode: 'permission_denied', message: `Skill「${skill.name}」仅手动使用——须本会话显式加载（用户 /skill ${skill.name}）后才能运行其脚本。` } }
    }
  }
  if (!skill.skillDir) return resolveFail(`Skill「${skill.name}」是扁平 Markdown 技能，无 Python 运行时声明。`, 'undeclared')
  const runtime = skill.metadata?.runtime
  if (runtime?.error) return { ok: false, result: { stage: 'run', errorCode: 'invalid_declaration', message: `runtime.yaml 声明无效：${runtime.error}` } }
  if (!runtime?.declaration) return resolveFail(`Skill「${skill.name}」未声明 runtime.yaml——补充声明后才能准备/运行（doctor 查看指引）。`, 'undeclared')

  let packageRef = (skill as SkillDefinition & { packageRef?: string }).packageRef
  let files: PackageFile[] | undefined
  if (!packageRef) {
    // 非快照来源（CLI/目录直读）：以版本库引用为准，与会话 pinned 值同口径。
    try {
      files = readPackage(skill.skillDir).files
      packageRef = (options.store ?? new SkillVersionStore()).reference(files)
    } catch (error) {
      return { ok: false, result: { stage: 'run', errorCode: 'invalid_declaration', message: `技能包读取失败：${error instanceof Error ? error.message : String(error)}` } }
    }
  }
  return { ok: true, resolved: { skill, declaration: runtime.declaration, packageRef, files } }
}

/** 解释器探测 + requires 匹配（prepare/run 共用前置）。 */
export async function probeInterpreterFor(
  declaration: RuntimeDeclaration,
  options: { explicitPath?: string; probePython?: (o: DetectPythonOptions) => Promise<PythonProbeResult> } = {},
): Promise<{ ok: true; interpreter: PythonProbeResult & { found: true } } | { ok: false; result: RuntimeResult }> {
  const probe = await (options.probePython ?? detectPythonInterpreter)({ explicitPath: options.explicitPath })
  if (!probe.found) {
    return { ok: false, result: { stage: 'detect', errorCode: 'interpreter_missing', message: `未找到可用的 Python 解释器。\n${probe.guidance}` } }
  }
  const requires = declaration.python.requires
  if (requires) {
    const match = matchesPythonRequirement(probe.version, requires)
    if (!match.ok) {
      return { ok: false, result: { stage: 'detect', errorCode: 'version_mismatch', message: `解释器版本不满足声明：${match.reason}`, interpreter: probe.realPath } }
    }
  }
  return { ok: true, interpreter: probe }
}

/** skill.source → 环境身份用的 scope（与 SkillManagement.list 的 skillId 口径对齐）。 */
function scopeOf(skill: SkillDefinition): string {
  return runtimeSkillScope(skill)
}

export interface PrepareSkillOptions {
  plan?: RuntimeExecutionPlan
  rebuild?: boolean
  cwd: string
  mirrors: MirrorsConfig
  buildPolicy?: 'wheel' | 'source'
  abortSignal?: AbortSignal
  onOutput?: (text: string) => void
  explicitPythonPath?: string
  probePython?: (o: DetectPythonOptions) => Promise<PythonProbeResult>
  manager?: SkillEnvironmentManager
  /** 测试缝：替换底层执行器。 */
  exec?: typeof execProcess
  /** 沙箱上下文注入（测试）。 */
  sandboxEnv?: NodeJS.ProcessEnv
}

export interface SkillRuntimeOutcome {
  status: RuntimeStatus
  result: RuntimeResult
  envDir?: string
}

let defaultManager: SkillEnvironmentManager | undefined
let defaultManagerHome: string | undefined
/** 进程级共享管理器（保 inflight join）；测试经 options.manager 注入隔离实例。 */
export function defaultEnvManager(): SkillEnvironmentManager {
  const home = rivetHome()
  if (!defaultManager || defaultManagerHome !== home) { defaultManager = new SkillEnvironmentManager({ home }); defaultManagerHome = home }
  return defaultManager
}

export async function prepareSkillRuntime(resolved: ResolvedRuntimeSkill, options: PrepareSkillOptions): Promise<SkillRuntimeOutcome> {
  const probed = options.plan ? { ok: true as const, interpreter: options.plan.interpreter } : await probeInterpreterFor(resolved.declaration, { explicitPath: options.explicitPythonPath, ...(options.probePython ? { probePython: options.probePython } : {}) })
  if (!probed.ok) return { status: 'interpreter-missing', result: probed.result }

  const inputRoot = join(sessionsDir(), '_skill-runtime-inputs', randomUUID())
  try {
    const store = new SkillVersionStore()
    const captured = options.plan ? { files: options.plan.files, resolved: options.plan.resolved } : captureRuntimePackage(resolved, store)
    if (store.put(captured.files) !== resolved.packageRef) throw new Error('固定版本内容不匹配')
    store.materialize(resolved.packageRef, inputRoot)
    resolved = captured.resolved
  } catch (error) {
    rmSync(inputRoot, { recursive: true, force: true })
    return { status: 'failed', result: { stage: 'prepare', errorCode: 'package_version_unavailable', message: String(error) } }
  }
  const manager = options.manager ?? defaultEnvManager()
  const buildPolicy = options.buildPolicy ?? 'wheel'
  const prepareInput = {
    workspace: options.cwd,
    skill: { scope: scopeOf(resolved.skill), name: resolved.skill.name, skillId: resolved.skill.skillId ?? resolved.skill.name },
    packageRef: resolved.packageRef,
    interpreter: probed.interpreter,
    declaration: resolved.declaration,
    packageRoot: inputRoot,
    rebuild: options.rebuild ?? options.plan?.request.rebuild,
    preview: options.plan?.preview,
    mirrors: options.mirrors,
    buildPolicy,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
  }
  const envKey = manager.envKey(prepareInput)
  const envDir = manager.envDir(envKey)

  // 沙箱包装（请求时）：授环境目录写权。先 mkdir 保证 bind 目标存在。
  const exec = options.exec ?? execProcess
  let wrappedExec = exec
  let sandboxLabel = 'none'
  if (sandboxRequested(options.sandboxEnv ?? process.env)) {
    const wrap = (argv: string[]) => wrapArgvSandbox(argv, { cwd: options.cwd, extraWritableRoots: [envDir], ...(options.sandboxEnv ? { env: options.sandboxEnv } : {}) })
    const probe = wrap(['true'])
    sandboxLabel = probe.backend
    if (sandboxLabel === 'none') {
      rmSync(inputRoot, { recursive: true, force: true })
      return { status: 'failed', result: { stage: 'prepare', errorCode: 'sandbox_denied', message: '无法建立请求的沙箱' } }
    }
    wrappedExec = (o) => exec({ ...o, argv: wrap(o.argv).argv })
  }

  try {
    const outcome = await manager.prepare({ ...prepareInput, exec: wrappedExec, sandboxLabel })
    return { status: outcome.status, result: outcome.result, envDir }
  } finally { rmSync(inputRoot, { recursive: true, force: true }) }
}

export interface RunSkillEntryOptions {
  plan?: RuntimeExecutionPlan
  entry: string
  args?: string[]
  stdin?: string
  timeoutSeconds?: number
  cwd: string
  abortSignal?: AbortSignal
  onOutput?: (text: string) => void
  explicitPythonPath?: string
  probePython?: (o: DetectPythonOptions) => Promise<PythonProbeResult>
  manager?: SkillEnvironmentManager
  store?: SkillVersionStore
  /** 运行副本目录名（缺省生成）。 */
  operationId?: string
  exec?: typeof execProcess
  sandboxEnv?: NodeJS.ProcessEnv
  now?: () => number
}

export async function runSkillEntry(resolved: ResolvedRuntimeSkill, options: RunSkillEntryOptions): Promise<SkillRuntimeOutcome> {
  if (options.plan) {
    resolved = options.plan.resolved
    options = { ...options, entry: options.plan.request.entry!, args: options.plan.request.args, stdin: options.plan.request.stdin, timeoutSeconds: options.plan.request.timeoutSeconds }
  }
  const entry = resolved.declaration.python.entries[options.entry]
  if (!entry) {
    return {
      status: 'invalid',
      result: { stage: 'run', errorCode: 'invalid_declaration', message: `入口「${options.entry}」不在声明内。可用入口：${Object.keys(resolved.declaration.python.entries).join(', ')}` },
    }
  }
  const probed = options.plan ? { ok: true as const, interpreter: options.plan.interpreter } : await probeInterpreterFor(resolved.declaration, { explicitPath: options.explicitPythonPath, ...(options.probePython ? { probePython: options.probePython } : {}) })
  if (!probed.ok) return { status: 'interpreter-missing', result: probed.result }

  const manager = options.manager ?? defaultEnvManager()
  const identity = {
    workspace: options.cwd,
    skill: { scope: scopeOf(resolved.skill), name: resolved.skill.name, skillId: resolved.skill.skillId ?? resolved.skill.name },
    packageRef: resolved.packageRef,
    interpreter: probed.interpreter,
  }
  let healthExec = options.exec ?? execProcess
  if (sandboxRequested(options.sandboxEnv ?? process.env)) {
    const wrap = (argv: string[]) => wrapArgvSandbox(argv, { cwd: options.cwd, ...(options.sandboxEnv ? { env: options.sandboxEnv } : {}) })
    if (wrap(['true']).backend === 'none') return { status: 'failed', result: { stage: 'run', errorCode: 'sandbox_denied', message: '无法建立请求的沙箱' } }
    const rawExec = healthExec
    healthExec = call => rawExec({ ...call, argv: wrap(call.argv).argv })
  }
  let ready: Awaited<ReturnType<SkillEnvironmentManager['verifyReady']>> | undefined
  let releaseRun: ReturnType<SkillEnvironmentManager['beginRun']> | undefined
  try {
    for (const buildPolicy of options.plan ? [options.plan.request.buildPolicy!] : ['wheel', 'source'] as const) {
      const candidate = { ...identity, buildPolicy }
      const lease = manager.beginRun(manager.envKey(candidate))
      let state: Awaited<ReturnType<SkillEnvironmentManager['verifyReady']>>
      try { state = await manager.verifyReady(candidate, async call => {
        const result = await healthExec({ ...call, onSpawn: lease.onSpawn })
        if (result.cleanupConfirmed === false) { lease.retain(); throw new RuntimeAccessError('process_cleanup_failed', '健康检查的进程树尚未确认停止') }
        return result
      }) } catch (error) { lease(); throw error }
      if (state.status === 'ready') { ready = state; releaseRun = lease; break }
      lease()
      if (state.status === 'environment_stale') ready = state
    }
  } catch (error) {
    return { status: 'failed', result: { stage: 'run', errorCode: error instanceof RuntimeAccessError && error.code === 'process_cleanup_failed' ? 'process_cleanup_failed' : 'environment_busy', message: String(error) } }
  }
  if (!ready || ready.status !== 'ready') return {
    status: ready?.status ?? 'not-prepared',
    result: { stage: 'run', errorCode: ready?.status === 'environment_stale' ? 'environment_stale' : 'environment_not_prepared', message: ready?.status === 'environment_stale' ? '环境已失效，需显式重建环境' : '环境未准备——先执行 prepare（rivet skills prepare / skill_runtime prepare）。', packageVersion: resolved.packageRef },
  }
  try {
  const store = options.store ?? new SkillVersionStore()
  const operationId = options.operationId ?? randomUUID()
  const runDir = join(sessionsDir(), '_skill-runtime-runs', operationId)
  try {
    store.materialize(resolved.packageRef, runDir)
  } catch {
    // 版本库缺这份 pinned 内容（如手工清理过 store）——从技能目录回补再物化；
    // 包已变化导致回补后 ref 仍缺 → 结构化报错（pinned 版本不可得，不静默用新版）。
    try {
      store.put(captureRuntimePackage(resolved, store).files)
      store.materialize(resolved.packageRef, runDir)
    } catch (error) {
      return { status: 'failed', result: { stage: 'run', errorCode: 'environment_stale', message: `固定版本 ${resolved.packageRef.slice(0, 12)}… 在版本库缺失且无法回补：${error instanceof Error ? error.message : String(error)}。重新装载技能后再运行。`, packageVersion: resolved.packageRef } }
    }
  }
  // 物化副本上重跑声明路径校验（副本也可能被手工篡改）。
  const paths = checkRuntimeDeclarationPaths(runDir, resolved.declaration)
  if (!paths.ok) return { status: 'invalid', result: { stage: 'run', errorCode: 'invalid_declaration', message: paths.message, packageVersion: resolved.packageRef } }

  const tmpDir = join(runDir, 'tmp')
  const outputDir = join(runDir, 'output')
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })

  const timeoutSeconds = options.timeoutSeconds ?? entry.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS
  const exec = options.exec ?? execProcess
  let argv = [ready.marker!.python, join(runDir, entry.script), ...(options.args ?? [])]
  let sandboxLabel = 'none'
  if (sandboxRequested(options.sandboxEnv ?? process.env)) {
    const wrapped = wrapArgvSandbox(argv, { cwd: options.cwd, extraWritableRoots: [tmpDir, outputDir], ...(options.sandboxEnv ? { env: options.sandboxEnv } : {}) })
    argv = wrapped.argv
    sandboxLabel = wrapped.backend
    if (sandboxLabel === 'none') return { status: 'failed', result: { stage: 'run', errorCode: 'sandbox_denied', message: '无法建立请求的沙箱' } }
  }

  {
    const run = await exec({
      argv,
      onSpawn: releaseRun!.onSpawn,
      cwd: options.cwd,
      env: buildSanitizedEnv(process.env, {
        RIVET_SKILL_RESOURCE_DIR: runDir,
        RIVET_SKILL_RUN_TMP_DIR: tmpDir,
        RIVET_SKILL_OUTPUT_DIR: outputDir,
      }),
      timeoutMs: timeoutSeconds * 1000,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.onOutput ? { onStdout: options.onOutput, onStderr: options.onOutput } : {}),
    })
    const base = { stage: 'run' as const, interpreter: probed.interpreter.realPath, packageVersion: resolved.packageRef, sandbox: sandboxLabel, operationId }
    if (run.cleanupConfirmed === false) {
      releaseRun!.retain()
      return { status: 'failed', result: { ...base, errorCode: 'process_cleanup_failed', message: '进程树清理尚未确认，环境租约保留', stdout: run.stdout, stderr: run.stderr } }
    }
    if (run.cancelled) return { status: 'failed', envDir: ready.envDir, result: { ...base, errorCode: 'cancelled', message: '运行已取消', exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr } }
    if (run.timedOut) return { status: 'failed', envDir: ready.envDir, result: { ...base, errorCode: 'timeout', message: `运行超时（${timeoutSeconds}s）`, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr } }
    if (run.exitCode !== 0) {
      return { status: 'failed', envDir: ready.envDir, result: { ...base, errorCode: 'script_failed', message: `脚本以非零退出码 ${run.exitCode} 结束（不自动重跑）。`, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr } }
    }
    return { status: 'ready', envDir: ready.envDir, result: { ...base, message: 'ok', exitCode: 0, stdout: run.stdout, stderr: run.stderr, outputs: { exitCode: 0 } } }
  }
  } finally {
    releaseRun?.()
  }
}
