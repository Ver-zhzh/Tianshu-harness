/**
 * 技能 Python 环境安装编排（issue #523 WP2）。
 *
 * 职责：构造预览载荷（审批/展示用）+ 用环境自身 python 跑 pip install。
 * 不建 venv、不判状态机——那是 environment-manager 的职责；本模块只负责
 * 「往一个已存在的 venv 里装审核过的 requirements」。
 *
 * 安全边界：
 * - argv 无 shell（process-exec）；禁交互；PIP_CONFIG_FILE 指空（隔离宿主
 *   pip 配置）；env 白名单经 buildSanitizedEnv，仅额外注入镜像两个变量。
 * - wheel 默认：--only-binary :all:；缺 wheel 报出具体依赖与原因，不就地
 *   降级源码构建。buildPolicy: 'source' 是显式新任务（新 operationId 语义
 *   由 WP3 定义），此时去掉 --only-binary。
 * - 安装报告：pip --report JSON（结构化、含解析版本与归档哈希）为事实源，
 *   比 freeze 输出（纯文本、无哈希、含环境标记差异）可靠——选 report。
 */
import { writeFileAtomicSync } from '../../fs-atomic.js'
import { buildMirrorEnv } from '../../tools/mirror-env.js'
import { buildSanitizedEnv, execProcess, type ProcessExecResult } from '../../tools/process-exec.js'
import type { MirrorsConfig } from '../../config/schema.js'
import type { PythonInterpreter } from './interpreter.js'
import type { RuntimeResult } from './run-contract.js'
import { auditRequirements, type AuditedRequirements } from './requirements.js'
import { join, dirname } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'

export interface InstallPreview {
  skill: { scope: string; name: string; skillId: string }
  /** 包版本引用（fingerprint）。 */
  packageRef: string
  interpreter: { path: string; realPath: string; version: string; abi?: string }
  /** 审核结果；null = 仅标准库（安装步骤整体跳过）。 */
  requirements: AuditedRequirements | null
  /** 包源（mirrors.pypi 映射；默认官方 PyPI）。 */
  source: { indexUrl: string; trustedHost?: string }
  envDir: string
  buildPolicy: 'wheel' | 'source'
}

/** 从镜像配置提取 pip 包源（buildMirrorEnv 的镜像表 → 仅取 PIP_* 两个变量）。 */
export function pipSourceFromMirrors(mirrors: MirrorsConfig): { indexUrl: string; trustedHost?: string } {
  const env = buildMirrorEnv(mirrors)
  return {
    indexUrl: env['PIP_INDEX_URL'] ?? 'https://pypi.org/simple',
    ...(env['PIP_TRUSTED_HOST'] ? { trustedHost: env['PIP_TRUSTED_HOST'] } : {}),
  }
}

export interface BuildPreviewInput {
  skill: { scope: string; name: string; skillId: string }
  packageRef: string
  interpreter: PythonInterpreter
  declarationRequirements?: string
  /** 包根（requirements 的 -r/-c 递归解析基准）。 */
  packageRoot: string
  /** requirements 文件文本（调用方从包/快照读出）；undefined = 仅标准库。 */
  requirementsSource?: string
  packageFiles?: Record<string, string>
  mirrors: MirrorsConfig
  envDir: string
  buildPolicy?: 'wheel' | 'source'
}

export type BuildPreviewResult =
  | { ok: true; preview: InstallPreview }
  | { ok: false; result: RuntimeResult }

/** prepare 前的审批/展示载荷；requirements 在此完成审核（失败即 invalid_requirements）。 */
export function buildInstallPreview(input: BuildPreviewInput): BuildPreviewResult {
  let audited: AuditedRequirements | null = null
  if (input.requirementsSource !== undefined) {
    const result = auditRequirements(input.requirementsSource, { packageRoot: input.packageRoot, requirementsFile: input.declarationRequirements, files: input.packageFiles })
    if (!result.ok) {
      return { ok: false, result: { stage: 'prepare', errorCode: result.errorCode, message: result.message, interpreter: input.interpreter.realPath, packageVersion: input.packageRef } }
    }
    audited = result.audited
  }
  return {
    ok: true,
    preview: {
      skill: input.skill,
      packageRef: input.packageRef,
      interpreter: {
        path: input.interpreter.path,
        realPath: input.interpreter.realPath,
        version: input.interpreter.version,
        ...(input.interpreter.abi ? { abi: input.interpreter.abi } : {}),
      },
      requirements: audited,
      source: pipSourceFromMirrors(input.mirrors),
      envDir: input.envDir,
      buildPolicy: input.buildPolicy ?? 'wheel',
    },
  }
}

export interface InstallOptions {
  preview: InstallPreview
  /** venv 内的 python（管理器建 venv 后给出）。 */
  envPython: string
  abortSignal?: AbortSignal
  timeoutMs?: number
  /** 测试缝：替换执行器。 */
  exec?: (options: Parameters<typeof execProcess>[0]) => Promise<ProcessExecResult>
  now?: () => number
  onOutput?: (text: string) => void
}

/** 安装报告（落盘 <envDir>/install-report.json）。 */
export interface InstallReport {
  schemaVersion: 1
  skill: { scope: string; name: string; skillId: string }
  packageRef: string
  interpreter: { path: string; realPath: string; version: string; abi?: string }
  buildPolicy: 'wheel' | 'source'
  source: { indexUrl: string; trustedHost?: string }
  /** 审核后的规范化 requirements 文本。 */
  requirements: string
  requirementsFiles?: Record<string, string>
  /** pip 实际解析的安装项（pip-list-fallback 时无归档哈希）。 */
  resolved: Array<{ name: string; version: string; hashes: Record<string, string> }>
  /** 解析证据来源：pip --report（结构化含哈希）或 pip list 快照差（老 pip 兜底）。 */
  reportMode: 'pip-report' | 'pip-list-fallback' | 'none'
  /** 未精确钉死的依赖名（重新准备时解析结果可能变化）。 */
  unpinned: string[]
  createdAt: string
}

/** pip 失败 stderr/exit → RuntimeErrorCode 归类（尽力而为；一律不留 ready 由管理器保证）。 */
function classifyPipFailure(output: string, buildPolicy: 'wheel' | 'source'): { errorCode?: RuntimeResult['errorCode']; message: string } {
  const noDist = output.match(/Could not find a version that satisfies the requirement\s+(\S+)|No matching distribution found for\s+(\S+)/i)
  if (noDist) {
    const dep = (noDist[1] ?? noDist[2] ?? '').replace(/[(\s].*$/, '')
    if (buildPolicy === 'wheel') {
      return {
        errorCode: 'no_wheel',
        message: `依赖 ${dep} 无可用 wheel（--only-binary :all: 下不排除包名不存在的情形）。不就地降级；确需源码构建请以 buildPolicy:'source' 显式重新准备。`,
      }
    }
    return { errorCode: undefined, message: `无法解析依赖 ${dep}（包不存在或版本约束不可满足）。` }
  }
  if (/NameResolutionError|Temporary failure in name resolution|ConnectionError|SSLError|ReadTimeout|Connection refused|Network is unreachable|Failed to establish a new connection/i.test(output)) {
    return { errorCode: 'network_failure', message: '网络访问 PyPI 包源失败（可配置 mirrors.pypi 走镜像）。' }
  }
  if (/No space left on device|ENOSPC/i.test(output)) {
    return { errorCode: undefined, message: '磁盘空间不足，安装中止。' }
  }
  if (/Permission denied|EACCES|EPERM/i.test(output)) {
    return { errorCode: 'permission_denied', message: '安装目标目录无写权限。' }
  }
  if (/subprocess-exited-with-error|Failed building wheel|error: command .* failed|error: Microsoft Visual C\+\+|error: command '.*gcc.*' failed/i.test(output)) {
    return { errorCode: 'source_build_failed', message: '源码构建失败（缺少编译链或构建依赖）。' }
  }
  return { errorCode: undefined, message: 'pip install 失败，详见 stderr。' }
}

function parsePipReport(reportPath: string): Array<{ name: string; version: string; hashes: Record<string, string> }> | undefined {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      install?: Array<{ metadata?: { name?: string; version?: string }; download_info?: { archive_info?: { hashes?: Record<string, string> } } }>
    }
    return (report.install ?? []).map(item => ({
      name: item.metadata?.name ?? '',
      version: item.metadata?.version ?? '',
      hashes: item.download_info?.archive_info?.hashes ?? {},
    })).filter(item => item.name && item.version)
  } catch {
    return undefined
  }
}

/** 老 pip（无 --report，如 macOS 系统 python3.9 捆绑的 pip 21.x）的解析证据兜底：
 *  安装前后 `pip list --format=json` 快照差。无归档哈希。 */
async function pipListSnapshot(exec: NonNullable<InstallOptions['exec']>, envPython: string, env: NodeJS.ProcessEnv): Promise<Array<{ name: string; version: string }> | undefined> {
  const result = await exec({ argv: [envPython, '-m', 'pip', 'list', '--format=json'], env, timeoutMs: 30_000 })
  if (result.exitCode !== 0) return undefined
  try {
    const rows = JSON.parse(result.stdout) as Array<{ name?: string; version?: string }>
    return rows.filter(r => r.name && r.version).map(r => ({ name: r.name!, version: r.version! }))
  } catch {
    return undefined
  }
}

/** pip install --help 是否含 --report（一次性轻探测，无网络）。 */
async function pipSupportsReport(exec: NonNullable<InstallOptions['exec']>, envPython: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await exec({ argv: [envPython, '-m', 'pip', 'install', '--help'], env, timeoutMs: 30_000 })
  return result.exitCode === 0 && result.stdout.includes('--report')
}

/**
 * 执行安装。requirements 为 null（仅标准库）时整体跳过并直接写报告。
 * 成功/失败都通过 RuntimeResult 返回；报告仅在成功时落盘。
 */
export async function installRequirements(options: InstallOptions): Promise<RuntimeResult> {
  const { preview } = options
  const exec = options.exec ?? execProcess
  const now = options.now ?? (() => Date.now())

  if (!preview.requirements) {
    const report: InstallReport = {
      schemaVersion: 1, skill: preview.skill, packageRef: preview.packageRef,
      interpreter: preview.interpreter, buildPolicy: preview.buildPolicy, source: preview.source,
      requirements: '', resolved: [], reportMode: 'none', unpinned: [], createdAt: new Date(now()).toISOString(),
    }
    writeFileAtomicSync(join(preview.envDir, 'install-report.json'), JSON.stringify(report, null, 2))
    return { stage: 'prepare', message: '仅标准库，跳过依赖安装', interpreter: preview.interpreter.realPath, packageVersion: preview.packageRef }
  }

  // 规范化 requirements 落盘为安装输入（审核产物即 pip 输入，避免二次漂移）。
  const auditedDir = join(preview.envDir, 'requirements.audited')
  for (const [file, content] of Object.entries(preview.requirements.files)) {
    const target = join(auditedDir, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileAtomicSync(target, content)
  }
  const requirementsPath = join(auditedDir, preview.requirements.rootFile)
  const reportPath = join(preview.envDir, 'pip-report.json')
  const env = buildSanitizedEnv(process.env, {
    // 隔离宿主 pip 配置：NUL（win32）/ /dev/null。
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...(preview.source.indexUrl !== 'https://pypi.org/simple' ? { PIP_INDEX_URL: preview.source.indexUrl } : {}),
    ...(preview.source.trustedHost ? { PIP_TRUSTED_HOST: preview.source.trustedHost } : {}),
  })
  // 老 pip（如 macOS 系统 python3.9 捆绑的 21.x）无 --report——探测一次，
  // 不支持则回退 pip list 快照差（无归档哈希，报告如实标 reportMode）。
  const hasReport = await pipSupportsReport(exec, options.envPython, env)
  const baseline = hasReport ? undefined : await pipListSnapshot(exec, options.envPython, env)
  if (!hasReport && !baseline) {
    return { stage: 'prepare', errorCode: 'pip_missing', message: 'venv 内 pip 不可用（--help 与 list 均失败）', interpreter: preview.interpreter.realPath, packageVersion: preview.packageRef }
  }
  const argv = [
    options.envPython, '-m', 'pip', 'install',
    '--disable-pip-version-check', '--no-input',
    ...(preview.buildPolicy === 'wheel' ? ['--only-binary', ':all:'] : []),
    ...(hasReport ? ['--report', reportPath] : []),
    '-r', requirementsPath,
  ]
  const result = await exec({
    argv, env,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onOutput ? { onStdout: options.onOutput, onStderr: options.onOutput } : {}),
  })

  const base = { stage: 'prepare' as const, interpreter: preview.interpreter.realPath, packageVersion: preview.packageRef }
  if (result.cancelled) return { ...base, errorCode: 'cancelled', message: '安装已取消', exitCode: result.exitCode, stderr: result.stderr }
  if (result.timedOut) return { ...base, errorCode: 'timeout', message: `安装超时（${options.timeoutMs}ms）`, exitCode: result.exitCode, stderr: result.stderr }
  if (result.exitCode !== 0) {
    const classified = classifyPipFailure(result.stdout + '\n' + result.stderr, preview.buildPolicy)
    return { ...base, ...(classified.errorCode ? { errorCode: classified.errorCode } : {}), message: classified.message, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  let resolved: Array<{ name: string; version: string; hashes: Record<string, string> }> | undefined
  let reportMode: InstallReport['reportMode'] = 'pip-report'
  if (hasReport) {
    resolved = parsePipReport(reportPath)
    if (!resolved) {
      return { ...base, errorCode: 'invalid_requirements', message: 'pip --report 产物缺失或不可解析——无法证明实际解析版本，按失败处理。', exitCode: 0, stdout: result.stdout, stderr: result.stderr }
    }
  } else {
    reportMode = 'pip-list-fallback'
    const after = await pipListSnapshot(exec, options.envPython, env)
    if (!after || !baseline) {
      return { ...base, errorCode: 'invalid_requirements', message: 'pip list 快照不可解析——无法证明实际解析版本，按失败处理。', exitCode: 0, stdout: result.stdout, stderr: result.stderr }
    }
    const before = new Map(baseline.map(r => [r.name.toLowerCase(), r.version]))
    resolved = after.filter(r => before.get(r.name.toLowerCase()) !== r.version).map(r => ({ ...r, hashes: {} }))
  }
  const report: InstallReport = {
    schemaVersion: 1, skill: preview.skill, packageRef: preview.packageRef,
    interpreter: preview.interpreter, buildPolicy: preview.buildPolicy, source: preview.source,
    requirements: preview.requirements.normalized, requirementsFiles: preview.requirements.files,
    resolved,
    reportMode,
    unpinned: preview.requirements.requirements.filter(r => r.unpinned && !preview.requirements!.constraints[r.name]).map(r => r.name),
    createdAt: new Date(now()).toISOString(),
  }
  writeFileAtomicSync(join(preview.envDir, 'install-report.json'), JSON.stringify(report, null, 2))
  return { ...base, message: `安装完成：${resolved.length} 个包`, exitCode: 0, outputs: { resolved: resolved.length } }
}
