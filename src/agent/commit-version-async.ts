import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { gitCommand, type GitCommandOptions } from '../tools/git-command.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'
import type { CommitVersion } from './commit-version.js'

export async function captureCommitVersionAsync(cwd: string, files: string[], options: GitCommandOptions = {}): Promise<CommitVersion | null> {
  try {
    const hash = createHash('sha256'), root = await realpath(cwd)
    for (const file of [...new Set(files)].sort()) {
      options.signal?.throwIfAborted()
      const path = resolve(root, file), rel = relative(root, path)
      if (isAbsolute(rel) || rel.startsWith('..') || detectSensitiveFile(file).sensitive) return null
      hash.update(file)
      try {
        const actual = await realpath(path), inside = relative(root, actual)
        if (isAbsolute(inside) || inside.startsWith('..')) return null
        for await (const chunk of createReadStream(actual, { signal: options.signal })) hash.update(chunk)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        hash.update('deleted')
      }
    }
    const head = await gitCommand(cwd, ['rev-parse', '--verify', 'HEAD'], options)
    const index = await gitCommand(cwd, ['ls-files', '--stage', '-z'], options)
    if (index.status !== 0 || head.interrupted) return null
    return { head: head.status === 0 ? head.stdout.trim() : 'unborn', index: createHash('sha256').update(index.stdout).digest('hex'), files: hash.digest('hex') }
  } catch { options.signal?.throwIfAborted(); return null }
}
