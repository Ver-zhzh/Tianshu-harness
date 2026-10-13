import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { stableStringify } from '../api/stable-json.js'
import { LocalWorkerPolicyError } from '../api/continuation-prefix.js'
import { coordinatorSubagentsDir } from './worker-result-store.js'
import { writeWorkerFileAtomic } from './worker-history-store.js'
import type { WorkOrder, WorkerResult } from './work-order.js'

/** IDs, retry budgets and model choices cannot disguise the same failed task. */
export function workerTaskKey(order: WorkOrder): string {
  return createHash('sha256').update(stableStringify({
    objective: order.objective.trim(), profile: order.profile, kind: order.kind,
    scope: { ...order.scope, files: order.scope.files?.slice().sort(), commands: order.scope.commands?.slice().sort() },
  })).digest('hex')
}

export class WorkerTerminalPolicy {
  private readonly failed = new Map<string, WorkerResult>()
  private readonly active = new Set<string>()
  private readonly leases = new Map<string, string>()
  private readonly owned = new Set<string>()
  constructor(private readonly sessionId?: string) {}
  private path(key: string): string | undefined {
    if (!this.sessionId) return undefined
    const owner = createHash('sha256').update(this.sessionId).digest('hex')
    return join(coordinatorSubagentsDir(), 'terminal', owner, `${key}.json`)
  }
  leaseId(order: WorkOrder): string | undefined { return this.leases.get(workerTaskKey(order)) }
  begin(order: WorkOrder, inheritedLease?: string): () => void {
    const key = workerTaskKey(order), path = this.path(key)
    let inherited = false
    if (path && inheritedLease) {
      try { const record = JSON.parse(readFileSync(path, 'utf8')); inherited = record.status === 'started' && record.leaseId === inheritedLease } catch { /* fail closed */ }
    }
    if (this.failed.has(key) || (path && existsSync(path) && !inherited)) {
      // Corrupt records also block: absence of a readable result is not permission to repeat.
      let reason = this.failed.get(key)?.summary
      if (!reason && path) { try { reason = JSON.parse(readFileSync(path, 'utf8')).summary } catch { /* fail closed */ } }
      throw new LocalWorkerPolicyError(`Task is terminal; automatic redispatch and resume are disabled. ${reason ?? 'Prior failure recorded'}`)
    }
    if (this.active.has(key)) throw new LocalWorkerPolicyError('Identical task is already running; duplicate dispatch blocked')
    const leaseId = inherited ? inheritedLease! : randomUUID()
    if (path && !inherited) {
      try {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, JSON.stringify({ version: 1, status: 'started', leaseId, summary: 'Previous dispatch has no successful terminal receipt', savedAt: Date.now() }), { flag: 'wx', mode: 0o600 })
      } catch { throw new LocalWorkerPolicyError('Cannot reserve durable worker task; model request not sent') }
      this.owned.add(key)
    }
    this.leases.set(key, leaseId)
    this.active.add(key)
    return () => { this.active.delete(key); this.leases.delete(key); this.owned.delete(key) }
  }
  finish(order: WorkOrder, results: WorkerResult[]): void {
    const failed = results.find(result => result.status !== 'passed' || result.terminalFailure || result.failureReason)
    const key = workerTaskKey(order), path = this.path(key)
    if (!failed) {
      if (path && this.owned.has(key)) {
        try { unlinkSync(path) } catch { throw new LocalWorkerPolicyError('Successful task lease could not be released; automatic reuse remains blocked') }
      }
      return
    }
    this.failed.set(key, failed)
    if (path) {
      mkdirSync(join(path, '..'), { recursive: true })
      if (!writeWorkerFileAtomic(path, JSON.stringify({ version: 1, status: failed.status, summary: failed.summary, failureReason: failed.failureReason, savedAt: Date.now() }))) {
        throw new LocalWorkerPolicyError('Failed task retained in memory; terminal record could not be persisted')
      }
    }
  }
}
