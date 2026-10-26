import { resolve } from 'node:path'
import { createFileRepairStore } from './file-repair-store.js'
import { currentFileVersion } from './file-version.js'
import { extractWriteFilePaths } from '../tools/write-tool-helpers.js'
import { getFileReadContentHash } from '../tools/read-file.js'
import { isLiteralReadShell } from '../tools/shell-read-safety.js'
import type { ToolCallParams } from '../tools/types.js'

export function fileRepairGuard(name: string, params: ToolCallParams): string | undefined {
  if (!params.sessionId || name === 'deliver_task') return undefined
  const active = createFileRepairStore(params.cwd, params.sessionId).list().filter(f => f.state === 'active')
  const paths = extractWriteFilePaths(name, params.input).map(file => resolve(params.cwd, file))
  for (const repair of active) {
    const file = resolve(params.cwd, repair.file)
    if (name === 'bash') {
      if (Array.isArray(params.input.write_files)) continue
      const command = String(params.input.command ?? '')
      if (isLiteralReadShell(command)) continue
      // Opaque scripts can compute the target dynamically. Declare their files instead of guessing from substrings.
    } else {
      if (!paths.includes(file)) continue
      const version = currentFileVersion(file)
      const bound = params.input.expected_version === version || getFileReadContentHash(file, params.sessionId) === version
      if (['edit_file', 'hash_edit', 'apply_patch', 'ast_edit'].includes(name) && bound) continue
    }
    return `文件 ${repair.file} 处于受控恢复态；本次未写入。使用 edit_file.operations 并绑定 expected_version=${currentFileVersion(file) ?? 'missing'}，或显式 bash.write_files 事务。精确编辑须先读取当前版本。可用 todo.write.repairs 记录受阻／延后及原因；其他文件和安全提交不受影响。`
  }
}
