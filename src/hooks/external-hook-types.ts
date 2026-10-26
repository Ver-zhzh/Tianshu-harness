import type { HookContext, HookResult, PluginHook } from './user-hooks-runner.js'

export type HookCancelReason = 'cancelled' | 'superseded' | 'owner_closed' | 'host_shutdown' | 'group_timeout'
export type HookCleanupResult = 'exited' | 'unknown'
export type HookStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'skipped'

export interface HookGroupResult {
  invocationId: string
  runtimeId: string
  runId: string
  status: HookStatus
  reason?: string
  results: HookResult[]
  durationMs: number
  queueWaitMs: number
  cleanup: HookCleanupResult | 'pending'
}

export interface HookExecutionHandle {
  result: Promise<HookGroupResult>
  reaped: Promise<HookCleanupResult>
  cancel(reason: HookCancelReason): void
}

export interface HookResultMeta {
  event: HookContext['event']
  turn?: number
  toolName?: string
  error?: string
  invocationId?: string
  runtimeId?: string
  runId?: string
  status?: HookStatus
  reason?: string
  durationMs?: number
  queueWaitMs?: number
  cleanup?: HookCleanupResult | 'pending'
}

export interface HookRuntimeBinding {
  parent?: { runtimeId: string; runId: string }
  cwd: string
  sessionId?: string
  getPluginHooks?: () => PluginHook[]
  emitResult?: (results: HookResult[], meta: HookResultMeta) => void
  emitCleanup?: (meta: HookResultMeta) => void
}

export interface HookExecuteOptions {
  runId: string
  signal?: AbortSignal
  budgetMs?: number
  /** A pipeline-local monotonic deadline; never serialize this over IPC. */
  deadlineAt?: number
  plugins?: PluginHook[]
}

export interface ExternalHookRuntime {
  readonly runtimeId: string
  beginRun(runId: string): void
  execute(ctx: HookContext, options: HookExecuteOptions): HookExecutionHandle
  barrier(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface ExternalHookHostPort {
  createRuntime(binding: HookRuntimeBinding): ExternalHookRuntime
  shutdown(): Promise<void>
  forceExit(): void
}

export class HookCleanupUnconfirmedError extends Error {
  readonly code = 'HOOK_CLEANUP_UNCONFIRMED'
  constructor(cwd: string) { super(`External hook cleanup could not be confirmed for ${cwd}`) }
}

export class HookGroupTimeoutError extends Error {
  readonly code = 'HOOK_GROUP_TIMEOUT'
  constructor() { super('External hook group budget exhausted') }
}
