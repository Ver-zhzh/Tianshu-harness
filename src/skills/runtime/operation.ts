import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPackage, type PackageFile } from '../skill-package.js'
import { SkillVersionStore } from '../skill-version-store.js'
import { parseRuntimeDeclaration } from './declaration.js'
import { buildInstallPreview, type InstallPreview } from './installer.js'
import { defaultEnvManager, probeInterpreterFor, type ResolvedRuntimeSkill } from './executor.js'
import { assertRuntimeAccess, RuntimeAccessError, runtimeSkillScope, type RuntimeAction, type RuntimePolicyContext } from './policy.js'
import { loadConfig } from '../../config/manager.js'
import type { PythonInterpreter } from './interpreter.js'

export interface RuntimeRequest {
  action: Exclude<RuntimeAction, 'doctor'>
  buildPolicy?: 'wheel' | 'source'
  rebuild?: boolean
  entry?: string
  args?: string[]
  stdin?: string
  timeoutSeconds?: number
}
export interface RuntimeExecutionPlan {
  cwd: string
  request: RuntimeRequest
  resolved: ResolvedRuntimeSkill
  files: PackageFile[]
  interpreter: PythonInterpreter
  mirrors: import('../../config/schema.js').MirrorsConfig
  preview: InstallPreview
  envKey: string
  digest: string
}

export function captureRuntimePackage(resolved: ResolvedRuntimeSkill, store = new SkillVersionStore()): { files: PackageFile[]; resolved: ResolvedRuntimeSkill } {
  let files: PackageFile[]
  try { files = store.export(resolved.packageRef) }
  catch {
    files = resolved.files ?? readPackage(resolved.skill.skillDir!).files
    if (store.reference(files) !== resolved.packageRef) throw new RuntimeAccessError('package_version_unavailable', '固定版本不可得，请重新装载技能', 409)
  }
  const declarationFile = files.find(file => file.path === 'runtime.yaml')
  const parsed = declarationFile ? parseRuntimeDeclaration(Buffer.from(declarationFile.data, 'base64').toString('utf8')) : undefined
  if (!parsed?.ok) throw new RuntimeAccessError('invalid_declaration', parsed && !parsed.ok ? parsed.message : '固定版本缺少 runtime.yaml', 422)
  return { files, resolved: { ...resolved, declaration: parsed.declaration, files } }
}

export async function buildRuntimeExecutionPlan(resolved: ResolvedRuntimeSkill, request: RuntimeRequest, context: RuntimePolicyContext, options: { readOnly?: boolean } = {}): Promise<RuntimeExecutionPlan> {
  if (request.args !== undefined && (!Array.isArray(request.args) || !request.args.every(arg => typeof arg === 'string'))) throw new RuntimeAccessError('invalid_args', 'args 必须为字符串数组', 400)
  if (request.timeoutSeconds !== undefined && (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0)) throw new RuntimeAccessError('invalid_timeout', 'timeoutSeconds 必须为正数', 400)
  assertRuntimeAccess(context, options.readOnly ? 'doctor' : request.action, resolved.skill, request as unknown as Record<string, unknown>)
  const captured = captureRuntimePackage(resolved)
  const config = loadConfig({ cwd: context.cwd })
  const probe = await probeInterpreterFor(captured.resolved.declaration, { explicitPath: config.env.pythonPath })
  if (!probe.ok) throw new RuntimeAccessError(probe.result.errorCode ?? 'interpreter_missing', probe.result.message, 422)
  let cwd: string
  try { cwd = realpathSync(context.cwd) } catch { cwd = resolve(context.cwd) }
  const manager = defaultEnvManager()
  let buildPolicy = request.buildPolicy ?? 'wheel'
  const identity = { workspace: cwd, skill: { scope: runtimeSkillScope(resolved.skill), name: resolved.skill.name, skillId: resolved.skill.skillId ?? resolved.skill.name }, packageRef: resolved.packageRef, interpreter: probe.interpreter }
  if (request.action !== 'prepare' && !request.buildPolicy && manager.status({ ...identity, buildPolicy }).status === 'not-prepared' && manager.status({ ...identity, buildPolicy: 'source' }).status !== 'not-prepared') buildPolicy = 'source'
  const envKey = manager.envKey({ ...identity, buildPolicy })
  const packageFiles = Object.fromEntries(captured.files.map(file => [file.path, Buffer.from(file.data, 'base64').toString('utf8')]))
  const requirements = captured.resolved.declaration.python.requirements
  if (requirements && !(requirements in packageFiles)) throw new RuntimeAccessError('invalid_declaration', '固定版本缺少声明的 requirements', 422)
  const built = buildInstallPreview({ ...identity, packageRoot: cwd, packageFiles, declarationRequirements: requirements, ...(requirements ? { requirementsSource: packageFiles[requirements] } : {}), mirrors: config.mirrors, envDir: manager.envDir(envKey), buildPolicy })
  if (!built.ok) throw new RuntimeAccessError(built.result.errorCode ?? 'invalid_requirements', built.result.message, 422)
  const entry = request.entry ? captured.resolved.declaration.python.entries[request.entry] : undefined
  if (request.action === 'run' && !entry) throw new RuntimeAccessError('invalid_entry', `entry：入口「${request.entry}」不在声明内。可用入口：${Object.keys(captured.resolved.declaration.python.entries).join(', ')}`, 400)
  const canonical: RuntimeRequest = { action: request.action, buildPolicy, rebuild: request.rebuild === true, ...(request.action === 'run' ? { entry: request.entry, args: request.args ?? [], stdin: request.stdin ?? '', timeoutSeconds: request.timeoutSeconds ?? entry?.timeoutSeconds ?? 300 } : {}) }
  const digest = createHash('sha256').update(JSON.stringify({ cwd, skill: identity.skill, packageRef: resolved.packageRef, request: canonical, preview: built.preview })).digest('hex')
  const plan = { cwd, request: canonical, resolved: captured.resolved, files: captured.files, interpreter: probe.interpreter, mirrors: config.mirrors, preview: built.preview, envKey, digest }
  return freeze(structuredClone(plan))
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}

export async function revalidateRuntimePlan(plan: RuntimeExecutionPlan, context: RuntimePolicyContext): Promise<void> {
  assertRuntimeAccess(context, plan.request.action, plan.resolved.skill, plan.request as unknown as Record<string, unknown>)
  if (!(plan.resolved.skill as { packageRef?: string }).packageRef) {
    const files = readPackage(plan.resolved.skill.skillDir!).files
    if (new SkillVersionStore().reference(files) !== plan.resolved.packageRef) throw new RuntimeAccessError('preview_mismatch', '技能包在预览后发生变化，请重新预览', 409)
  }
  const current = await buildRuntimeExecutionPlan(plan.resolved, plan.request, context)
  if (current.digest !== plan.digest) throw new RuntimeAccessError('preview_mismatch', '执行配置在预览后发生变化，请重新预览', 409)
}
