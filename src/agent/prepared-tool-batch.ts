import type { ToolResult } from '../tools/types.js'
import { clampReadConcurrency } from '../config/read-concurrency.js'
export type PreparedExecution = (name: string, input: Record<string, unknown>, run: () => Promise<ToolResult>) => Promise<ToolResult>

/** Prepare in source order, then execute bounded read segments with write barriers.
 * Slots cover the entire call (post-processing and retries included), not just spawn. */
export async function runPreparedToolBatch<T>(
  calls: Array<(gate: PreparedExecution) => Promise<T>>,
  eligible: (name: string, input: Record<string, unknown>) => boolean,
  concurrency: number,
): Promise<T[]> {
  const jobs: Array<{ promise: Promise<T>; start: () => void; safe: boolean }> = []
  let failed = false
  try {
  for (const call of calls) {
    let ready!: () => void, start!: () => void, safe = false, prepared = false
    const readyPromise = new Promise<void>(resolve => { ready = resolve })
    const startPromise = new Promise<void>(resolve => { start = resolve })
    const gate: PreparedExecution = async (name, input, run) => {
      if (!prepared) { prepared = true; safe = eligible(name, input); ready() }
      await startPromise
      if (failed) throw new Error('Prepared batch stopped before dispatch')
      return run()
    }
    const promise = Promise.resolve().then(() => call(gate))
    void promise.then(ready, ready)
    await readyPromise
    jobs.push({ promise, start, safe })
  }
  const results: T[] = []
  const limit = clampReadConcurrency(concurrency)
  for (let i = 0; i < jobs.length;) {
    if (!jobs[i]!.safe) {
      jobs[i]!.start(); results.push(await jobs[i++]!.promise)
    } else {
      const start = i
      while (i < jobs.length && jobs[i]!.safe) i++
      const end = i, values: T[] = new Array(end - start)
      let cursor = start
      await Promise.all(Array.from({ length: Math.min(limit, end - start) }, async () => {
        while (cursor < end) {
          const index = cursor++, job = jobs[index]!
          job.start(); values[index - start] = await job.promise
        }
      }))
      results.push(...values)
    }
  }
  return results
  } catch (error) {
    failed = true
    for (const job of jobs) job.start()
    await Promise.allSettled(jobs.map(job => job.promise))
    throw error
  }
}

export function immutableToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(input)
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  }
  freeze(copy)
  return copy
}
