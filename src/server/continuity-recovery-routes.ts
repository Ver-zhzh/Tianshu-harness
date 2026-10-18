import type { RuntimeSessionManager } from './session-manager.js'
import { withAuth } from './route-auth.js'

export function buildContinuityRecoveryRoutes(manager: RuntimeSessionManager, apiToken?: string) {
  return {
    'GET /sessions/:id/continuity-recovery': withAuth(async (_body, params) => {
      try {
        const plan = await manager.continuityRecovery(params!.id!)
        return plan ? { status: 200, body: plan } : { status: 404, body: { error: 'Session not found' } }
      } catch (error) { return { status: 409, body: { error: (error as Error).message } } }
    }, apiToken),
    'POST /sessions/:id/continuity-recovery': withAuth(async (body, params) => {
      const recoveryId = (body as { recoveryId?: unknown } | undefined)?.recoveryId
      if (typeof recoveryId !== 'string' || !/^[a-f0-9-]{36}$/.test(recoveryId)) return { status: 400, body: { error: 'Invalid recoveryId' } }
      try {
        const plan = await manager.continuityRecovery(params!.id!, recoveryId)
        return plan ? { status: 200, body: plan } : { status: 404, body: { error: 'Session not found' } }
      } catch (error) { return { status: 409, body: { error: (error as Error).message } } }
    }, apiToken),

  }
}
