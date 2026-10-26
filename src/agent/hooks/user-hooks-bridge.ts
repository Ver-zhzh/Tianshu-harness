import type { RuntimeHook, RuntimeHookContext, RuntimeHookError, RuntimeToolEvent } from '../runtime-hooks.js'
import type { HookContext, HookEvent, HookResult, PluginHook } from '../../hooks/user-hooks-runner.js'
import { HookCleanupUnconfirmedError, HookGroupTimeoutError, type ExternalHookRuntime,
  type HookResultMeta } from '../../hooks/external-hook-types.js'
export type { HookResultMeta } from '../../hooks/external-hook-types.js'

export interface UserHooksBridgeDeps {
  cwd: string
  sessionId?: string
  getTurn: () => number
  getRunId?: () => string | undefined
  getSignal?: () => AbortSignal | undefined
  runtime?: ExternalHookRuntime
  budgetMs?: number
  emitHookResult?: (results: HookResult[], meta: HookResultMeta) => void
  getPluginHooks?: () => PluginHook[]
}

const missingHostReported = new WeakSet<UserHooksBridgeDeps>()

interface CapturedEvent { context: HookContext; runId?: string; plugins: PluginHook[] }

function capture(deps: UserHooksBridgeDeps, event: HookEvent, ctx?: RuntimeHookContext, tool?: RuntimeToolEvent): CapturedEvent {
  return { runId: ctx?.snapshot.runId ?? deps.getRunId?.(),
    plugins: structuredClone((deps.getPluginHooks?.() ?? []).slice(0, 129)),
    context: { cwd: deps.cwd, sessionId: deps.sessionId, event,
      turn: ctx?.snapshot.turn ?? deps.getTurn(), ...(tool ? { toolName: tool.name, toolResult: tool.success ? 'success' : 'failure' } : {}) } }
}

async function execute(deps: UserHooksBridgeDeps, input: CapturedEvent, ctx?: RuntimeHookContext): Promise<void> {
  if (!deps.runtime || !input.runId) {
    if (!deps.emitHookResult && !missingHostReported.has(deps)) {
      missingHostReported.add(deps)
      console.warn('[user-hooks] host_unavailable: external hooks skipped')
    }
    deps.emitHookResult?.([], { ...input.context, status: 'skipped', reason: 'host_unavailable' })
    return
  }
  const handle = deps.runtime.execute(input.context, { runId: input.runId, plugins: input.plugins,
    signal: ctx?.signal, budgetMs: ctx?.budgetMs ?? deps.budgetMs, deadlineAt: ctx?.deadlineAt })
  const result = await handle.result
  if (result.reason === 'cleanup_unconfirmed' || result.cleanup === 'unknown') throw new HookCleanupUnconfirmedError(deps.cwd)
  if (result.status === 'timed_out') throw new HookGroupTimeoutError()
}

function bridgeHook(deps: UserHooksBridgeDeps, phase: 'preTurn' | 'postTool' | 'postTurn' | 'postSession'): RuntimeHook {
  if (phase === 'postSession') return {
    phase, name: 'user-hooks-postSession',
    capture: ctx => {
      const input = capture(deps, phase, ctx)
      return scoped => execute(deps, input, scoped)
    },
    run: ctx => execute(deps, capture(deps, phase, ctx), ctx),
  }
  if (phase === 'postTool') return {
    phase, name: 'user-hooks-postTool',
    run: (ctx, tool) => execute(deps, capture(deps, phase, ctx, tool), ctx),
  }
  return { phase, name: `user-hooks-${phase}`, run: ctx => execute(deps, capture(deps, phase, ctx), ctx) }
}

/** Registered in the host, never awaited from a failing pipeline invocation. */
export function runOnErrorHooks(deps: UserHooksBridgeDeps, error: string, failure?: RuntimeHookError): Promise<void> {
  if (failure?.late || failure?.signal?.aborted) return Promise.resolve()
  const input = capture(deps, 'onError')
  input.runId = failure?.snapshot?.runId ?? input.runId
  input.context.turn = failure?.snapshot?.turn ?? input.context.turn
  input.context.error = error.slice(0, 16_384)
  const pending = execute(deps, input)
  void pending.catch(problem => console.warn(`[user-hooks:onError] ${String(problem)}`))
  return pending
}

export function createUserHooksBridge(deps: UserHooksBridgeDeps): RuntimeHook[] {
  return ['preTurn', 'postTurn', 'postTool', 'postSession'].map(phase => bridgeHook(deps, phase as 'preTurn' | 'postTool' | 'postTurn' | 'postSession'))
}
