import { noteMutationSyntax } from '../agent/mutation-facts.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileChangeTracking, restoreFileChange, type FileChangeRecord } from '../agent/recovery-stack.js'
import { currentFileVersion } from '../agent/file-version.js'
import { checkSyntax, type SyntaxCheckResult } from './syntax-check.js'
import { scriptTransactionPaths } from './script-write-paths.js'
import type { ToolCallParams, ToolResult } from './types.js'

interface TransactionInput { params: ToolCallParams; run: (params: ToolCallParams) => Promise<ToolResult> }
async function syntax(path: string): Promise<SyntaxCheckResult> {
  try { return await checkSyntax(path, readFileSync(path, 'utf8'), { parseOnly: true }) }
  catch (error) { return { fatal: null, warning: `解析未知：${String(error)}`, checked: false } }
}
export const executeScriptTransaction = withFileChangeTracking(async ({ params, run }: TransactionInput, track): Promise<ToolResult> => {
  let paths: string[]
  try {
    paths = scriptTransactionPaths(params.cwd, params.input)
    if (paths.some(path => !params.hasWriteClaim?.(path))) throw new Error('脚本事务需要本会话持有每个声明文件的独占 claim')
  } catch (error) { return { content: `脚本事务未执行：${String(error)}`, isError: true, errorKind: 'format_error' } }
  const files: Array<{ path: string; absolute: string; before: string | null; capture: FileChangeRecord; baseline: SyntaxCheckResult }> = []
  try {
    for (const path of paths) {
      const absolute = join(params.cwd, path), before = currentFileVersion(absolute)
      const capture = await track(params.cwd, { filePath: path, action: before === null ? 'write' : 'edit', toolCallId: params.toolUseId })
      files.push({ path, absolute, before, capture, baseline: before === null ? { fatal: null, warning: null } : await syntax(absolute) })
    }
    if (files.some(file => currentFileVersion(file.absolute) !== file.before || !params.hasWriteClaim?.(file.path))) throw new Error('捕获后版本或 claim 已变化，未启动脚本')
  } catch (error) { return { content: `脚本事务未执行：${String(error)}`, isError: true } }
  let stopped = false, postVersions = new Map<string, string | null>()
  let result: ToolResult
  try {
    result = await run({ ...params, input: { ...params.input, run_in_background: false }, onClientDelegate: undefined,
      onProcessExit: state => {
        stopped = state === 'exited'
        for (const file of files) { try { postVersions.set(file.path, currentFileVersion(file.absolute)) } catch { /* retain scene */ } }
      },
    })
  } catch (error) { result = { content: `脚本执行异常：${String(error)}`, isError: true } }
  const diagnostics: string[] = [], kept: string[] = []
  let failed = !!result.isError || !!params.abortSignal?.aborted || result.exitCode !== undefined && result.exitCode !== 0
  const observations = new Map<string, SyntaxCheckResult>()
  for (const file of files) {
    try {
      const check = currentFileVersion(file.absolute) === null ? { fatal: null, warning: null } : await syntax(file.absolute)
      observations.set(file.path, check)
      noteMutationSyntax(file.capture, check)
      if (check.fatal && !file.baseline.fatal && file.baseline.checked !== false) failed = true
    } catch { failed = true }
  }
  for (const file of files) {
    try {
      const after = currentFileVersion(file.absolute)
      if (after === file.before) continue
      const check = observations.get(file.path) ?? { fatal: null, warning: '语法状态未知', checked: false }
      const newFatal = check.fatal && !file.baseline.fatal && file.baseline.checked !== false
      if (file.baseline.fatal) diagnostics.push(`${file.path}：原文件已有语法错误，未把原状态视为通过`)
      if (file.baseline.checked === false || check.checked === false) diagnostics.push(`${file.path}：语法状态未知，未执行类型检查或测试`)
      if (check.fatal) diagnostics.push(`${file.path}：${check.fatal}`)
      if (failed || newFatal) {
        const restored = stopped && postVersions.has(file.path) && await restoreFileChange(params.cwd, file.capture, params.sessionId,
          { expectedCurrentVersion: postVersions.get(file.path)!, canRestore: () => params.hasWriteClaim?.(file.path) === true })
        diagnostics.push(`${file.path}：${restored ? '已恢复本次捕获' : `未恢复（进程状态、归属或版本冲突）；保留现场，备份 ${file.capture.backupPath ?? '写前不存在'}`}`)
        if (newFatal) failed = true
      }
      if (currentFileVersion(file.absolute) !== file.before) kept.push(file.path)
    } catch (error) {
      failed = true; kept.push(file.path)
      diagnostics.push(`${file.path}：检查/恢复未知，保留现场和备份 ${file.capture.backupPath ?? '写前不存在'}；${String(error)}`)
    }
  }
  for (const path of kept) if (params.hasWriteClaim?.(path)) params.onFileWrite?.(path)
  return { ...result, isError: failed, fileChanges: kept,
    content: `${result.content}\n\n声明文件事务：${paths.join(', ')}\n${diagnostics.join('\n') || '声明文件检查已完成。'}\n仅保护声明文件；未声明文件及网络、数据库副作用不在恢复范围。` }
})
