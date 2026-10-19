import { relative } from 'node:path'
import type { TestPlanBlock, TestExecutionPlan } from './test-execution-plan.js'
import { buildTestExecutionPlanAsync } from './test-plan-async.js'
import { runTestPhases } from './run-test-phases.js'
import type { ToolCallParams, ToolResult } from './types.js'

function blockedResult(block: TestPlanBlock): ToolResult {
  const message = block.reason + (block.candidates?.length ? '\n候选文件：\n' + block.candidates.join('\n') : '')
  return { content: message, isError: true, verification: {
    command: '(auto-detect tests)', recommendedCommand: 'npm test', kind: 'test', status: 'blocked', scope: 'targeted',
    blockedReason: block.code === 'filter_unresolved' ? 'filter_unresolved' : 'unknown_runner',
    userGuidance: message, targetFiles: block.files, timestamp: Date.now(),
  } }
}
/** Every real batch retains its own receipt and phase; no aggregate can invent coverage. */
export async function runPlannedTests(params: ToolCallParams, remaining: () => number): Promise<ToolResult> {
  const files = params.input.files
  if (files !== undefined && (!Array.isArray(files) || files.some(file => typeof file !== 'string'))) return blockedResult({ files: [], code: 'invalid_selection', reason: 'files 必须是测试文件路径列表。' })
  if (params.input.projects !== undefined && (!Array.isArray(params.input.projects) || params.input.projects.some(p => typeof p !== 'string' || !p)) || params.input.shard !== undefined && params.input.shard !== false) return blockedResult({ files: [], code: 'invalid_selection', reason: 'projects 必须为非空名称列表；shard 只接受显式 false 覆盖。' })
  let plan: TestExecutionPlan
  try {
    plan = await buildTestExecutionPlanAsync(Date.now() + remaining(), params.abortSignal, params.cwd,
      { files: files as string[] | undefined, filter: params.input.filter as string | undefined, projects: params.input.projects as string[] | undefined, shard: params.input.shard as false | undefined })
  } catch {
    const stopped = params.abortSignal?.aborted || remaining() <= 0
    const result = blockedResult({ files: files as string[] ?? [], code: 'unknown_runner', reason: stopped ? '测试准备已取消或超时，未启动后续执行。' : '验证计划进程不可用或超时；未在服务线程同步重算，测试义务保留。' })
    if (!params.abortSignal?.aborted && remaining() <= 0) {
      result.errorKind = 'timeout'
      Object.assign(result.verification!, { failureKind: 'timeout', blockedReason: 'timeout' })
    }
    return result
  }
  const results: ToolResult[] = []
  for (const group of plan.groups) {
    const command = { type: 'run' as const, command: group.command, args: group.args, display: group.display,
      runner: group.runner, scope: group.files.length ? 'targeted' as const : 'full' as const,
      relativeCwd: relative(params.cwd, group.cwd), targetFiles: group.files.length ? group.files : undefined }
    results.push(await runTestPhases(params, command, undefined, remaining))
    if (params.abortSignal?.aborted || remaining() <= 0) break
  }
  results.push(...plan.blocked.map(blockedResult))
  if (!results.length) return blockedResult({ files: [], code: 'unknown_runner', reason: '没有可执行的测试计划。' })
  if (results.length === 1) return results[0]!
  const events = results.flatMap(result => [...(result.verification ? [result.verification] : []), ...(result.extraVerifications ?? [])])
  return { ...results[0], content: results.map((result, i) => `[验证批次 ${i + 1}/${results.length}]\n${result.content}`).join('\n\n'),
    isError: results.some(result => result.isError), verification: events[0], extraVerifications: events.slice(1) }
}
