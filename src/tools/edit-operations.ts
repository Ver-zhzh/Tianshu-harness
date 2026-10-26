import { applyEol, chooseEol, detectEol } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { ToolCallParams, ToolResult } from './types.js'
import { withFileChangeTracking, restoreFileChange, expectFileChange } from '../agent/recovery-stack.js'
import { contentVersion, currentFileVersion } from '../agent/file-version.js'
import { noteMutationSyntax } from '../agent/mutation-facts.js'
import { createMatchResolver } from './ast-match-refs.js'
import { validatePath } from './path-validate.js'
import { detectSensitiveFileOnDisk } from './sensitive-file-detector.js'
import { checkSyntax } from './syntax-check.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'
import { recordSuccessfulEdit } from './read-file.js'

class EditPreflightError extends Error {
  constructor(message: string, readonly reason: string, readonly kind: 'format_error' | 'refused' = 'format_error') { super(message) }
}

export const executeEditOperations = withFileChangeTracking(async (params: ToolCallParams, track): Promise<ToolResult> => {
  try {
    const file = validatePath(params.cwd, String(params.input.file_path), 'write'), ops = params.input.operations
    if (detectSensitiveFileOnDisk(file).sensitive) throw new Error('不接受敏感材料')
    if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw new EditPreflightError('operations 需要 1–200 项', 'invalid_operations')
    if (params.input.old_string !== undefined || params.input.new_string !== undefined || params.input.replace_all !== undefined) throw new EditPreflightError('批量 operations 与旧单项参数互斥', 'mixed_edit_modes')
    const source = await readFile(file, 'utf8'), version = contentVersion(source)
    if (typeof params.input.expected_version !== 'string' || !params.input.expected_version) throw new EditPreflightError(`operations 必须同时提供 expected_version；未写入。当前版本：${version}。请绑定已观察的文件版本后提交。`, 'missing_expected_version')
    if (params.input.expected_version !== version) throw new EditPreflightError(`版本不符，未写入。当前版本：${version}；请读取目标文件的当前内容。`, 'stale_version', 'refused')
    const eol = chooseEol(file, detectEol(source), getTargetEol())
    const edits: Array<{ start: number; end: number; replacement: string }> = []
    const refs = new Set<string>()
    let resolveMatch: ReturnType<typeof createMatchResolver> | undefined
    for (const op of ops) {
      if (!op || typeof op.new_string !== 'string') throw new EditPreflightError('每项需要 new_string（删除时为空串）', 'invalid_operation')
      if (typeof op.match_ref === 'string') {
        if (op.old_string !== undefined || refs.has(op.match_ref)) throw new EditPreflightError('引用重复或与文本匹配参数混用', 'duplicate_or_mixed_ref')
        refs.add(op.match_ref)
        edits.push({ ...(resolveMatch ??= createMatchResolver(params))(op.match_ref, file, version, source), replacement: applyEol(op.new_string, eol) })
      } else {
        if (typeof op.old_string !== 'string' || !op.old_string.length) throw new EditPreflightError('文本操作需要非空 old_string', 'invalid_operation')
        const expected = op.expected_count ?? 1
        if (!Number.isSafeInteger(expected) || expected < 1) throw new EditPreflightError('expected_count 必须为正整数', 'invalid_expected_count')
        const found: number[] = []
        for (let offset = source.indexOf(op.old_string); offset !== -1; offset = source.indexOf(op.old_string, offset + 1)) found.push(offset)
        if (found.length !== expected) throw new EditPreflightError(`匹配数量不符：期望 ${expected}，实际 ${found.length}；未写入`, 'match_count')
        for (const start of found) edits.push({ start, end: start + op.old_string.length, replacement: applyEol(op.new_string, eol) })
      }
    }
    edits.sort((a, b) => a.start - b.start)
    if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1]!.end)) throw new EditPreflightError('操作范围重叠，未写入', 'overlap')
    let next = source
    for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end)
    const syntax = await checkSyntax(file, next, { parseOnly: true })
    if (syntax.fatal) return { content: `批量编辑预检发现结构错误，未写入：${syntax.fatal}`, isError: true, errorKind: 'syntax_error' }
    if (params.input.dry_run === true) return { content: `预览：${edits.length} 处已精确定位，未写入。version=${version}` }
    const capture = await track(params.cwd, { filePath: relative(params.cwd, file), action: 'edit', toolCallId: params.toolUseId })
    if (currentFileVersion(file) !== version || params.hasWriteClaim?.(relative(params.cwd, file)) === false) throw new EditPreflightError('捕获后版本或归属变化，未写入', 'ownership_or_version_conflict', 'refused')
    expectFileChange(capture, next, () => params.hasWriteClaim?.(relative(params.cwd, file)) ?? true)
    const land = await landingWriteFile(params, file, source, next)
    if (land.kind === 'delegated' && (isDelegateRejected(land.delegated) || land.delegated.isError)) return delegatedToToolResult(land.delegated)
    if (currentFileVersion(file) !== contentVersion(next)) return { content: '批量写入后检测到并发修改；保留当前内容与捕获，不覆盖现场。', isError: true, errorKind: 'refused' }
    const check = await checkSyntax(file, next, { parseOnly: true })
    noteMutationSyntax(capture, check)
    if (check.fatal) {
      const restored = await restoreFileChange(params.cwd, capture, params.sessionId)
      return { content: `批量写入后结构错误；${restored ? '已恢复本次捕获' : '恢复冲突，保留现场和备份'}：${check.fatal}`, isError: true, errorKind: 'syntax_error' }
    }
    await recordSuccessfulEdit(file, params.sessionId, next, false)
    return { content: `已一次写入 ${edits.length} 处精确修改；version=${contentVersion(next)}${check.checked === false ? '；解析状态未知' : check.html ? '；HTML 标签及可执行内联脚本已解析（外部/数据脚本见覆盖回执）' : '；结构可解析'}`,
      changedRanges: [{ start: source.slice(0, edits[0]!.start).split('\n').length, end: next.split('\n').length - source.slice(edits.at(-1)!.end).split('\n').length + 1 }] }
  } catch (error) { return { content: `批量编辑未完成：${String(error)}`, isError: true, errorKind: error instanceof EditPreflightError ? error.kind : 'refused', errorReason: error instanceof EditPreflightError ? error.reason : 'edit_preflight_failed' } }
})
