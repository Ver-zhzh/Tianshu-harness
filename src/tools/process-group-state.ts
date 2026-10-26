import { execFile } from 'node:child_process'

const probes = new Map<number, Promise<boolean>>()

/** Uncertainty retains ownership. Probes never block the host event loop. */
export function ownedProcessTreeAliveAsync(pid: number): Promise<boolean> {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0) }
  catch (error) { return Promise.resolve((error as NodeJS.ErrnoException).code !== 'ESRCH') }
  if (process.platform === 'win32') return Promise.resolve(true)
  const existing = probes.get(pid)
  if (existing) return existing
  const probe = new Promise<boolean>(resolve => {
    execFile('ps', ['-o', 'stat=', '-g', String(pid)], {
      encoding: 'utf8', timeout: 250, maxBuffer: 16_384, windowsHide: true,
    }, (error, stdout) => {
      const states = stdout.trim().split(/\s+/).filter(Boolean)
      resolve(error || states.length === 0 ? true : !states.every(state => state.startsWith('Z')))
    })
  }).finally(() => { probes.delete(pid) })
  probes.set(pid, probe)
  return probe
}
