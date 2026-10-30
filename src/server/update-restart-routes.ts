import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
export interface UpdateRestartManager {
  updateRestartActivity(): { sessions: number; tasks: number; failedSessions?: number; pendingEvents?: number }
  prepareUpdateRestart(force: boolean, signal: AbortSignal, opts?: { allowUnsaved?: boolean }): Promise<void>
  cancelUpdateRestart(): void
}
export function buildUpdateRestartRoutes(manager: UpdateRestartManager, apiToken?: string): Record<string, RouteHandler> {
  let preparing = false
  let cancellation: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { cancellation?.abort(); cancellation = undefined; clearTimeout(expiry); manager.cancelUpdateRestart(); preparing = false }
  return {
    'GET /runtime/update-activity': withAuth(() => ({ status: 200, body: manager.updateRestartActivity() }), apiToken),
    'POST /runtime/update-prepare': withAuth(async body => {
      if (preparing) return { status: 409, body: { error: 'UPDATE_PREPARING' } }
      preparing = true
      const controller = new AbortController(); cancellation = controller
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      try {
        const payload = (body as { force?: unknown; allowUnsaved?: unknown } | undefined)
        await manager.prepareUpdateRestart(payload?.force === true, deadline, payload?.allowUnsaved === true ? { allowUnsaved: true } : undefined)
        controller.signal.throwIfAborted()
        // An abandoned client must not leave the runtime permanently frozen.
        expiry = setTimeout(cancel, 120000); expiry.unref()
        return { status: 200, body: { prepared: true } }
      } catch (error) {
        if (cancellation === controller) cancel()
        const code = error instanceof Error && error.message === 'UPDATE_BUSY' ? 'UPDATE_BUSY'
          : error instanceof Error && error.message === 'UPDATE_BUSY_TIMEOUT' ? 'UPDATE_BUSY_TIMEOUT'
          : 'UPDATE_SAVE_FAILED'
        const unavailable = error instanceof Error && error.message === 'UPDATE_PERSISTENCE_UNAVAILABLE'
        // cause 透出真实抛出点（abort 超时 / 写链失败 / flush 超时等）——此前一律
        // 显示「落盘核对失败」，0 失败 0 待保存的误拦因此无法诊断（3.36.x 发版实测）。
        const cause = error instanceof Error ? error.message : String(error)
        return { status: code === 'UPDATE_SAVE_FAILED' ? 503 : 409, body: { error: code, stage: unavailable ? 'runtime_capability' : code === 'UPDATE_SAVE_FAILED' ? 'runtime_save' : 'activity', retryable: !unavailable, cause, ...manager.updateRestartActivity() } }
      }
    }, apiToken),
    'POST /runtime/update-cancel': withAuth(() => { cancel(); return { status: 200, body: { cancelled: true } } }, apiToken),
  }
}
