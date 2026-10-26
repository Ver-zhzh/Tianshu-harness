import type { ChildProcess } from 'node:child_process'
import { killProcessTreeAsync, killProcessTree } from './process-kill.js'

/** A foreground transaction cannot restore while a child can still write. */
export async function confirmScriptStopped(child: ChildProcess): Promise<'exited' | 'unknown'> {
  const result = await killProcessTreeAsync(child)
  if (result !== 'exited') return 'unknown'
  if (!child.pid || process.platform === 'win32') return 'exited'
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-child.pid, 0) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unknown' }
    killProcessTree(child, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return 'unknown'
}
