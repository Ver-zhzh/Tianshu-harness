import { spawnGit } from './spawn-git.js'
import { killProcessTreeAsync } from './process-kill.js'
import { track } from './process-tracker.js'

export interface GitCommandOptions { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number }
export async function gitCommand(cwd: string, args: string[], options: GitCommandOptions = {}) {
  options.signal?.throwIfAborted()
  return new Promise<{ status: number | null; stdout: string; stderr: string; interrupted: boolean }>(resolve => {
    const child = track(spawnGit(args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }))
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
    let bytes = 0, interrupted = false, cleanup: Promise<unknown> = Promise.resolve()
    const stop = () => {
      if (interrupted) return
      interrupted = true
      cleanup = killProcessTreeAsync(child)
    }
    const timer = setTimeout(stop, options.timeoutMs ?? 10_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
    for (const name of ['stdout', 'stderr'] as const) child[name]?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.maxBuffer ?? 32 * 1024 * 1024)) stop()
      else chunks[name].push(chunk)
    })
    let failure = ''
    child.once('error', error => { failure = error.message })
    child.once('close', async status => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
      await cleanup
      resolve({ status: interrupted ? null : status, interrupted,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') || failure })
    })
  })
}
