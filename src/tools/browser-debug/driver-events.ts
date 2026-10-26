import type { DriverEvents } from './driver.js'
import type { DiagnosticScope } from './log-capture.js'
import type { PwContext, PwPage, PwRequest, PwResponse, PwConsoleMessage } from './pw-surface.js'
import { shouldCaptureResponseBody, truncateResponseBody } from './log-capture.js'
import { observeDocumentDiagnostics } from './document-diagnostics.js'

/** Per-page scope; request completion keeps the scope captured at request start. */
export function wirePageEvents(page: PwPage, events: DriverEvents, counter: { seq: number; generation: string }, pageId: string, context?: PwContext) {
  let navigation = 0, pending: string | null = null, protocol = false, loaderId: string | null = null
  let navigationId: string | null = null
  let committedAt: number | undefined
  let diagnosticsSettled = false
  let awaitingRequest = false
  let flushProtocol: () => Promise<boolean> = async () => false
  const scope = (): DiagnosticScope => ({ pageId, navigationId, committedAt, diagnosticsSettled })
  const beginNavigation = () => {
    const token = ++navigation
    pending = `${counter.generation}:${pageId}:nav-${token}`
    awaitingRequest = true
    return () => { if (pending && navigation === token) { pending = null; awaitingRequest = false } }
  }
  const commit = (loader: string, url: string): DiagnosticScope => {
    if (loader === loaderId) return scope()
    loaderId = loader
    if (url === 'about:blank' && navigationId === null && !pending) return scope()
    if (!pending) beginNavigation()
    navigationId = pending; pending = null; awaitingRequest = false; committedAt = Date.now(); diagnosticsSettled = false
    return scope()
  }
  const ids = new WeakMap<PwRequest, string>()
  const attempts = new WeakMap<PwRequest, string | null>()
  const idFor = (request: PwRequest) => {
    let id = ids.get(request)
    if (!id) { id = `${counter.generation}:r${++counter.seq}`; ids.set(request, id) }
    return id
  }
  page.on('console', ((msg: PwConsoleMessage) => { if (!protocol) events.onConsole(msg.type(), msg.text(), { pageId, navigationId: null }) }) as never)
  page.on('pageerror', ((error: Error) => { if (!protocol) events.onConsole('error', error.message, { pageId, navigationId: null }) }) as never)
  page.on('request', ((request: PwRequest) => {
    try {
      let mainNavigation = false, originKnown = true
      try { mainNavigation = !!(request.isNavigationRequest?.() && page.mainFrame && request.frame && request.frame() === page.mainFrame()) } catch { originKnown = false }
      const redirected = request.redirectedFrom?.()
      let attempt = redirected ? attempts.get(redirected) ?? null : null
      if (mainNavigation && !redirected) {
        if (!pending || !awaitingRequest) beginNavigation()
        attempt = pending; awaitingRequest = false
      }
      if (mainNavigation) attempts.set(request, attempt)
      const requestScope = !originKnown ? { pageId, navigationId: null } : mainNavigation ? { pageId, navigationId: attempt } : scope()
      let headers: Record<string, string> | undefined, postData: string | undefined
      try { headers = request.headers(); postData = request.postData() ?? undefined } catch { /* metadata may be unavailable; keep the request fact */ }
      events.onRequestStart(idFor(request), request.method(), request.url(), request.resourceType(), headers, postData, requestScope)
    } catch { /* unavailable origin stays unknown */ }
  }) as never)
  page.on('framenavigated', ((frame: unknown) => {
    if (!protocol && pending && page.mainFrame && frame === page.mainFrame()) { navigationId = pending; pending = null; awaitingRequest = false; committedAt = Date.now() }
  }) as never)
  page.on('response', ((response: PwResponse) => {
    try {
      const request = response.request(), id = idFor(request), resourceType = request.resourceType()
      events.onResponse(id, response.status(), resourceType, response.headers())
      if (shouldCaptureResponseBody(resourceType, response.status())) void response.text().then(text => {
        events.onResponseBody(id, truncateResponseBody(text).body, response.headers()['content-type'])
      }).catch(() => {})
    } catch { /* observer must not interrupt navigation */ }
  }) as never)
  page.on('requestfailed', ((request: PwRequest) => {
    if (attempts.get(request) && attempts.get(request) === pending) { pending = null; awaitingRequest = false }
    try { events.onRequestFailed(idFor(request), request.method(), request.url(), request.failure()?.errorText, request.resourceType()) } catch {}
  }) as never)
  const ready = observeDocumentDiagnostics(context, page, { commit, activate: enabled => { protocol = enabled }, bindFlush: flush => { flushProtocol = flush }, console: (level, text, origin) => events.onConsole(level, text, { pageId, navigationId: origin.navigationId }) })
  const flush = async () => { await ready; diagnosticsSettled = protocol && await flushProtocol(); return diagnosticsSettled }
  return { scope, beginNavigation, ready, flush }
}
