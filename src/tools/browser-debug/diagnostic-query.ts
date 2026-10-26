import type { BrowserDebugSession } from './session.js'
import type { DiagnosticQuery } from './log-capture.js'

export function diagnosticQuery(session: BrowserDebugSession, input: Record<string, unknown>): DiagnosticQuery {
  if (input.scope === 'session') return { scope: 'session' }
  const current = session.driver.currentDiagnosticScope?.()
  if (typeof input.navigation_id === 'string') return { scope: 'current', navigationId: input.navigation_id }
  return { scope: 'current', pageId: current?.pageId ?? null, navigationId: current?.navigationId ?? null }
}
export function diagnosticSummary(session: BrowserDebugSession, query: DiagnosticQuery): string {
  const unknownEntries = session.log.getConsole('error').filter(e => !e.navigationId)
  const current = session.driver.currentDiagnosticScope?.()
  const unknownErrors = query.scope === 'current' && current && query.navigationId === current.navigationId
    ? unknownEntries.filter(e => current.committedAt === undefined || e.ts >= current.committedAt).length : 0
  const unknown = query.scope === 'current' && !query.navigationId ? '；当前导航归属未知，不能判断为零错误；历史可用 scope=session 查询' : ''
  const uncertainty = unknownErrors ? `（本次观测 ${unknownErrors} 条归属未知，不能据已归属记录确认无错）`
    : unknownEntries.length ? `（另有历史未知归属 ${unknownEntries.length} 条，未计入当前导航；scope=session 可查）` : ''
  const pending = current?.diagnosticsSettled === false ? '；诊断通道未确认同步，当前记录不完整，不能确认零错误' : ''
  return `诊断范围=${query.scope}; page=${query.pageId ?? 'unknown'}; navigation=${query.navigationId ?? 'unknown'}${unknown}${pending}；会话累计 ${session.log.getNetwork().length} 请求、${session.log.getConsole('error').length} 错误${uncertainty}；容量遗漏 console=${session.log.omittedConsole}, network=${session.log.omittedNetwork}, opening=${session.log.omittedOpening}`
}
