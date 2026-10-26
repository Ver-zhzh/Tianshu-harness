import { withAuth } from './route-auth.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { RouteHandler } from './index.js'
import { listFactHandoffs, readFactHandoff } from '../agent/fact-handoff.js'
export function buildHandoffRoutes(manager: RuntimeSessionManager, apiToken?: string): Record<string, RouteHandler> {
  return {
    'POST /sessions/:id/handoff': withAuth((body, params) => {
      const data = (body ?? {}) as { note?: unknown; narrative?: unknown }
      const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : undefined
      const result = manager.requestHandoff(params!.id!, note, { narrative: data.narrative === true })
      if (!result.ok) return { status: result.error === 'Session not found' ? 404 : 409, body: { error: result.error } }
      // 归档与叙述分开披露：narrative=skipped 表示事实快照已成功、模型叙述未启动。
      const record = manager.getSession(params!.id!)
      return { status: 200, body: { ...(record ?? {}), handoff: { archived: result.archived, snapshotId: result.snapshotId, narrative: result.narrative ?? 'none', ...(result.reason ? { reason: result.reason } : {}) } } }
    }, apiToken),
    'GET /sessions/:id/handoffs': withAuth((_body, params) => {
      const target = manager.getSession(params!.id!)
      if (!target) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { items: listFactHandoffs(target.cwd) } }
    }, apiToken),
    'GET /sessions/:id/handoffs/:source': withAuth((_body, params) => {
      const target = manager.getSession(params!.id!)
      if (!target) return { status: 404, body: { error: 'Session not found' } }
      try {
        const snapshot = readFactHandoff(target.cwd, params!.source!, params?.snapshot)
        return { status: 200, body: { sessionId: snapshot.sessionId, snapshotId: snapshot.snapshotId, createdAt: snapshot.createdAt,
          brief: snapshot.brief, sections: Object.keys(snapshot.sections) } }
      } catch (error) { return { status: 404, body: { error: String(error) } } }
    }, apiToken),
  }
}
