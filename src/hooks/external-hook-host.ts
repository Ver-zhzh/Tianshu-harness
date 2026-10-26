import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import { loadHooksConfig, runHooksForEvent, type HookContext, type HookResult, type HooksConfig } from './user-hooks-runner.js'
import type { HookProcessHandle } from './hook-process.js'
import { HookCleanupUnconfirmedError, type ExternalHookHostPort, type ExternalHookRuntime,
  type HookRuntimeBinding, type HookExecuteOptions, type HookExecutionHandle, type HookGroupResult,
  type HookCleanupResult, type HookCancelReason, type HookResultMeta } from './external-hook-types.js'

interface Job {
  id: string
  runtimeId: string
  runId: string
  ctx: HookContext
  binding: HookRuntimeBinding
  options: HookExecuteOptions
  key?: string
  config?: HooksConfig
  started: number
  enqueued: number
  deadlineAt: number
  controller: AbortController
  processes: HookProcessHandle[]
  results: HookResult[]
  handle: HookExecutionHandle
  resolveResult: (result: HookGroupResult) => void
  resolveReaped: (result: HookCleanupResult) => void
  resultDone: boolean
  cleanupDone: boolean
  cleanupState?: HookCleanupResult
  running: boolean
  reason?: string
  timer?: ReturnType<typeof setTimeout>
  detach?: () => void
}

export interface ExternalHookHostOptions {
  concurrency?: number
  perDirectoryQueue?: number
  maxQueued?: number
  /** Deterministic cleanup-failure seam; production uses the real script runner. */
  runner?: typeof runHooksForEvent
}

/** A host owns leases until trees are reaped, independently of logical results. */
export class ExternalHookHost implements ExternalHookHostPort {
  private readonly jobs = new Set<Job>()
  private readonly queues = new Map<string, Job[]>()
  private readonly occupied = new Map<string, Job>()
  private readonly runtimes = new Map<string, { runId?: string; closed: boolean; parent?: HookRuntimeBinding['parent'] }>()
  private accepting = true
  private active = 0
  private rejected = 0
  private timeouts = 0

  constructor(private readonly options: ExternalHookHostOptions = {}) {}

  createRuntime(binding: HookRuntimeBinding): ExternalHookRuntime {
    const runtimeId = randomUUID()
    const state = { closed: false, runId: undefined as string | undefined, parent: binding.parent }
    this.runtimes.set(runtimeId, state)
    const key = this.directoryKey(binding.cwd)
    // Observe early failures even before the first event is submitted.
    void key.catch(() => {})
    return {
      runtimeId,
      beginRun: runId => {
        if (state.runId !== runId) for (const job of this.jobs) {
          if (this.belongsTo(job.runtimeId, runtimeId) && (job.runtimeId !== runtimeId || job.runId !== runId)) job.handle.cancel('superseded')
        }
        state.runId = runId
      },
      execute: (ctx, options) => this.submit(runtimeId, binding, key, ctx, options),
      barrier: signal => this.barrier(key, binding.cwd, signal),
      close: async () => {
        state.closed = true
        const owned = [...this.jobs].filter(job => this.belongsTo(job.runtimeId, runtimeId))
        for (const job of owned) job.handle.cancel('owner_closed')
        const reaped = await Promise.all(owned.map(job => job.handle.reaped))
        if (reaped.some(state => state !== 'exited')) throw new HookCleanupUnconfirmedError(binding.cwd)
        this.runtimes.delete(runtimeId)
      },
    }
  }

  private belongsTo(runtimeId: string, ancestor: string): boolean {
    for (let depth = 0; depth < 64; depth++) {
      if (runtimeId === ancestor) return true
      const parent = this.runtimes.get(runtimeId)?.parent
      if (!parent) return false
      runtimeId = parent.runtimeId
    }
    return false
  }

  private ownerCurrent(runtimeId: string, runId: string): boolean {
    for (let depth = 0; depth < 64; depth++) {
      const state = this.runtimes.get(runtimeId)
      if (!state || state.closed || state.runId !== runId) return false
      if (!state.parent) return true
      runtimeId = state.parent.runtimeId; runId = state.parent.runId
    }
    return false
  }

  snapshot() {
    return { queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      running: this.active, cleaning: [...this.occupied.values()].filter(job => job.reason).length,
      quarantined: [...this.occupied.values()].filter(job => job.cleanupDone).length,
      rejected: this.rejected, timeouts: this.timeouts }
  }

  shutdown(): Promise<void> {
    this.accepting = false
    const jobs = [...this.jobs]
    for (const job of jobs) job.handle.cancel('host_shutdown')
    return Promise.all(jobs.map(job => job.handle.reaped)).then(() => undefined)
  }

  forceExit(): void { for (const job of this.jobs) for (const process of job.processes) process.forceExit() }

  private async directoryKey(cwd: string): Promise<string> {
    const path = normalize(await realpath(cwd))
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private async barrier(key: Promise<string>, cwd: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const resource = await key
    const job = this.occupied.get(resource)
    if (job?.reason && await this.abortable(job.handle.reaped, signal) !== 'exited') throw new HookCleanupUnconfirmedError(cwd)
    signal?.throwIfAborted()
  }

  private abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
    })
  }

  private submit(runtimeId: string, binding: HookRuntimeBinding, key: Promise<string>, ctx: HookContext, options: HookExecuteOptions): HookExecutionHandle {
    let resolveResult!: Job['resolveResult'], resolveReaped!: Job['resolveReaped']
    const result = new Promise<HookGroupResult>(resolve => { resolveResult = resolve })
    const reaped = new Promise<HookCleanupResult>(resolve => { resolveReaped = resolve })
    const enqueued = performance.now()
    const budget = options.budgetMs && options.budgetMs > 0 ? options.budgetMs : 10_000
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, enqueued + budget)
    const job: Job = { id: randomUUID(), runtimeId, runId: options.runId,
      ctx: structuredClone({ ...ctx, cwd: binding.cwd, sessionId: binding.sessionId }), binding,
      options: { ...options, plugins: structuredClone((options.plugins ?? binding.getPluginHooks?.() ?? []).slice(0, 129)) },
      enqueued, started: 0, deadlineAt, controller: new AbortController(), processes: [], results: [],
      resolveResult, resolveReaped, resultDone: false, cleanupDone: false, running: false,
      handle: { result, reaped, cancel: reason => this.cancel(job, reason) } }
    this.jobs.add(job)
    const state = this.runtimes.get(runtimeId)
    if (!this.accepting || !state || !this.ownerCurrent(runtimeId, options.runId)) {
      this.cancel(job, this.accepting ? 'owner_closed' : 'host_shutdown')
      return job.handle
    }
    if (this.jobs.size > (this.options.maxQueued ?? 128) + (this.options.concurrency ?? 4)) {
      this.rejected++; this.cancel(job, 'queue_full'); return job.handle
    }
    job.timer = setTimeout(() => this.cancel(job, 'group_timeout'), Math.max(1, deadlineAt - performance.now()))
    const abort = () => this.cancel(job, 'cancelled')
    options.signal?.addEventListener('abort', abort, { once: true })
    job.detach = () => options.signal?.removeEventListener('abort', abort)
    if (options.signal?.aborted) abort()
    void Promise.all([key, loadHooksConfig(binding.cwd, job.controller.signal)]).then(([resource, config]) => {
      job.config = config
      if (job.resultDone || job.controller.signal.aborted) return
      job.key = resource
      const queue = this.queues.get(resource) ?? []
      const total = [...this.queues.values()].reduce((sum, value) => sum + value.length, 0)
      if (queue.length >= (this.options.perDirectoryQueue ?? 16) || total >= (this.options.maxQueued ?? 128)) {
        this.rejected++; this.cancel(job, 'queue_full'); return
      }
      queue.push(job); this.queues.set(resource, queue); this.pump()
    }, () => this.cancel(job, 'directory_unavailable'))
    return job.handle
  }

  private cancel(job: Job, reason: HookCancelReason | string): void {
    if (job.resultDone) return
    job.reason = reason
    if (reason === 'group_timeout') this.timeouts++
    job.controller.abort(reason)
    for (const process of job.processes) process.cancel(reason)
    if (job.key && !job.running) {
      const queue = this.queues.get(job.key)?.filter(item => item !== job)
      if (queue?.length) this.queues.set(job.key, queue)
      else this.queues.delete(job.key)
    }
    queueMicrotask(() => this.finishResult(job))
    if (!job.running || !job.processes.length) this.finishCleanup(job, 'exited')
    else void Promise.all(job.processes.map(process => process.reaped)).then(states =>
      this.finishCleanup(job, states.every(state => state === 'exited') ? 'exited' : 'unknown'))
  }

  private pump(): void {
    if (!this.accepting) return
    for (const [key, queue] of this.queues) {
      if (this.active >= (this.options.concurrency ?? 4)) break
      if (this.occupied.has(key)) continue
      const job = queue.shift()
      if (!queue.length) this.queues.delete(key)
      else { this.queues.delete(key); this.queues.set(key, queue) }
      if (!job || job.resultDone || job.controller.signal.aborted) continue
      job.running = true; job.started = performance.now(); this.active++; this.occupied.set(key, job)
      void this.run(job).catch(() => { this.cancel(job, 'execution_error'); this.finishCleanup(job, 'unknown') })
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      await (this.options.runner ?? runHooksForEvent)(job.binding.cwd, job.ctx, job.options.plugins, {
        config: job.config, signal: job.controller.signal, deadlineAt: job.deadlineAt, results: job.results,
        validatePlugin: plugin => job.binding.getPluginHooks?.().some(current => current.pluginName === plugin.pluginName && current.script === plugin.script && current.event === plugin.event) ?? true,
        onProcess: process => {
          job.processes.push(process)
          if (job.controller.signal.aborted) process.cancel(job.reason)
        },
      })
      const cleanup = await Promise.all(job.processes.map(process => process.reaped))
      const clean = cleanup.every(state => state === 'exited') ? 'exited' : 'unknown'
      if (clean === 'unknown' && !job.reason) job.reason = 'cleanup_unconfirmed'
      this.finishCleanup(job, clean)
      this.finishResult(job)
    } catch (error) {
      if (!job.reason) job.reason = String(error)
      for (const process of job.processes) process.cancel('execution_error')
      const cleanup = await Promise.all(job.processes.map(process => process.reaped))
      this.finishCleanup(job, cleanup.every(state => state === 'exited') ? 'exited' : 'unknown')
      this.finishResult(job)
    }
  }

  private meta(job: Job, result?: HookGroupResult): HookResultMeta {
    return { event: job.ctx.event, turn: job.ctx.turn, toolName: job.ctx.toolName, error: job.ctx.error,
      invocationId: job.id, runtimeId: job.runtimeId, runId: job.runId,
      ...(result ? { status: result.status, reason: result.reason, durationMs: result.durationMs,
        queueWaitMs: result.queueWaitMs, cleanup: result.cleanup } : {}) }
  }

  private finishResult(job: Job): void {
    if (job.resultDone) return
    job.resultDone = true
    clearTimeout(job.timer); job.detach?.()
    const reason = job.reason
    const status = reason === 'group_timeout' ? 'timed_out'
      : reason === 'cancelled' || reason === 'superseded' || reason === 'owner_closed' || reason === 'host_shutdown' ? 'cancelled'
        : reason ? 'skipped' : job.results.some(result => !result.ok) ? 'failed' : 'completed'
    const value: HookGroupResult = { invocationId: job.id, runtimeId: job.runtimeId, runId: job.runId,
      status, reason, results: structuredClone(job.results), durationMs: performance.now() - job.enqueued,
      queueWaitMs: (job.started || performance.now()) - job.enqueued,
      cleanup: job.cleanupState ?? 'pending' }
    job.resolveResult(value)
    try { job.binding.emitResult?.(value.results, this.meta(job, value)) } catch { /* Diagnostic sinks cannot retain leases. */ }
  }

  private finishCleanup(job: Job, state: HookCleanupResult): void {
    if (job.cleanupDone) return
    job.cleanupDone = true
    job.cleanupState = state
    if (state === 'unknown' && !job.reason) job.reason = 'cleanup_unconfirmed'
    job.resolveReaped(state)
    if (job.resultDone) try { job.binding.emitCleanup?.({ ...this.meta(job), cleanup: state }) } catch { /* Diagnostic only. */ }
    if (state === 'exited') {
      this.jobs.delete(job)
      if (job.running && job.key) { this.occupied.delete(job.key); this.active-- }
      this.pump()
    }
  }
}
