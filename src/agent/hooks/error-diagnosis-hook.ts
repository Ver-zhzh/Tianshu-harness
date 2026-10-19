import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { FailureClass } from '../failure-classifier.js'
import { extractPatchTargetPaths } from '../../tools/apply-patch.js'

/**
 * Error Diagnosis Hook — postTool 注入对应错误的用户向诊断建议。
 *
 * 当工具返回错误时，复用 failure-classifier 已完成的分类，
 * 从注册表中查找诊断条目，通过 advisoryBus 按需注入到 agent 上下文。
 *
 * 这替代了 static.ts 中冗长的静态错误转译表——知识不再永久占据
 * prompt 空间，只在错误实际发生时注入。
 *
 * Cooldown: 每轮最多 1 条诊断，避免错误风暴淹没上下文。
 * Tier: operational (priority 0.52) — 高于 lossy-observation (0.48)，
 * 低于 discipline-reanchor (0.55)，确保不挤压更高优先级信号。
 */

interface DiagnosisEntry {
  /** 失败分类线索；不能单凭分类证明根因或代码无关。 */
  diagnosis: string
  /** 用户向下一步——agent 应告知用户的行动 */
  userAction: string
}

const REGISTRY: Partial<Record<FailureClass, DiagnosisEntry>> = {
  type_error: {
    diagnosis: 'TypeScript 类型错误——编译期类型不匹配。',
    userAction: '类型不匹配，不是运行时 bug。检查类型定义和接口签名——可能是属性名拼错、类型窄化不当、或泛型参数遗漏。',
  },
  assertion: {
    diagnosis: '测试断言失败——预期值与实际值不符。',
    userAction: '断言失败。先对比预期值和实际值：是测试写错了还是实现有 bug？不要盲目改代码让测试通过。',
  },
  missing_dep: {
    diagnosis: '命令或包未被当前入口解析。',
    userAction: '先核对项目已安装的入口、脚本、工作目录与 PATH；裸命令不存在不证明本地 runner 不可用。使用已安装入口继续，确需安装时遵守授权边界。',
  },
  runtime_gate: {
    diagnosis: '运行时生命周期门禁——协调器正在关闭或会话正在移交。',
    userAction: '等待当前 worker 收尾或 handoff 完成后重试，不要为了绕过门禁修改代码。',
  },
  timeout: {
    diagnosis: '操作超时——命令在限时内未完成。',
    userAction: '先核对进程是否仍运行、实际限时与剩余预算，排查死循环/未完成的异步调用；超时不等于执行完成或环境死路。根据证据拆分或修复，不原样无限重试。',
  },
  snapshot: {
    diagnosis: '快照变更——测试快照与当前输出不匹配。',
    userAction: '快照发生了变化。如果改动是有意的，更新快照即可；如果无意，说明产生了意外的输出差异。',
  },
  module_resolution: {
    diagnosis: '模块解析失败——当前入口未能解析 import。',
    userAction: '核对真实文件、路径大小写、工作目录、项目 loader 与 package.json exports；未解析不等于文件不存在，不先归因环境。',
  },
  env_missing: {
    diagnosis: '当前进程未取得所需环境字段或凭据。',
    userAction: '先核对配置入口、变量传递与依赖是否启动；确缺凭据时只报告字段名，不搜索其他数据目录或输出密钥。暂停依赖该凭据的步骤，其余已授权检查继续。',
  },
  permission_denied: {
    diagnosis: '权限不足——文件或操作被系统拒绝。',
    userAction: '没有操作权限。检查文件权限（chmod）、沙箱策略、或是否在受限目录中操作。',
  },
  context_window_exceeded: {
    diagnosis: '上下文窗口已满——token 数量超过模型上限。',
    userAction: '上下文窗口已满。运行 /compact 缩减上下文，或开启新会话继续。不需要修改代码。',
  },
  api_error: {
    diagnosis: 'API 服务异常——外部服务返回了错误。',
    userAction: '核对实际状态码、请求入口与服务可用性；遵守 Retry-After 和总预算，有界恢复。不能单凭 429/5xx 排除本地请求或代理配置问题，未确认前不宣布根因。',
  },
  syntax_error: {
    diagnosis: '语法/编译错误——代码不符合语言规则。',
    userAction: '存在语法错误。检查对应的语法位置——可能是括号不匹配、关键字拼错、或意外的 token。',
  },
  format_error: {
    diagnosis: '格式错误——JSON 解析失败或输出格式不正确。',
    userAction: '输出格式不正确（JSON 解析失败/malformed）。重试时调整输出格式——确保 JSON 字符串正确转义、大括号配对。',
  },
  flaky: {
    diagnosis: '不稳定测试——同一测试在不同运行中结果不一致。',
    userAction: '测试可能不稳定。多次运行确认——如果每次失败不同，标记为 flaky 并单独排查（通常是并发/时序问题）。',
  },
  patch_rejected: {
    diagnosis: '补丁被 git apply 拒绝——diff 格式损坏、上下文与文件当前内容不匹配、或目标文件未被 git 跟踪。',
    userAction: '不要原样重发同一补丁。先 read_file 读取目标文件当前内容，核对 hunk 头 @@ 行数计数，基于真实内容重新生成 diff；目标是本会话新建文件时改用 edit_file / write_file。',
  },
}

const ADVISORY_PREAMBLE = '【天枢·诊断】'

export interface ErrorDiagnosisHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 证据义务状态机：失败分类归账到 target 关联义务（同类失败重复 → 升级阶梯）。
   *  归账与诊断 advisory 是同一事实的两个出口——义务改状态，advisory 给措辞，
   *  不额外创建同义 advisory。 */
  obligations?: Pick<import('../obligation-tracker.js').ObligationTracker, 'recordFailureSignal'>
}

const EDIT_TOOLS = new Set(['edit_file', 'hash_edit', 'write_file', 'ast_edit', 'apply_patch'])

/** apply_patch 的目标埋在 diff 的 +++ 头里，没有 file_path 字段。 */
function extractFailureTarget(tool: RuntimeToolEvent): string | undefined {
  if (tool.name === 'apply_patch') {
    const diff = typeof tool.input?.diff === 'string' ? tool.input.diff : undefined
    if (!diff) return undefined
    const targets = extractPatchTargetPaths(diff)
    return targets.length > 0 ? targets.join(',') : undefined
  }
  return typeof tool.input?.file_path === 'string' ? tool.input.file_path : tool.target
}

export function createErrorDiagnosisHook(deps: ErrorDiagnosisHookDeps): PostToolRuntimeHook {
  let lastFiredTurn = -1
  /** 编辑工具失败计数——用于去重：同文件 ≥2 次编辑失败时跳过 error-diagnosis，
   *  因为 edit-failure-recovery-hook 已给出更具体的恢复建议。自维护计数独立于
   *  hook 注册顺序——不依赖 peekPendingKeys，避免静默的顺序耦合。 */
  const editFailCounts = new Map<string, number>()

  return {
    phase: 'postTool',
    name: 'error-diagnosis',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // 编辑工具成功时重置失败计数——必须在 isError 检查之前，
      // 因为成功事件 .isError=false 会被提前返回。
      const failureTarget = extractFailureTarget(tool)
      if (EDIT_TOOLS.has(tool.name) && tool.success && failureTarget) {
        editFailCounts.delete(failureTarget)
      }

      // Only fire on errors
      if (!tool.isError) return
      // Only when failureClass is available
      if (!tool.failureClass) return
      // Unknown class — no diagnosis to give
      if (tool.failureClass === 'unknown') return
      // 义务归账不受每轮 1 条诊断的节流约束——状态推进和文案节流是两回事。
      deps.obligations?.recordFailureSignal(tool.failureClass, failureTarget)

      // 去重：编辑工具失败 ≥2 次同文件时，edit-failure-recovery 已/将给出
      // 更具体的恢复建议。此计数独立于 edit-failure-recovery-hook，不依赖
      // 注册顺序——两个 hook 各自维护 failCounts，但去重阈值一致（≥2）。
      if (EDIT_TOOLS.has(tool.name) && failureTarget) {
        const count = (editFailCounts.get(failureTarget) ?? 0) + 1
        editFailCounts.set(failureTarget, count)
        if (count >= 2) return
      }

      // At most 1 diagnosis per turn
      if (ctx.snapshot.turn === lastFiredTurn) return

      const entry = REGISTRY[tool.failureClass]
      if (!entry) return

      lastFiredTurn = ctx.snapshot.turn
      deps.advisoryBus.submit({
        key: `error-diagnosis:${tool.failureClass}`,
        priority: 0.52,
        category: 'discipline',
        tier: 'operational',
        content: `${ADVISORY_PREAMBLE} ${tool.name} 失败分类 (${tool.failureClass}，不等于根因)：${entry.diagnosis} → ${entry.userAction}`,
        ttl: 1,
      })
    },
  }
}
