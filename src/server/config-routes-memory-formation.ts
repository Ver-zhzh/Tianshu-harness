import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { getMemoryFormationConfig, setMemoryFormationConfig } from '../config/memory-formation.js'

export function buildMemoryFormationRoutes(apiToken?: string): Record<string, RouteHandler> {
  const authorized = (handler: RouteHandler): RouteHandler => async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) return { status: 401, body: { error: 'Unauthorized' } }
    return handler(body, params, headers, res)
  }
  return {
    'GET /config/memory-formation': authorized(() => ({ status: 200, body: getMemoryFormationConfig() })),
    'PUT /config/memory-formation': authorized(body => {
      try { return { status: 200, body: { ok: true, ...setMemoryFormationConfig(body) } } }
      catch (error) {
        return { status: error instanceof TypeError ? 400 : 500, body: { error: error instanceof TypeError ? error.message : 'Failed to save memory formation settings' } }
      }
    }),
  }
}
