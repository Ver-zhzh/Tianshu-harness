import { listVerificationRuns, renderVerificationRun } from '../agent/verification-runs.js'
import { verificationIdentity } from './verification-identity.js'
import type { ToolCallParams, ToolResult } from './types.js'

export function reuseVerification(params: ToolCallParams, tool: 'bash' | 'run_tests'): ToolResult | undefined {
  if (!params.sessionId || params.input.rerun === true || params.input.write_files !== undefined) return undefined
  if (tool === 'run_tests' && (params.input.action ?? 'run') !== 'run') return undefined
  const identity = verificationIdentity(params, tool)
  if (!identity) return undefined
  try {
    const runs = listVerificationRuns(params.cwd, params.sessionId).filter(run => run.startedAt
      && run.requestKey === identity.requestKey && run.requestVersion === identity.requestVersion
      && run.environmentFingerprint === identity.environmentFingerprint)
    if (!runs.length) return undefined
    return { content: `相同代码版本、范围和环境已有执行记录（含运行中或恢复后未知状态）；本次未启动进程、未提高预算。\n${runs.slice(-20).map(renderVerificationRun).join('\n\n')}\n查询用 run_tests(action="get",execution_id) 或 job logs；仅在用户明确要求重跑时传 rerun=true。`, verificationRun: runs.at(-1), isError: false }
  } catch (error) { return { content: `已有回执不可确认：${String(error)}。本次未自动重跑；可查询日志或由用户明确要求 rerun=true。`, isError: false } }
}
