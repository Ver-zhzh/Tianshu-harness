/** Experiment-only correction to the historical oracle. Never edits production. */
export const REFERENCE_PATCH_VERSION = 'group-cleanup-v1'
export function correctedReference(files: Record<string, string>) {
  const path = 'src/tools/process-kill.ts', source = files[path]!
  const begin = source.indexOf('export async function killProcessTreeAsync(')
  const end = source.indexOf('\n}\n', begin) + 3
  if (begin < 0 || end < begin) throw new Error('Historical reference patch anchor changed')
  const replacement = `export async function killProcessTreeAsync(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessCleanupResult> {
  if (!child.pid) return 'exited'
  if (process.platform === 'win32') return runTaskkillAsync(taskkillArgs(child.pid))
  const group = child.pid
  const send = (sig: NodeJS.Signals) => { try { process.kill(-group, sig) } catch {} }
  const alive = () => { try { process.kill(-group, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' } }
  const pause = () => new Promise<void>(r => setTimeout(r, 20))
  send(signal)
  const grace = Date.now() + 300
  while (alive() && Date.now() < grace) await pause()
  // A direct-child exit or closed stdio does not establish group termination.
  if (alive()) send('SIGKILL')
  const deadline = Date.now() + 1200
  while (alive() && Date.now() < deadline) await pause()
  return alive() ? 'unknown' : 'exited'
}
`
  return { ...files, [path]: source.slice(0, begin) + replacement + source.slice(end) }
}
