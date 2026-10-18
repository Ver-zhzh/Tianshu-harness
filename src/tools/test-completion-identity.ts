import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
/** Bind the invocation to the workspace before execution; concurrent edits lose evidence. */
export function workspaceIdentity(cwd: string): string | undefined {
  try {
    const hash = createHash('sha256')
    hash.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
    hash.update(execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).toString().split('\0')
    for (const file of untracked.sort()) if (/\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(file) || /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|jest[^/]*\.json|pnpm-(?:lock|workspace)\.yaml|yarn\.lock|bun\.lock)$/.test(file)) { hash.update(file); hash.update(readFileSync(resolve(cwd, file))) }
    return hash.digest('hex')
  } catch { return undefined }
}
