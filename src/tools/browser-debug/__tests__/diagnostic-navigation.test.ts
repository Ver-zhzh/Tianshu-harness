import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachPageTracker, buildDriver, type DriverEvents } from '../driver.js'
import { LogCapture, formatNetworkLine, parseNetworkLine } from '../log-capture.js'
import { createBrowserDebugTool } from '../tool.js'
import { closeSession } from '../session.js'
import { diagnosticSummary } from '../diagnostic-query.js'

class Page {
  evaluations: string[] = []
  async evaluate(expression: string) { this.evaluations.push(expression); return undefined }
  listeners = new Map<string, Array<(event: any) => void>>()
  on(key: string, fn: (event: any) => void) { this.listeners.set(key, [...this.listeners.get(key) ?? [], fn]) }
  emit(key: string, event?: any) { for (const fn of this.listeners.get(key) ?? []) fn(event) }
  url() { return 'http://localhost/' }
  isClosed() { return false }
  mainFrame() { return this }
}

test('fallback same-document events keep committed identity and its current network records', async () => {
  const page = new Page(), log = new LogCapture(), context = { pages: () => [page], on: () => {} }
  const events: DriverEvents = { onConsole: () => {}, onRequestStart: (id, method, url, type, headers, body, scope) => { log.startRequest(id, method, url, 0, type, headers, body, scope) }, onResponse: () => {}, onResponseBody: () => {}, onRequestFailed: () => {} }
  const tracker = attachPageTracker(context as any, events, page as any)
  await tracker.ready(page as any)
  page.emit('request', { url: () => '/initial', method: () => 'GET', resourceType: () => 'document', headers: () => ({}), postData: () => null, isNavigationRequest: () => true, frame: () => page, redirectedFrom: () => null })
  page.emit('framenavigated', page)
  const initial = tracker.diagnosticScope()
  assert.ok(initial.navigationId)
  page.emit('framenavigated', page)
  assert.equal(tracker.diagnosticScope().navigationId, initial.navigationId)
  assert.equal(log.getNetwork({ scope: 'current', ...tracker.diagnosticScope() }).length, 1)
})

test('overlapping main requests get distinct attempts; redirects share their own attempt and failures do not leak', async () => {
  const page = new Page(), log = new LogCapture()
  const context = { pages: () => [page], on: () => {} }
  const events: DriverEvents = { onConsole: () => {}, onRequestStart: (id, method, url, type, headers, body, scope) => { log.startRequest(id, method, url, 0, type, headers, body, scope) }, onResponse: () => {}, onResponseBody: () => {}, onRequestFailed: () => {} }
  const tracker = attachPageTracker(context as any, events, page as any)
  await tracker.ready(page as any)
  const request = (url: string) => ({ url: () => url, method: () => 'GET', resourceType: () => 'document', headers: () => ({}), postData: () => null, isNavigationRequest: () => true, frame: () => page, redirectedFrom: () => null, failure: () => ({ errorText: 'cancelled' }) })
  const first = request('/a'), second = request('/b')
  const cancelFirst = tracker.beginNavigation(page as any)
  page.emit('request', first); page.emit('request', second)
  const [a, b] = log.getNetwork()
  assert.notEqual(a?.navigationId, b?.navigationId)
  cancelFirst()
  const redirect = { ...request('/b-redirect'), redirectedFrom: () => second }
  page.emit('request', redirect)
  assert.equal(log.getNetwork()[2]?.navigationId, b?.navigationId)
  page.emit('requestfailed', redirect)
  page.emit('request', request('/c'))
  assert.notEqual(log.getNetwork()[3]?.navigationId, b?.navigationId)
  assert.equal(tracker.diagnosticScope().navigationId, null, 'no document has committed')
})

test('real driver goto/reload/history rejection cancels reservations before the next spontaneous request', async () => {
  for (const action of ['goto', 'reload', 'goBack', 'goForward'] as const) {
    const page = Object.assign(new Page(), {
      goto: async () => { throw new Error('navigation rejected before request') },
      reload: async () => { throw new Error('reload rejected before request') },
      goBack: async () => { throw new Error('back rejected before request') },
      goForward: async () => { throw new Error('forward rejected before request') },
    })
    const log = new LogCapture(), context = { pages: () => [page], on: () => {} }
    const events: DriverEvents = { onConsole: () => {}, onRequestStart: (id, method, url, type, headers, body, scope) => { log.startRequest(id, method, url, 0, type, headers, body, scope) }, onResponse: () => {}, onResponseBody: () => {}, onRequestFailed: () => {} }
    const tracker = attachPageTracker(context as any, events, page as any)
    const driver = buildDriver(tracker.resolvePage, tracker.activePage, context as any, tracker.pageUrls, async () => {}, () => true, tracker)
    const failed = action === 'goto' ? driver.goto('http://localhost/fail') : driver[action]()
    await assert.rejects(failed, /rejected before request/)
    assert.equal(driver.currentDiagnosticScope?.().navigationId, null)
    page.emit('request', { url: () => '/spontaneous', method: () => 'GET', resourceType: () => 'document', headers: () => ({}), postData: () => null, isNavigationRequest: () => true, frame: () => page, redirectedFrom: () => null })
    assert.match(log.getNetwork()[0]!.navigationId!, /:nav-2$/, `${action} must not leave its failed reservation for the next request`)
  }
})

test('unknown historical errors are visible without becoming permanent uncertainty for later navigation', () => {
  const log = new LogCapture()
  log.addConsole('error', 'historical', 100)
  const session = { log, driver: { currentDiagnosticScope: () => ({ pageId: 'p', navigationId: 'n', committedAt: 200 }) } } as any
  const query = { scope: 'current' as const, pageId: 'p', navigationId: 'n' }
  assert.doesNotMatch(diagnosticSummary(session, query), /不能据已归属记录确认无错/)
  assert.match(diagnosticSummary(session, query), /历史未知归属/)
  log.addConsole('error', 'unattributed-current', 201)
  assert.match(diagnosticSummary(session, query), /本次观测 1 条归属未知/)
})

test('real page observer pins requests to committed navigation, switches tabs and isolates rebuilt identities', async () => {
  const log = new LogCapture(), page = new Page(), popup = new Page()
  let added: (p: Page) => void = () => {}
  const pages = [page]
  const handlers = new Map<string, (event: any) => void>()
  const protocol = {
    on: (name: string, fn: any) => { handlers.set(name, fn) }, detach: async () => {},
    send: async (name: string) => name === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId: 'blank', url: 'about:blank' } } } : {},
  }
  const emit = (name: string, event: any) => handlers.get(name)?.(event)
  const context = { pages: () => pages, on: (_: string, fn: any) => { added = fn }, newCDPSession: async () => protocol }
  const events: DriverEvents = {
    onConsole: (level, text, scope) => { log.addConsole(level as any, text, 1, scope) },
    onRequestStart: (id, method, url, type, headers, body, scope) => { log.startRequest(id, method, url, 1, type, headers, body, scope) },
    onResponse: (id, status) => { log.completeRequest(id, status) },
    onRequestFailed: (id, method, url, text) => { log.failRequest(id, method, url, text) }, onResponseBody: () => {},
  }
  const tracker = attachPageTracker(context as any, events, page as any)
  await tracker.ready(page as any)
  assert.equal(await tracker.flushDiagnostics(), true)
  assert.deepEqual(page.evaluations, ['void 0'], 'the real flush must also drain the Playwright page/network receiver')
  const request = (url: string) => ({ url: () => url, method: () => 'GET', resourceType: () => 'document', headers: () => ({}), postData: () => null, isNavigationRequest: () => true, frame: () => page, redirectedFrom: () => null })
  const first = request('/old')
  page.emit('request', first)
  emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'old', url: '/old' } })
  emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'main' } } })
  emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', loaderId: 'child-old', url: '/old-child' } })
  emit('Runtime.executionContextCreated', { context: { id: 3, auxData: { frameId: 'child' } } })
  const old = tracker.diagnosticScope()
  emit('Runtime.consoleAPICalled', { type: 'error', executionContextId: 1, args: [{ value: 'old-nav-error' }] })
  page.emit('request', request('/fixed'))
  page.emit('request', { ...request('/old-fetch'), resourceType: () => 'fetch', isNavigationRequest: () => false })
  emit('Runtime.consoleAPICalled', { type: 'error', executionContextId: 1, args: [{ value: 'old-during-navigation' }] })
  emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'fixed', url: '/fixed' } })
  emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { frameId: 'main' } } })
  emit('Runtime.exceptionThrown', { exceptionDetails: { executionContextId: 1, text: 'late-old-exception' } })
  emit('Runtime.exceptionThrown', { exceptionDetails: { executionContextId: 3, text: 'late-old-child-exception' } })
  const current = tracker.diagnosticScope()
  assert.notEqual(old.navigationId, current.navigationId)
  page.emit('response', { request: () => first, status: () => 500, headers: () => ({}), text: async () => 'old response' })
  assert.equal(log.getConsole('error', { scope: 'current', ...current }).length, 0)
  assert.equal(log.getConsole('error', { scope: 'current', ...old }).length, 4)
  const oldRequest = log.getNetwork({ scope: 'current', ...old })[0]!
  assert.equal(oldRequest.status, 500)
  assert.ok(log.getNetwork({ scope: 'current', ...old }).some(r => r.url === '/old-fetch'))
  assert.ok(!log.getNetwork({ scope: 'current', ...current }).some(r => r.url === '/old-fetch'))
  const parsed = parseNetworkLine(formatNetworkLine(oldRequest))!
  assert.equal(parsed.navigationId, old.navigationId)
  assert.equal(parsed.url, '/old')
  pages.push(popup); added(popup)
  assert.notEqual(tracker.diagnosticScope().pageId, old.pageId)
  tracker.selectPage('page-1')
  assert.equal(tracker.diagnosticScope().navigationId, current.navigationId)
  // Full-document cache restoration has no new request, while SPA changes do not commit a loader.
  emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'old', url: '/old' } })
  const restored = tracker.diagnosticScope()
  assert.notEqual(restored.navigationId, old.navigationId)
  emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 1, args: [{ value: 'restored-current' }] })
  emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 3, args: [{ value: 'restored-child-current' }] })
  assert.equal(log.getConsole('log', { scope: 'current', ...restored })[0]?.text, 'restored-current')
  assert.equal(log.getConsole('log', { scope: 'current', ...restored })[1]?.text, 'restored-child-current')
  // Same-document changes have no new document request, so the scope stays stable.
  page.emit('framenavigated', page)
  assert.equal(tracker.diagnosticScope().navigationId, restored.navigationId)
  const rebuilt = attachPageTracker(context as any, events, page as any)
  rebuilt.beginNavigation(page as any)
  assert.notEqual(rebuilt.diagnosticScope().navigationId, current.navigationId)
})

test('actual tool console/network consumers default to current navigation and keep session history', async () => {
  let nav = 0, events!: DriverEvents
  const scope = () => ({ pageId: 'page', navigationId: `nav-${nav}` })
  const driver = {
    currentDiagnosticScope: scope, isAlive: () => true, currentUrl: () => 'http://localhost/', close: async () => {},
    goto: async () => { nav++; if (nav === 1) events.onConsole('error', 'old-nav-error', scope()); events.onRequestStart(`r${nav}`, 'GET', '/', 'document', undefined, undefined, scope()); events.onResponse(`r${nav}`, 200) },
  }
  const tool = createBrowserDebugTool({ enabled: true, userDataDir: () => '/tmp/navigation-fixture', driverFactory: async opts => { events = opts.events; return driver as any } })
  const call = (input: Record<string, unknown>) => tool.execute({ cwd: '/work', sessionId: 'nav-consumer', toolUseId: 'nav', input })
  try {
    assert.ok(!(await call({ action: 'open', url: 'http://localhost/' })).isError)
    assert.match((await call({ action: 'console', level: 'error' })).content, /old-nav-error/)
    await call({ action: 'navigate', url: 'http://localhost/fixed' })
    const fixed = await call({ action: 'console', level: 'error' })
    assert.doesNotMatch(fixed.content, /old-nav-error/)
    assert.match(fixed.content, /navigation=nav-2/)
    assert.match((await call({ action: 'console', scope: 'session' })).content, /old-nav-error/)
    assert.match((await call({ action: 'console', navigation_id: 'nav-1' })).content, /old-nav-error/)
    const network = await call({ action: 'network' })
    assert.match(network.content, /navigation=nav-2/)
    assert.doesNotMatch(network.content, /navigation=nav-1/)
    const legacy = new LogCapture(); legacy.addConsole('error', 'unknown-origin')
    assert.equal(legacy.getConsole('error', { scope: 'current', navigationId: 'nav-2' }).length, 0)
    assert.equal(legacy.getConsole('error', { scope: 'session' }).length, 1)
  } finally { await closeSession('nav-consumer') }
})

test('diagnostic queries await their owning channel without navigating again and disclose a failed barrier', async () => {
  let events!: DriverEvents, navigations = 0, flushes = 0, settled = true
  const scope = () => ({ pageId: 'p', navigationId: 'n', diagnosticsSettled: settled })
  const tool = createBrowserDebugTool({ enabled: true, userDataDir: () => '/tmp/drain-fixture', driverFactory: async opts => {
    events = opts.events
    return { currentUrl: () => 'http://localhost/', currentDiagnosticScope: scope, isAlive: () => true, close: async () => {},
      goto: async () => { navigations++ }, flushDiagnostics: async () => { flushes++; if (!settled) return false; await new Promise<void>(resolve => setImmediate(resolve)); events.onConsole('error', 'received-before-read', scope()); return true },
    } as any
  } })
  const call = (input: Record<string, unknown>) => tool.execute({ cwd: '/work', sessionId: 'drain-consumer', toolUseId: 'drain', input })
  try {
    await call({ action: 'open', url: 'http://localhost/' })
    assert.match((await call({ action: 'console', level: 'error' })).content, /received-before-read/)
    settled = false
    assert.match((await call({ action: 'console', level: 'error' })).content, /诊断通道未确认同步/)
    assert.equal(flushes, 2)
    assert.equal(navigations, 1)
  } finally { await closeSession('drain-consumer') }
})
