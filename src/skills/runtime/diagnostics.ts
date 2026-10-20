/**
 * 技能运行时诊断聚合（issue #523）——WP1 从 skills-cli doctor <id> 抽出的
 * 共享形态：CLI、skill_runtime 工具（doctor action）与 HTTP preview 三处同源。
 *
 * 环境状态自 WP3 起是真实查询（SkillEnvironmentManager.status），不再是
 * WP1 的恒 not-prepared 占位；envKey 的 packageRef 一律用版本库引用
 * （SkillVersionStore.reference），与 prepare/run 的取值同源，避免同一包
 * 内容算出两个环境。
 */
import { readPackage, skillPackagePath } from '../skill-package.js'
import { SkillVersionStore } from '../skill-version-store.js'
import { SkillEnvironmentManager } from './environment-manager.js'
import { detectPythonInterpreter, matchesPythonRequirement, type DetectPythonOptions, type PythonProbeResult } from './interpreter.js'
import type { RuntimeDeclaration } from './declaration.js'
import type { SkillMetadata } from '../skill-metadata.js'
import type { RuntimeErrorCode, RuntimeStatus } from './run-contract.js'

export interface SkillRuntimeDiagnosis {
  status: RuntimeStatus
  errorCode?: RuntimeErrorCode
  declaration?: RuntimeDeclaration
  error?: string
  interpreter?: PythonProbeResult
  requiresMatch?: { ok: boolean; reason?: string }
  environment: { status: RuntimeStatus }
}

export interface DiagnoseOptions {
  cwd: string
  probePython?: (options: DetectPythonOptions) => Promise<PythonProbeResult>
  explicitPythonPath?: string
  /** 测试注入（临时 home）；缺省新建（rivetHome）。 */
  envManager?: SkillEnvironmentManager
}

interface DiagnosableSkill {
  name: string
  skillId: string
  scope: string
  path?: string
  metadata?: SkillMetadata
  /** 会话 pinned 的版本库引用——有则直接用，不再从 path 重算。 */
  packageRef?: string
}

/** 版本库引用（prepare/run 的 envKey packageRef 同口径）；读不出包时 undefined。 */
function packageRefOf(skill: DiagnosableSkill): string | undefined {
  if (skill.packageRef) return skill.packageRef
  if (!skill.path) return undefined
  try {
    const pkg = readPackage(skillPackagePath(skill.path))
    return new SkillVersionStore().reference(pkg.files)
  } catch {
    return undefined
  }
}

export async function diagnoseSkillRuntime(skill: DiagnosableSkill, options: DiagnoseOptions): Promise<SkillRuntimeDiagnosis> {
  const runtimeMeta = skill.metadata?.runtime
  if (!runtimeMeta) return { status: 'undeclared', environment: { status: 'undeclared' } }
  if (runtimeMeta.error) return { status: 'invalid', error: runtimeMeta.error, environment: { status: 'not-prepared' } }

  const declaration = runtimeMeta.declaration!
  const probe = await (options.probePython ?? detectPythonInterpreter)({ explicitPath: options.explicitPythonPath })
  const requires = declaration.python.requires
  const requiresMatch = probe.found && requires ? matchesPythonRequirement(probe.version, requires) : undefined
  const status: RuntimeStatus = !probe.found || requiresMatch?.ok === false ? 'interpreter-missing' : 'not-prepared'

  let environment: RuntimeStatus = 'not-prepared'
  if (probe.found && requiresMatch?.ok !== false) {
    const packageRef = packageRefOf(skill)
    if (packageRef) {
      const manager = options.envManager ?? new SkillEnvironmentManager()
      // buildPolicy 在 envKey 里——doctor 不知 prepare 用了哪档，两种都查，
      // 报第一个非 not-prepared 的状态。
      for (const buildPolicy of ['wheel', 'source'] as const) {
        const state = manager.status({
          workspace: options.cwd,
          skill: { scope: skill.scope, name: skill.name, skillId: skill.skillId },
          packageRef,
          interpreter: probe,
          buildPolicy,
        }).status
        if (state !== 'not-prepared') { environment = state; break }
      }
    }
  }

  return {
    status,
    ...(requiresMatch?.ok === false ? { errorCode: 'version_mismatch' as const } : {}),
    declaration,
    interpreter: probe,
    ...(requiresMatch ? { requiresMatch } : {}),
    environment: { status: environment },
  }
}
