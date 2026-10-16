import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { assertSingleLinkFile } from '../utils/file-links.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'

const MAX_BYTES = 800_000

/** One containment/identity policy for walks, first reads, rereads and restored paths. */
export class WorkspaceFileReader {
  private readonly root: string
  constructor(private readonly cwd: string) {
    try { this.root = realpathSync(cwd) } catch { this.root = resolve(cwd) }
  }

  private inside(path: string): boolean {
    const rel = relative(this.root, path)
    return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel)
  }

  stat(path: string): Stats | null {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() && resolve(path) !== resolve(this.cwd)) return null
      const real = realpathSync(path)
      if (!this.inside(real) || detectSensitiveFile(path).sensitive || detectSensitiveFile(real).sensitive) return null
      if (stat.isSymbolicLink()) return lstatSync(real) // A symlinked workspace root is legitimate.
      assertSingleLinkFile(path, stat)
      return stat
    } catch { return null }
  }

  read(rel: string): string | null {
    const path = resolve(this.cwd, rel)
    const expected = this.stat(path)
    if (!expected?.isFile() || expected.size > MAX_BYTES) return null
    let fd: number | undefined
    try {
      const real = realpathSync(path)
      if (!this.inside(real)) return null
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
      fd = openSync(real, flags)
      const actual = fstatSync(fd)
      assertSingleLinkFile(path, actual)
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size > MAX_BYTES
        || realpathSync(path) !== real || !this.inside(realpathSync(real))) return null
      const buffer = Buffer.alloc(actual.size + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes)
        if (!count) break
        bytes += count
      }
      if (bytes > actual.size) return null
      const final = fstatSync(fd)
      assertSingleLinkFile(path, final)
      if (final.mtimeMs !== actual.mtimeMs || final.ctimeMs !== actual.ctimeMs) return null
      const content = buffer.subarray(0, bytes).toString('utf8')
      return content.length > 200_000 ? null : content
    } catch { return null }
    finally { if (fd !== undefined) closeSync(fd) }
  }
}
