import { withAuth } from './route-auth.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { RouteHandler } from './index.js'
/** Read-only: querying an unopened session must not assemble an agent. */
export function buildToolSurfaceRoutes(manager: RuntimeSessionManager, apiToken?: string): Record<string, RouteHandler> {
  return { 'GET /sessions/:id/tools': withAuth((_body, params) => {
    if (!manager.getSession(params!.id!)) return { status: 404, body: { error: 'Session not found' } }
    const surface = manager.getToolSurface(params!.id!)
    return { status: 200, body: { initialized: !!surface, ...(surface ? { surface } : {}) } }
  }, apiToken) }
}
