import type { ToolCallParams, ToolResult } from './types.js'
import { renderVerificationRun } from '../agent/verification-runs.js'
import { readEvidenceFacts } from '../agent/evidence-facts.js'

export function queryVerificationRuns(params: ToolCallParams): ToolResult | undefined {
  const action = params.input.action ?? 'run'
  if (action === 'run') return undefined
  if (action !== 'list' && action !== 'get') return { content: 'action 必须是 run/list/get', isError: true, errorKind: 'format_error' }
  if (!params.sessionId) return { content: '没有会话归属，无法查询执行回执。', isError: true, errorKind: 'format_error' }
  try {
    const facts = readEvidenceFacts(params.cwd, params.sessionId)
    if (facts.errors.some(error => error.startsWith('执行回执'))) throw new Error('执行回执损坏或归属不符')
    const runs = facts.runs
    const versionNote = '\n历史执行事实；当前版本有效性未知（查询不计算指纹或启动进程）。'
    if (action === 'get') {
      const run = runs.find(r => r.executionId === params.input.execution_id)
      return run ? { content: renderVerificationRun(run) + versionNote, verificationRun: run }
        : { content: '本会话没有该执行回执。', isError: true, errorKind: 'format_error' }
    }
    return { content: runs.length ? runs.slice(-20).map(run => renderVerificationRun(run) + versionNote).join('\n\n') : '本会话尚无真实执行回执。查询未启动任何验证。' }
  } catch (error) { return { content: `回执读取失败：${String(error)}`, isError: true, errorKind: 'format_error' } }
}
