import { buildRuntimeExecutionPlan, revalidateRuntimePlan } from '../skills/runtime/operation.js'
import { assertRuntimeAccess } from '../skills/runtime/policy.js'
import { SkillManagement, type SkillContext } from '../skills/skill-management.js'
import { SkillImports, type ImportSource } from '../skills/skill-import.js'
import { SkillDrafts } from '../skills/skill-drafts.js'
import { completeSkillDraft } from '../skills/skill-draft-model.js'
import type { SkillMode } from '../skills/skill-metadata.js'
import { exportSessionSkillSnapshot, migrateSessionSkillSnapshot } from '../skills/skill-snapshot-maintenance.js'
import { diagnoseSkillRuntime } from '../skills/runtime/diagnostics.js'
import type { DetectPythonOptions, PythonProbeResult } from '../skills/runtime/interpreter.js'
import { prepareSkillRuntime, resolveRuntimeSkill, runSkillEntry } from '../skills/runtime/executor.js'
import { readPackage, skillPackagePath } from '../skills/skill-package.js'
import type { SkillDefinition, SkillRegistry } from '../skills/skill-loader.js'
import { loadConfig } from '../config/manager.js'
import { createInterface } from 'node:readline'

/** 单技能注册表（CLI 库身份路径）——结构满足 resolveRuntimeSkill 的 get/list 消费面。 */
function singleSkillRegistry(skill: SkillDefinition): SkillRegistry {
  return { get: (name: string) => (name === skill.name ? skill : undefined), list: () => [skill] } as unknown as SkillRegistry
}
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export async function runSkillsCLI(args: string[], options: { cwd?: string; management?: SkillManagement; probePython?: (options: DetectPythonOptions) => Promise<PythonProbeResult> } = {}): Promise<{ output: string; exitCode: number }> {
  const service = options.management ?? new SkillManagement(), imports = new SkillImports(service)
  const command = args[0] ?? 'list'
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const cwd = value('--project') ?? options.cwd ?? process.cwd()
  const scope = value('--scope')
  const target = (): SkillContext => {
    if (scope !== 'personal' && scope !== 'project') throw new Error('Specify --scope personal or --scope project [--project /absolute/path]')
    return { scope, cwd }
  }
  const identity = () => {
    const list = service.list(cwd).skills
    const id = args[1]
    const matches = list.filter(s => (s.skillId === id || s.name === id) && (!scope || s.scope === scope))
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous skill; specify skillId or --scope' : 'Skill not found')
    return matches[0]!
  }
  try {
    let result: unknown
    if (command === 'snapshot-migrate') result = migrateSessionSkillSnapshot(cwd, args[1]!, args.includes('--apply'))
    else if (command === 'snapshot-export') {
      const output = value('--output')
      if (!output) throw new Error('Usage: rivet skills snapshot-export <sessionId> --output <new-file> [--project /absolute/path]')
      result = exportSessionSkillSnapshot(cwd, args[1]!, output)
    }
    else if (command === 'list') { const catalog = service.list(cwd); result = { ...catalog, skills: catalog.skills.filter(s => !scope || s.scope === scope) } }
    else if (command === 'doctor') {
      const catalog = service.list(cwd)
      const baseDiagnostics = (s: (typeof catalog.skills)[number]) => [
        ...(s.shadowedBy ? [{ skillId: s.skillId, code: 'shadowed', detail: s.shadowedBy }] : []),
        ...(s.metadata?.unsupported.map(field => ({ skillId: s.skillId, code: 'unsupported-execution-field', detail: field })) ?? []),
        ...(s.metadata?.dependencies.map(dependency => ({ skillId: s.skillId, code: 'dependency-needs-verification', detail: dependency })) ?? []),
      ]
      // 运行时声明诊断（issue #523）：声明坏 → invalid；目录型技能带
      // requirements.txt/.py 却无 runtime.yaml → 建议补声明（不猜测入口）。
      const diagnosticsOf = (s: (typeof catalog.skills)[number]) => [
        ...baseDiagnostics(s),
        ...(s.metadata?.runtime?.error ? [{ skillId: s.skillId, code: 'invalid-runtime-declaration', detail: s.metadata.runtime.error }] : []),
        ...(!s.metadata?.runtime && s.files.some(f => f === 'requirements.txt' || f.endsWith('.py'))
          ? [{ skillId: s.skillId, code: 'runtime-declaration-suggested', detail: 'package ships Python resources (requirements.txt/*.py) but no runtime.yaml' }]
          : []),
      ]
      if (args[1] && !args[1].startsWith('--')) {
        const skill = identity()
        assertRuntimeAccess({ cwd, origin: 'user' }, 'doctor', { name: skill.name, source: skill.source, mode: skill.mode } as SkillDefinition)
        // 共享诊断聚合（src/skills/runtime/diagnostics.ts）：声明/解释器/requires
        // 匹配 + 真实环境状态（WP3 起不再是恒 not-prepared 占位）。输出契约不变。
        const runtime = await diagnoseSkillRuntime(
          { name: skill.name, skillId: skill.skillId, scope: skill.scope, ...(skill.path ? { path: skill.path } : {}), metadata: skill.metadata },
          { cwd, ...(options.probePython ? { probePython: options.probePython } : {}), explicitPythonPath: loadConfig({ cwd }).env.pythonPath },
        )
        result = { skillId: skill.skillId, name: skill.name, version: skill.version, runtime, diagnostics: diagnosticsOf(skill), effective: 'new-session' }
      } else {
        // 总览输出保持原三类诊断不变——运行时诊断只在 doctor <id> 展开。
        result = { ...catalog, diagnostics: catalog.skills.flatMap(baseDiagnostics), effective: 'new-session' }
      }
    }
    else if (command === 'inspect') { const skill = identity(); result = { ...skill, content: service.content(skill.skillId, cwd) } }
    else if (command === 'prepare') {
      // 技能 Python 运行时环境准备（issue #523）。两段式：先打印安装预览，
      // 交互终端确认后执行；非交互（stdout 非 TTY）必须 --yes。源码构建
      // （--source）还需显式 --allow-source-build（setup.py 任意代码执行面）。
      const skill = identity()
      if (!skill.path) throw new Error('该技能没有可运行的包（内置技能无运行时）')
      const packageDir = skillPackagePath(skill.path)
      if (packageDir === skill.path) throw new Error('扁平 Markdown 技能无 Python 运行时——仅目录型技能支持')
      assertRuntimeAccess({ cwd, origin: 'user' }, command as 'prepare' | 'run', { name: skill.name, source: skill.source, mode: skill.mode } as SkillDefinition)
      const definition = readPackage(packageDir).definition
      const buildPolicy = args.includes('--source') ? 'source' as const : 'wheel' as const
      if (buildPolicy === 'source' && !args.includes('--allow-source-build')) {
        throw new Error('源码构建会执行 setup.py 任意代码——确认风险后加 --allow-source-build')
      }
      const resolved = resolveRuntimeSkill(singleSkillRegistry({ ...definition, skillId: skill.skillId, source: skill.source, bodyPath: skill.path, skillDir: packageDir, mode: skill.mode }), skill.name, { userExplicit: true })
      if (!resolved.ok) throw new Error(resolved.result.message)
      const config = loadConfig({ cwd })
      const plan = await buildRuntimeExecutionPlan(resolved.resolved, { action: 'prepare', buildPolicy, rebuild: args.includes('--rebuild') }, { cwd, origin: 'user' })
      const previewText = JSON.stringify({ envKey: plan.envKey, previewDigest: plan.digest, rebuild: plan.request.rebuild, ...plan.preview }, null, 2)
      if (!args.includes('--yes')) {
        if (!process.stdout.isTTY) throw new Error(`非交互环境必须 --yes 确认。预览：\n${previewText}`)
        console.log(previewText)
        const answer = await new Promise<string>(resolvePrompt => {
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          rl.question(`确认准备环境（${buildPolicy === 'source' ? '源码构建' : '仅 wheel'}）？[y/N] `, a => { rl.close(); resolvePrompt(a) })
        })
        if (!/^(y|yes)$/i.test(answer.trim())) throw new Error('已取消')
      } else {
        if (!args.includes('--json')) console.log(previewText)
      }
      await revalidateRuntimePlan(plan, { cwd, origin: 'user' })
      const outcome = await prepareSkillRuntime(plan.resolved, { plan, cwd, mirrors: config.mirrors, buildPolicy, rebuild: plan.request.rebuild, explicitPythonPath: config.env.pythonPath })
      result = outcome.result
      if (outcome.status !== 'ready') return { output: args.includes('--json') ? JSON.stringify(result, null, 2) : String(outcome.result.message), exitCode: 1 }
    }
    else if (command === 'run') {
      // run <id> <entry> -- <args...>：环境未就绪 → 打印准备指引并非零退出；
      // 就绪 → 执行并透传真实退出码。
      const skill = identity()
      const entry = args[2] && !args[2].startsWith('--') ? args[2] : undefined
      if (!entry) throw new Error('Usage: rivet skills run <id> <entry> -- <args...> [--timeout sec]')
      if (!skill.path) throw new Error('该技能没有可运行的包（内置技能无运行时）')
      const packageDir = skillPackagePath(skill.path)
      if (packageDir === skill.path) throw new Error('扁平 Markdown 技能无 Python 运行时')
      assertRuntimeAccess({ cwd, origin: 'user' }, command as 'prepare' | 'run', { name: skill.name, source: skill.source, mode: skill.mode } as SkillDefinition)
      const definition = readPackage(packageDir).definition
      const resolved = resolveRuntimeSkill(singleSkillRegistry({ ...definition, skillId: skill.skillId, source: skill.source, bodyPath: skill.path, skillDir: packageDir, mode: skill.mode }), skill.name, { userExplicit: true })
      if (!resolved.ok) throw new Error(resolved.result.message)
      const scriptArgs = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
      const timeout = value('--timeout')
      const config = loadConfig({ cwd })
      const plan = await buildRuntimeExecutionPlan(resolved.resolved, { action: 'run', entry, args: scriptArgs, ...(timeout && Number(timeout) > 0 ? { timeoutSeconds: Number(timeout) } : {}) }, { cwd, origin: 'user' })
      await revalidateRuntimePlan(plan, { cwd, origin: 'user' })
      const outcome = await runSkillEntry(resolved.resolved, {
        plan, entry, args: scriptArgs, cwd,
        ...(timeout && Number(timeout) > 0 ? { timeoutSeconds: Number(timeout) } : {}),
        explicitPythonPath: config.env.pythonPath,
      })
      // 未就绪（未准备/解释器失效/声明问题）→ 指引 + exit 1；脚本真实跑过
      // （含 script_failed）→ 透传真实退出码。
      if (outcome.status !== 'ready' && outcome.status !== 'failed') {
        const guidance = outcome.result.message + '\n准备环境：rivet skills prepare ' + skill.skillId + ' --yes'
        return { output: args.includes('--json') ? JSON.stringify({ ...outcome.result, status: outcome.status }, null, 2) : guidance, exitCode: 1 }
      }
      if (outcome.result.stdout && !args.includes('--json')) process.stdout.write(outcome.result.stdout)
      if (outcome.result.stderr && !args.includes('--json')) process.stderr.write(outcome.result.stderr)
      return { output: args.includes('--json') ? JSON.stringify(outcome.result, null, 2) : (outcome.result.stdout ?? ''), exitCode: outcome.result.exitCode ?? 1 }
    }
    else if (command === 'mode') result = service.setMode(identity().skillId, args[2] as SkillMode, cwd)
    else if (command === 'remove') {
      const skill = identity()
      if (!args.includes('--yes')) throw new Error('Use --yes to confirm removal after inspect')
      service.remove(skill.skillId, value('--version') ?? skill.version, cwd); result = { removed: skill.skillId }
    } else if (command === 'add') {
      const context = target()
      const input = args[1]
      if (!input || input.startsWith('--')) throw new Error('Usage: rivet skills add <path|repository> --scope project|personal [--ref ref] [--subpath path] [--select name,...]')
      const source: ImportSource = args.includes('--git') || /^(https?:|ssh:|git@|file:)/.test(input)
        ? { kind: 'git', url: input, ref: value('--ref'), subpath: value('--subpath') }
        : input.endsWith('.zip') ? { kind: 'zip', path: input } : { kind: 'local', path: input }
      const preview = await imports.preview(source)
      if (args.includes('--preview')) result = preview
      else {
        const names = value('--select')?.split(',')
        if (!names && preview.candidates.length !== 1 && !args.includes('--all')) throw new Error('Multiple skills found; use --select name,... or --all after --preview')
        const selected = preview.candidates.filter(c => !names || names.includes(c.name))
        if (names && names.some(name => !selected.some(c => c.name === name))) throw new Error('Selected skill was not found')
        result = imports.install(preview.previewId, context, selected.map(c => ({ candidateId: c.candidateId, name: value('--name'),
          conflict: args.includes('--overwrite') ? 'overwrite' : 'skip', expectedVersion: value('--version') })))
      }
    } else if (command === 'draft') {
      const context = target(), name = args[1], file = value('--file')
      if (!name || name.startsWith('--') || !file || file.startsWith('--')) throw new Error('Usage: rivet skills draft <name> --file <markdown-path> --scope personal|project [--project /absolute/path] [--version <reviewed-version>]')
      result = new SkillDrafts(service).save(context, name, readFileSync(resolve(cwd, file), 'utf8'), value('--version') ?? null)
    } else if (command === 'drafts') result = new SkillDrafts(service).list(target())
    else if (command === 'approve') result = new SkillDrafts(service).approve(target(), args[1]!, value('--version'))
    else if (command === 'reject') result = new SkillDrafts(service).reject(target(), args[1]!, value('--version'))
    else if (command === 'generate') result = await new SkillDrafts(service).generate(target(), { name: args[1]!, goal: value('--goal') ?? '', paths: value('--files')?.split(',') ?? [], excerpt: value('--excerpt') }, completeSkillDraft)
    else if (command === 'update') {
      const skill = identity(), preview = await imports.update(skill.skillId, cwd)
      if (preview.candidates.length !== 1) throw new Error('Update source no longer contains exactly one skill; inspect the repository and use add with explicit selection')
      const candidate = preview.candidates[0]!
      const diff = imports.diff(preview.previewId, candidate.candidateId, skill.skillId, cwd)
      if (!args.includes('--apply')) result = { ...preview, diff, apply: `rivet skills update ${skill.skillId} --apply --version ${skill.version} --source-version ${candidate.version}${preview.locallyModified ? ' --overwrite-local' : ''}` }
      else {
        if (value('--version') !== skill.version || value('--source-version') !== candidate.version) throw new Error('Update requires the local and source versions shown by the preview')
        if (preview.locallyModified && !args.includes('--overwrite-local')) throw new Error('Local modifications detected; review diff and explicitly use --overwrite-local')
        result = imports.install(preview.previewId, { scope: skill.scope, cwd }, [{ candidateId: candidate.candidateId, name: skill.name, conflict: 'overwrite', expectedVersion: skill.version }])
      }
    }
    else throw new Error('Commands: list, inspect, add, mode, update (preview), remove, doctor [id], prepare <id> [--yes] [--rebuild] [--source --allow-source-build], run <id> <entry> -- [args...] [--timeout sec], draft (--file; --version to update), drafts, approve, reject, generate, snapshot-migrate (dry-run; --apply), snapshot-export')
    return { output: args.includes('--json') ? JSON.stringify(result, null, 2) : format(result), exitCode: 0 }
  } catch (error) { return { output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), exitCode: 1 } }
}
function format(result: unknown): string {
  if (result && typeof result === 'object' && 'skills' in result) {
    const catalog = result as ReturnType<SkillManagement['list']>
    return catalog.skills.map(s => `${s.skillId}  ${s.displayName}  ${s.scope}  ${s.mode}${s.shadowedBy ? ' (shadowed)' : ''}\n  ${s.path ?? s.source}`).concat(catalog.errors, 'diagnostics' in result ? JSON.stringify(result.diagnostics, null, 2) : []).join('\n')
  }
  return JSON.stringify(result, null, 2)
}
