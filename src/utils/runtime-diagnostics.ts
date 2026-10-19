import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { randomUUID } from 'node:crypto'

export const RUNTIME_INSTANCE_ID = process.env.RIVET_INSTANCE_ID || randomUUID()

export interface RuntimeDiagnostic {
  kind: 'delivery_stage' | 'loop_stall' | 'evidence'
  at: number
  instanceId: string
  pid: number
  sessionId?: string
  phase?: string
  correlationId?: string
  elapsedMs?: number
  durationMs?: number
}
const recent: RuntimeDiagnostic[] = []
let writes = Promise.resolve()
let queued = 0

export function recordRuntimeDiagnostic(event: Omit<RuntimeDiagnostic, 'at' | 'instanceId' | 'pid'>): void {
  // Only fixed phase names and opaque ids enter this channel; never arguments/output.
  const entry: RuntimeDiagnostic = { kind: event.kind, at: Date.now(), instanceId: RUNTIME_INSTANCE_ID, pid: process.pid,
    ...(event.sessionId ? { sessionId: event.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) } : {}),
    ...(event.phase ? { phase: event.phase.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 80) } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) } : {}),
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) }
  recent.push(entry)
  if (recent.length > 200) recent.shift()
  if (queued >= 200) return
  queued++
  const directory = join(rivetHome(), 'logs'), path = join(directory, 'runtime-events.jsonl')
  writes = writes.then(async () => {
    await mkdir(directory, { recursive: true })
    if (((await stat(path).catch(() => undefined))?.size ?? 0) > 2 * 1024 * 1024) await rename(path, join(directory, 'runtime-events.previous.jsonl'))
    await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
  }).catch(() => {}).finally(() => { queued-- })
}
export const recentRuntimeDiagnostics = (): readonly RuntimeDiagnostic[] => recent.slice(-20)
export const drainRuntimeDiagnostics = (): Promise<void> => writes
