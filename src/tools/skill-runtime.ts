/**
 * skill_runtime — 技能 Python 运行时（issue #523 WP3）。
 *
 * 三个动作：
 * - doctor：声明/解释器/环境状态聚合诊断（只读，免审批）。
 * - prepare：探测解释器并准备隔离环境（venv + 审核后的 requirements 安装）。
 *   恒需审批；buildPolicy:'source' 走 requiresUnconditionalApproval（源码构建
 *   会执行 setup.py 任意代码，allow 规则与 auto-safe 都不得豁免）。
 * - run：在已准备环境里运行声明的脚本入口。先 verifyReady（解释器漂移 →
 *   environment_stale，不自动重建），再从固定版本库物化独立资源副本执行。
 *   非零退出即失败（errorCode script_failed），不自动重跑。
 *
 * 定义字节稳定（不含任何具体技能名）——可运行集由会话注册表与技能的
 * runtime.yaml 声明决定。
 */
import type { Tool, ToolResult } from './types.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { loadConfig } from '../config/manager.js'
import { diagnoseSkillRuntime } from '../skills/runtime/diagnostics.js'
import { prepareSkillRuntime, resolveRuntimeSkill, runSkillEntry, DEFAULT_RUN_TIMEOUT_SECONDS } from '../skills/runtime/executor.js'
import { buildRuntimeExecutionPlan, revalidateRuntimePlan } from '../skills/runtime/operation.js'
import { assertRuntimeAccess, runtimeSkillScope, type RuntimePolicyContext } from '../skills/runtime/policy.js'
import type { RuntimeResult, RuntimeStatus } from '../skills/runtime/run-contract.js'

/** 输出超过此阈值走 ArtifactStore（L0 自包装形态，同 bash）。 */
const ARTIFACT_THRESHOLD = 60_000

function resultContent(status: RuntimeStatus, result: RuntimeResult): string {
  return JSON.stringify({ status, ...result }, null, 2)
}

async function renderOutcome(status: RuntimeStatus, result: RuntimeResult, params: Parameters<Tool['execute']>[0], target: string): Promise<ToolResult> {
  const isError = status !== 'ready' || result.errorCode !== undefined || (result.exitCode !== undefined && result.exitCode !== 0)
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
  if (combined.length >= ARTIFACT_THRESHOLD && params.artifactStore) {
    const lines = combined.split('\n')
    const artifactId = await params.artifactStore.save({
      tool: 'skill_runtime',
      target,
      rawContent: combined,
      summary: `${target} 输出（${lines.length} 行）`,
      sections: [{ name: 'full', lineStart: 1, lineEnd: lines.length, charCount: combined.length }],
    })
    const slim: RuntimeResult = { ...result, stdout: result.stdout?.slice(0, 4000), stderr: result.stderr?.slice(-4000), logRef: `artifact:${artifactId}` }
    return {
      content: `${resultContent(status, slim)}\n完整输出已落 artifact，用 read_section(artifactId="${artifactId}") 按需读取。\n[artifact:${artifactId}]`,
      isError,
    }
  }
  return { content: resultContent(status, result), isError }
}

export const SKILL_RUNTIME_TOOL: Tool = {
  definition: {
    name: 'skill_runtime',
    description: `运行技能的 Python 运行时（issue #523）。

action:
- doctor：查看某技能的运行时声明、解释器探测与环境状态（只读）。
- prepare：为该技能准备隔离 Python 环境（venv + 安装审核后的依赖；默认仅 wheel，buildPolicy="source" 允许源码构建）。
- run：在已准备的环境中运行声明里 entries 的某个入口脚本（entry 必填；args 为字符串数组，stdin 可选）。

仅目录型且带 runtime.yaml 声明的技能支持。prepare/run 需要用户审批；脚本非零退出即失败，不会自动重跑。`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['doctor', 'prepare', 'run'], description: '要执行的动作。' },
        name: { type: 'string', description: '技能名（available-skills 区块里的确切名称）。' },
        entry: { type: 'string', description: 'run 的入口名（runtime.yaml 的 entries 键）。' },
        args: { type: 'array', items: { type: 'string' }, description: 'run 透传给脚本的参数（argv 数组，不经 shell）。' },
        stdin: { type: 'string', description: 'run 喂给脚本的 stdin（UTF-8）。' },
        timeoutSeconds: { type: 'number', description: `run 超时秒数；缺省取 entry 声明值，再兜底 ${DEFAULT_RUN_TIMEOUT_SECONDS}s。` },
        rebuild: { type: 'boolean', description: '显式重建当前环境，须确认预览。' },
        buildPolicy: { type: 'string', enum: ['wheel', 'source'], description: 'prepare 的构建策略，默认 wheel（仅预编译包）。' },
      },
      required: ['action', 'name'],
    },
  },

  async execute(params) {
    try {
    const action = params.input.action
    if (action !== 'doctor' && action !== 'prepare' && action !== 'run') {
      return { content: '错误：action 必须是 doctor/prepare/run', isError: true }
    }
    const name = typeof params.input.name === 'string' ? params.input.name.trim() : ''
    if (!name) return { content: '错误：name 必填', isError: true }

    const registry = params.skillRegistry ?? skillRegistry
    const resolved = resolveRuntimeSkill(registry, name, { intent: action === 'doctor' ? 'diagnose' : 'execute', ...(params.sessionId ? { sessionId: params.sessionId } : {}) })
    if (!resolved.ok) return { content: resultContent('invalid', resolved.result), isError: true }
    const { skill, packageRef } = resolved.resolved

    const config = loadConfig({ cwd: params.cwd })
    assertRuntimeAccess({ cwd: params.cwd, origin: 'model', sessionId: params.sessionId }, action, skill, params.input)
    const plan = action === 'doctor' ? undefined : params.runtimeExecutionPlan ?? await prepareSkillRuntimeCall(params, { cwd: params.cwd, origin: 'model', sessionId: params.sessionId })

    if (action === 'doctor') {
      const diagnosis = await diagnoseSkillRuntime(
        { name: skill.name, skillId: skill.skillId ?? skill.name, scope: runtimeSkillScope(skill), ...(skill.bodyPath ? { path: skill.bodyPath } : {}), metadata: skill.metadata, packageRef },
        { cwd: params.cwd, explicitPythonPath: config.env.pythonPath },
      )
      return { content: JSON.stringify({ name: skill.name, packageRef, ...diagnosis }, null, 2), isError: false }
    }

    if (plan) await revalidateRuntimePlan(plan, { cwd: params.cwd, origin: 'model', sessionId: params.sessionId })
    if (action === 'prepare') {
      const buildPolicy = params.input.buildPolicy === 'source' ? 'source' : 'wheel'
      const outcome = await prepareSkillRuntime(resolved.resolved, {
        plan, rebuild: plan?.request.rebuild,
        cwd: params.cwd,
        mirrors: config.mirrors,
        buildPolicy,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        ...(params.onOutput ? { onOutput: params.onOutput } : {}),
        explicitPythonPath: config.env.pythonPath,
      })
      return renderOutcome(outcome.status, outcome.result, params, `${skill.name} prepare`)
    }

    // run
    const entry = typeof params.input.entry === 'string' ? params.input.entry.trim() : ''
    if (!entry) return { content: '错误：run 需要 entry（runtime.yaml 的 entries 键）', isError: true }
    const args = Array.isArray(params.input.args) ? params.input.args.filter((a): a is string => typeof a === 'string') : []
    const timeoutSeconds = typeof params.input.timeoutSeconds === 'number' && params.input.timeoutSeconds > 0 ? params.input.timeoutSeconds : undefined
    const outcome = await runSkillEntry(resolved.resolved, {
      plan, entry, args,
      ...(typeof params.input.stdin === 'string' ? { stdin: params.input.stdin } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      cwd: params.cwd,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      ...(params.onOutput ? { onOutput: params.onOutput } : {}),
      explicitPythonPath: config.env.pythonPath,
    })
    return renderOutcome(outcome.status, outcome.result, params, `${skill.name}/${entry}`)
    } catch (error) {
      return { content: JSON.stringify({ status: 'failed', errorCode: (error as { code?: string }).code ?? 'invalid_declaration', message: error instanceof Error ? error.message : String(error) }), isError: true }
    }
  },

  // prepare/run 恒需审批；doctor 只读免审。source 构建的无条件门在
  // approval-risk.ts 的 requiresUnconditionalApproval（按动作+策略判定）。
  requiresApproval: params => params.input?.action === 'prepare' || params.input?.action === 'run',
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  timeoutMs: params => {
    const action = params?.input?.action
    if (action === 'prepare') return 900_000
    if (action === 'run') {
      const seconds = typeof params?.input?.timeoutSeconds === 'number' && params.input.timeoutSeconds > 0 ? params.input.timeoutSeconds : DEFAULT_RUN_TIMEOUT_SECONDS
      return seconds * 1000 + 30_000
    }
    return 60_000
  },
}

export async function prepareSkillRuntimeCall(params: Parameters<Tool['execute']>[0], context: RuntimePolicyContext) {
  const registry = params.skillRegistry ?? skillRegistry
  const skill = registry.get(String(params.input.name))
  assertRuntimeAccess(context, params.input.action as 'prepare' | 'run', skill, params.input)
  const resolved = resolveRuntimeSkill(registry, String(params.input.name), { sessionId: params.sessionId })
  if (!resolved.ok) throw new Error(resolved.result.message)
  return buildRuntimeExecutionPlan(resolved.resolved, {
    action: params.input.action as 'prepare' | 'run',
    buildPolicy: params.input.buildPolicy === 'source' ? 'source' : undefined,
    rebuild: params.input.rebuild === true,
    entry: typeof params.input.entry === 'string' ? params.input.entry : undefined,
    args: Array.isArray(params.input.args) ? params.input.args as string[] : undefined,
    stdin: typeof params.input.stdin === 'string' ? params.input.stdin : undefined,
    timeoutSeconds: typeof params.input.timeoutSeconds === 'number' ? params.input.timeoutSeconds : undefined,
  }, context)
}
