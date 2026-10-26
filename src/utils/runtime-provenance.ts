import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { RUNTIME_INSTANCE_ID } from './runtime-diagnostics.js'

declare const __RIVET_BUILD_STAMP__: string | undefined

export interface RuntimeProvenance {
  buildId: string
  sourceRevision: string
  version: string
  /** Hash of the executing bundled module, not the entire installation. */
  moduleSha256: string
  executionContract: 2
}

function captureBuild(): Readonly<RuntimeProvenance> {
  const unknown = { buildId: 'unknown', sourceRevision: 'unknown', version: 'unknown', moduleSha256: 'unknown', executionContract: 2 as const }
  if (typeof __RIVET_BUILD_STAMP__ === 'undefined') return Object.freeze(unknown)
  try {
    const stamp = JSON.parse(__RIVET_BUILD_STAMP__) as { id: string; revision: string; version: string }
    if (!stamp.id || !stamp.revision || !stamp.version) return Object.freeze(unknown)
    const bytes = readFileSync(fileURLToPath(import.meta.url))
    // A rebuild may replace disk before an older module initializes.
    if (!bytes.includes(Buffer.from(stamp.id))) return Object.freeze(unknown)
    return Object.freeze({ buildId: stamp.id, sourceRevision: stamp.revision, version: stamp.version,
      moduleSha256: createHash('sha256').update(bytes).digest('hex'), executionContract: 2 })
  } catch { return Object.freeze(unknown) }
}

/** Captured once; current Git state and environment labels cannot relabel a process. */
export const RUNTIME_PROVENANCE = captureBuild()
export interface RuntimeRunIdentity { runId: string; sessionId?: string }
type RunObservation = RuntimeRunIdentity & { requestId?: string; attemptId?: string }
const runs = new AsyncLocalStorage<RunObservation>()
export const currentRuntimeRun = (): RunObservation | undefined => runs.getStore()
export function withRuntimeRun<T>(identity: RuntimeRunIdentity, operation: () => T): T {
  return runs.run({ ...identity }, operation)
}
/** Only primary attempts own the following tool batch; probes cannot steal it. */
export function recordRuntimeRequest(context: { sessionId?: string; requestId?: string; purpose?: string }, attemptId: string): void {
  const run = runs.getStore()
  if (!run || context.sessionId !== run.sessionId || !context.requestId
    || !['main_execution', 'worker_execution'].includes(context.purpose ?? '')) return
  run.requestId = context.requestId
  run.attemptId = attemptId
}
export function runtimeObservation() {
  return { runtime: RUNTIME_PROVENANCE, instanceId: RUNTIME_INSTANCE_ID, ...currentRuntimeRun() }
}
