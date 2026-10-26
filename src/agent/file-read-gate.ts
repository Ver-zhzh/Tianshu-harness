import { currentFileVersion } from './file-version.js'
import { getFileReadContentHash, isFileFullyObserved } from '../tools/read-file.js'
import { validatePath } from '../tools/path-validate.js'
import type { ToolCallParams } from '../tools/types.js'

/** A version-bound exact edit still goes through tool preflight and ownership checks. */
export function fileReadGate(name: string, params: ToolCallParams): string | undefined {
  try {
    const file = validatePath(params.cwd, String(params.input.file_path), 'write')
    const version = currentFileVersion(file)
    if (name === 'edit_file' && version !== null && (params.input.expected_version !== undefined ? params.input.expected_version === version : getFileReadContentHash(file, params.sessionId) === version)) return
    if (name === 'write_file' && (version === null || isFileFullyObserved(file, params.sessionId) && getFileReadContentHash(file, params.sessionId) === version)) return
    return `文件级读前写保护：本次未写入 ${String(params.input.file_path)}。请读取此目标的当前内容，或为精确 edit_file.operations 提供已观察的 expected_version；其他文件的读取不能解除本文件约束。`
  } catch { return '文件级读前写保护：目标无法确认，本次未写入；请核对路径与当前文件版本。' }
}
