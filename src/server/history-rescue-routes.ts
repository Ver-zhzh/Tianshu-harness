import { withAuth } from './route-auth.js'
import type { RuntimeSessionManager } from './session-manager.js'

export function buildHistoryRescueRoutes(manager: RuntimeSessionManager, apiToken?: string) {
  return {
    'GET /sessions/:id/history-rescue': withAuth(async (_body, params) => {
      try {
        const rescue = await manager.historyRescue(params!.id!)
        return rescue ? { status: 200, body: rescue } : { status: 404, body: { error: 'Session not found' } }
      } catch (error) { return { status: 409, body: { error: (error as Error).message } } }
    }, apiToken),
    'POST /sessions/:id/history-rescue': withAuth(async (body, params) => {
      const hash = (body as { sourceHash?: unknown } | undefined)?.sourceHash
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return { status: 400, body: { error: 'Preview required' } }
      try {
        const result = await manager.historyRescue(params!.id!, hash)
        return result ? { status: 200, body: result } : { status: 404, body: { error: 'Session not found' } }
      } catch (error) { return { status: 409, body: { error: (error as Error).message } } }
    }, apiToken),
  }
}
