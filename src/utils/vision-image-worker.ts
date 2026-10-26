import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { VisionImagePreview } from './vision-image-core.js'

let worker: Worker | undefined
let seq = 0
const pending = new Map<number, { finish: (result: VisionImagePreview) => void; dataUrl: string }>()
let idle: ReturnType<typeof setTimeout> | undefined

function stopWorker(): void {
  const old = worker; worker = undefined
  if (idle) clearTimeout(idle)
  idle = undefined
  for (const { finish, dataUrl } of pending.values()) finish({ dataUrl, reason: 'worker-unavailable' })
  void old?.terminate()
}

export function processVisionImage(dataUrl: string, signal?: AbortSignal): Promise<VisionImagePreview> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'))
  if (idle) clearTimeout(idle)
  if (!worker) {
    const dist = new URL('./workers/image-worker.js', import.meta.url)
    const source = new URL('../workers/image-worker.ts', import.meta.url)
    try {
      worker = new Worker(existsSync(fileURLToPath(dist)) ? dist : source, {
        execArgv: [],
      })
      worker.on('message', ({ id, result }) => { if (result && typeof result.dataUrl === 'string') pending.get(id)?.finish(result) })
      const created = worker
      worker.on('error', () => { if (worker === created) stopWorker() })
      worker.on('exit', () => { if (worker === created) stopWorker() })
      worker.unref()
    } catch { return Promise.resolve({ dataUrl, reason: 'worker-unavailable' }) }
  }
  return new Promise((resolve, reject) => {
    const id = ++seq
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id)
      if (!pending.size) { idle = setTimeout(stopWorker, 1000); idle.unref() }
    }
    const finish = (result: VisionImagePreview) => { cleanup(); resolve(result) }
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')); stopWorker() }
    const timer = setTimeout(() => { finish({ dataUrl, reason: 'worker-timeout' }); stopWorker() }, 2000)
    pending.set(id, { finish, dataUrl }); signal?.addEventListener('abort', abort, { once: true })
    worker!.postMessage({ id, dataUrl })
  })
}
