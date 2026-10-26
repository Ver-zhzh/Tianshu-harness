import { rejectOnAbort } from '../agent/turn-boundary-abort.js'
import { randomUUID } from 'node:crypto'
import type { HookContext } from './user-hooks-runner.js'
import { HookCleanupUnconfirmedError, type ExternalHookHostPort, type ExternalHookRuntime,
  type HookRuntimeBinding, type HookGroupResult, type HookCleanupResult, type HookExecutionHandle } from './external-hook-types.js'

export interface HookRpcRequest {
  t: 'hook-request'
  id: string
  runtimeId: string
  op: 'register' | 'begin' | 'execute' | 'cancel' | 'barrier' | 'close'
  runId?: string
  parent?: { runtimeId: string; runId: string }
  executionId?: string
  context?: HookContext
  budgetMs?: number
  expiresAt?: number
}
export interface HookRpcResponse {
  t: 'hook-response' | 'hook-reaped'
  id: string
  value?: unknown
  error?: string
  code?: string
}

/** Bound once by the parent to its actual child/session, never to child-supplied cwd. */
export class HookRpcServer {
  private runtimes = new Map<string, ExternalHookRuntime>()
  private executions = new Map<string, HookExecutionHandle>()
  private closed = false
  private retirement?: Promise<boolean>
  constructor(private host: ExternalHookHostPort | undefined, private binding: HookRuntimeBinding,
    private send: (response: HookRpcResponse) => void) {}

  receive(request: HookRpcRequest): void {
    const reply = (value?: unknown, error?: unknown) => {
      try { this.send({ t: 'hook-response', id: request.id, value,
        ...(error ? { error: String(error), code: error instanceof HookCleanupUnconfirmedError ? error.code : undefined } : {}) }) } catch { /* Child disconnected. */ }
    }
    if (this.closed || !this.host || typeof request.id !== 'string' || request.id.length > 128 || typeof request.runtimeId !== 'string' || request.runtimeId.length > 128) {
      reply(undefined, new Error('External hook host unavailable')); return
    }
    try {
      if (request.op === 'register') {
        if (this.runtimes.size >= 64 || this.runtimes.has(request.runtimeId)) throw new Error('Invalid hook runtime registration')
        this.runtimes.set(request.runtimeId, this.host.createRuntime({ ...this.binding,
          parent: request.parent ? { runtimeId: this.runtimes.get(request.parent.runtimeId)?.runtimeId ?? 'invalid', runId: request.parent.runId } : this.binding.parent }))
        reply(); return
      }
      const runtime = this.runtimes.get(request.runtimeId)
      if (!runtime) throw new Error('Unknown hook runtime')
      if (request.op === 'begin') { runtime.beginRun(String(request.runId)); reply(); return }
      if (request.op === 'cancel') { this.executions.get(request.executionId ?? '')?.cancel('cancelled'); reply(); return }
      if (request.op === 'execute') {
        if (!request.context || !['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'].includes(request.context.event) || typeof request.runId !== 'string'
          || Buffer.byteLength(JSON.stringify(request.context)) > 65_536 || this.executions.has(request.id)
          || request.budgetMs !== undefined && (!Number.isFinite(request.budgetMs) || request.budgetMs <= 0)
          || request.expiresAt !== undefined && !Number.isFinite(request.expiresAt)) throw new Error('Invalid hook context or budget')
        const remaining = Math.min(request.budgetMs ?? 10_000, (request.expiresAt ?? Date.now() + 10_000) - Date.now())
        const handle = runtime.execute({ ...request.context, cwd: this.binding.cwd, sessionId: this.binding.sessionId },
          { runId: request.runId, budgetMs: Math.max(1, remaining),
            deadlineAt: performance.now() + Math.max(0, remaining), plugins: this.binding.getPluginHooks?.() ?? [] })
        this.executions.set(request.id, handle)
        void handle.result.then(value => reply(value), error => reply(undefined, error))
        void handle.reaped.then(value => {
          this.executions.delete(request.id)
          try { this.send({ t: 'hook-reaped', id: request.id, value }) } catch { /* Child disconnected. */ }
        })
        return
      }
      const pending = request.op === 'barrier' ? runtime.barrier() : runtime.close()
      void pending.then(() => { if (request.op === 'close') this.runtimes.delete(request.runtimeId); reply() }, error => reply(undefined, error))
    } catch (error) { reply(undefined, error) }
  }

  close(): Promise<boolean> {
    return this.retirement ??= (async () => {
      this.closed = true
      const results = await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()))
      this.runtimes.clear(); this.executions.clear()
      return results.every(result => result.status === 'fulfilled')
    })()
  }

}

/** Transport-independent proxy shared by worker NDJSON and the isolated engine IPC. */
export class HookRpcClient implements ExternalHookHostPort {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private cleanup = new Map<string, (state: HookCleanupResult) => void>()
  private runtimes = new Set<ExternalHookRuntime>()
  private closed = false
  constructor(private send: (request: HookRpcRequest) => void) {}

  receive(response: HookRpcResponse): void {
    if (response.t === 'hook-reaped') {
      this.cleanup.get(response.id)?.(response.value === 'exited' ? 'exited' : 'unknown')
      this.cleanup.delete(response.id); return
    }
    const pending = this.pending.get(response.id)
    this.pending.delete(response.id)
    if (response.error) pending?.reject(response.code === 'HOOK_CLEANUP_UNCONFIRMED'
      ? new HookCleanupUnconfirmedError('remote workspace') : new Error(response.error))
    else pending?.resolve(response.value)
  }

  private call(request: Omit<HookRpcRequest, 'id' | 't'>, id = randomUUID()): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('External hook channel closed'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('External hook channel timed out')) },
        request.op === 'execute' ? Math.max(12_000, (request.budgetMs ?? 10_000) + 2_000) : 12_000)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      try { this.send({ ...request, id, t: 'hook-request' }) }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }

  createRuntime(binding: HookRuntimeBinding): ExternalHookRuntime {
    const runtimeId = randomUUID()
    let ready = this.call({ runtimeId, op: 'register', parent: binding.parent })
    void ready.catch(() => {})
    const runtime: ExternalHookRuntime = {
      runtimeId,
      beginRun: runId => { ready = ready.then(() => this.call({ runtimeId, op: 'begin', runId })); void ready.catch(() => {}) },
      barrier: async signal => {
        signal?.throwIfAborted()
        await rejectOnAbort(ready, signal, 'hook-register')
        await rejectOnAbort(this.call({ runtimeId, op: 'barrier' }), signal, 'hook-barrier')
        signal?.throwIfAborted()
      },
      execute: (context, options) => {
        const id = randomUUID(), invocationId = randomUUID()
        const budget = Math.max(1, Math.min(options.budgetMs && options.budgetMs > 0 ? options.budgetMs : 10_000,
          (options.deadlineAt ?? Infinity) - performance.now()))
        const started = performance.now(), expiresAt = Date.now() + budget
        let logicalDone = false, cancelled: string | undefined
        let resolveResult!: (value: HookGroupResult) => void, resolveReaped!: (state: HookCleanupResult) => void
        const result = new Promise<HookGroupResult>(resolve => { resolveResult = resolve })
        const reaped = new Promise<HookCleanupResult>(resolve => { resolveReaped = resolve })
        this.cleanup.set(id, resolveReaped)
        const finish = (value: HookGroupResult) => {
          if (logicalDone) return
          logicalDone = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
          resolveResult(value)
        }
        const cancel = (reason = 'cancelled') => {
          if (logicalDone) return
          cancelled = reason
          finish({ invocationId, runtimeId, runId: options.runId, status: reason === 'group_timeout' ? 'timed_out' : 'cancelled',
            reason, results: [], durationMs: performance.now() - started, queueWaitMs: 0, cleanup: 'pending' })
          void ready.then(() => this.call({ runtimeId, op: 'cancel', executionId: id })).catch(() => {})
        }
        const abort = () => cancel('cancelled')
        const timer = setTimeout(() => cancel('group_timeout'), budget)
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        void ready.then(async () => {
          if (cancelled) { this.cleanup.delete(id); resolveReaped('exited'); return }
          const pending = this.call({ runtimeId, op: 'execute', runId: options.runId, context,
            budgetMs: Math.max(1, budget - (performance.now() - started)), expiresAt }, id)
          const value = await pending as HookGroupResult
          finish(value)
        }).catch(error => {
          this.cleanup.delete(id); resolveReaped('unknown')
          finish({ invocationId, runtimeId, runId: options.runId, status: 'skipped', reason: String(error),
            results: [], durationMs: performance.now() - started, queueWaitMs: 0, cleanup: 'unknown' })
        })
        return { result, reaped, cancel }
      },
      close: async () => { await ready; await this.call({ runtimeId, op: 'close' }); this.runtimes.delete(runtime) },
    }
    this.runtimes.add(runtime)
    return runtime
  }

  async shutdown(): Promise<void> { await Promise.allSettled([...this.runtimes].map(runtime => runtime.close())); this.disconnect() }
  forceExit(): void { this.disconnect() }
  disconnect(): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('External hook channel disconnected'))
    this.pending.clear()
    for (const finish of this.cleanup.values()) finish('unknown')
    this.cleanup.clear()
  }
}
