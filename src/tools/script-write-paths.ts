import { lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { validatePath } from './path-validate.js'
import { detectSensitiveFileOnDisk } from './sensitive-file-detector.js'

export function scriptTransactionPaths(cwd: string, input: Record<string, unknown>): string[] {
  if (input.run_in_background !== undefined && input.run_in_background !== false) throw new Error('write_files 只支持前台执行，不能与后台启动组合')
  if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || Number(input.timeout) <= 0 || Number(input.timeout) > 120_000)) throw new Error('脚本事务 timeout 必须为 1–120000 毫秒')
  return scriptWritePaths(cwd, input.write_files)
}

export function scriptWritePaths(cwd: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('write_files 需要 1–50 个明确文件路径')
  const paths = value.map(raw => {
    if (typeof raw !== 'string' || !raw.trim() || /[*?\[\]{}\n\r\0]/.test(raw)) throw new Error('write_files 拒绝目录、通配符和非明确路径')
    const path = validatePath(cwd, raw), rel = relative(resolve(cwd), path).replaceAll('\\', '/')
    if (!rel || /^(?:\.git(?:\/|$)|\.rivet\/(?:backups|locks)(?:\/|$))/.test(rel)) throw new Error('write_files 不接受仓库元数据')
    if (detectSensitiveFileOnDisk(path).sensitive) throw new Error('write_files 拒绝敏感材料')
    let current = resolve(cwd)
    for (const part of rel.split('/')) {
      current = join(current, part)
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('脚本事务不接受符号链接路径') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    try { if (!lstatSync(path).isFile()) throw new Error('write_files 仅支持普通文件') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return rel
  })
  return [...new Set(paths)]
}
