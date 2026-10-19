import { evidenceProcess } from '../workers/evidence-process.js'
import type { TestCompletionCoverage } from './types.js'
import type { CompletionCapture, prepareCompletionCapture } from './test-completion.js'

export interface AsyncCompletionCapture extends Omit<CompletionCapture, 'read'> {
  read(exitCode: number): Promise<TestCompletionCoverage | undefined>
}

/** Legacy synchronous adapters run only in the disposable evidence process. */
export async function prepareCompletionCaptureAsync(command: string, cwd: string,
  shell: Parameters<typeof prepareCompletionCapture>[2] = 'bash', root?: string,
  deadline = Date.now() + 10_000, signal?: AbortSignal): Promise<AsyncCompletionCapture | undefined> {
  signal?.throwIfAborted()
  let worker: ReturnType<typeof evidenceProcess> | undefined
  try {
    worker = evidenceProcess(deadline, signal)
    const prepared = await worker.call('prepare', [command, cwd, shell, root, deadline])
    if (!prepared) { worker.dispose(); return undefined }
    const process = worker
    return { ...prepared, dispose: process.dispose, read: async exit => {
      try { return await process.call('read', [exit]) } catch { return undefined }
    } }
  } catch (error) {
    worker?.dispose()
    signal?.throwIfAborted()
    return { command, env: {}, preparationError: error instanceof Error ? error.message : 'verification_worker_failed', read: async () => undefined, dispose() {} }
  }
}
