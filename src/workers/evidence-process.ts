import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { killProcessTreeAsync } from '../tools/process-kill.js'
import { track } from '../tools/process-tracker.js'

export function evidenceProcess(deadline: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const entry = [new URL('./workers/verification-worker.js', import.meta.url), new URL('./verification-worker.ts', import.meta.url)]
    .map(url => fileURLToPath(url)).find(existsSync)
  if (!entry) throw new Error('verification_worker_unavailable')
  const child = track(fork(entry, [], { detached: process.platform !== 'win32', serialization: 'advanced',
    execArgv: entry.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }))
  let sequence = 0, disposed = false
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let stopping: Promise<void> | undefined
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  child.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result)
  })
  const failed = () => { for (const call of pending.values()) call.reject(new Error('verification_worker_unavailable')); pending.clear() }
  child.on('error', failed)
  child.on('close', failed)
  const dispose = () => {
    if (disposed) return
    disposed = true
    signal?.removeEventListener('abort', abort)
    if (child.connected) child.send({ id: ++sequence, operation: 'dispose', args: [] }, () => {})
    const timer = setTimeout(() => void killProcessTreeAsync(child), 1000)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
  }
  const stop = () => stopping ??= (async () => {
    failed()
    dispose()
    const result = await killProcessTreeAsync(child)
    if (result !== 'exited') throw new Error('verification_worker_exit_unconfirmed')
    await closed
  })()
  const abort = () => { void stop().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const call = async (operation: string, args: unknown[]) => {
    signal?.throwIfAborted()
    if (disposed) throw new Error('verification_worker_disposed')
    const remaining = deadline - Date.now()
    if (remaining <= 0) { await stop(); throw new Error('verification_budget_exhausted') }
    const id = ++sequence
    let timer: ReturnType<typeof setTimeout>
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        timer = setTimeout(() => { pending.delete(id); reject(new Error('verification_worker_timeout')); abort() }, Math.min(remaining, operation === 'prepare' ? 10_000 : 5000))
        child.send({ id, operation, args }, error => { if (error) { pending.delete(id); reject(error) } })
      })
    } catch (error) {
      await stop()
      throw error
    } finally { clearTimeout(timer!) }
  }
  return { call, dispose, stop }
}
