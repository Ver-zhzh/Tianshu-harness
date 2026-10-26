import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'

export function contentVersion(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
export function currentFileVersion(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error('版本检查只接受普通文件')
    return contentVersion(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
