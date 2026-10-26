/** Explicit local smoke test; never run automatically by delivery or the agent runtime. */
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { createBrowserDebugTool } from '../src/tools/browser-debug/tool.js'
import { getSession, closeSession } from '../src/tools/browser-debug/session.js'
import { loadPlaywrightCore } from '../src/tools/net/playwright-driver.js'

const trace: unknown[] = []
const fallback = process.argv.includes('--fallback')
const nativeObserved = { pageConsole: false, pageException: false, cdpConsole: false, cdpException: false, request: false }
const record = (event: unknown) => { if (process.argv.includes('--trace')) trace.push(event) }
{
  const mod = await loadPlaywrightCore() as any, launch = mod.chromium.launchPersistentContext.bind(mod.chromium)
  mod.chromium.launchPersistentContext = async (...args: unknown[]) => {
    const context = await launch(...args), seen = new WeakSet<object>()
    const watch = (page: any) => {
      if (seen.has(page)) return; seen.add(page)
      page.on('console', (msg: any) => { const text = msg.text(); if (text.includes('OLD_DURING_NAV')) nativeObserved.pageConsole = true; record({ at: Date.now(), source: 'page', kind: 'console', text }); release() })
      page.on('pageerror', (error: Error) => { if (error.message.includes('OLD_EXCEPTION_DURING_NAV')) nativeObserved.pageException = true; record({ at: Date.now(), source: 'page', kind: 'exception', text: error.message }); release() })
      page.on('request', (request: any) => { const url = request.url(); if (url.endsWith('/old-fetch')) nativeObserved.request = true; record({ at: Date.now(), source: 'page', kind: 'request', url }); release() })
    }
    for (const page of context.pages()) watch(page); context.on('page', watch)
    const create = context.newCDPSession.bind(context)
    context.newCDPSession = async (page: any) => {
      if (fallback) throw new Error('fixture: diagnostic CDP unavailable')
      const session = await create(page)
      for (const kind of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Runtime.executionContextsCleared', 'Page.frameNavigated']) session.on(kind, (event: any) => {
        const text = event.args?.map((a: any) => a.value ?? a.description).join(' ') ?? event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text
        if (kind === 'Runtime.consoleAPICalled' && text?.includes('OLD_DURING_NAV')) nativeObserved.cdpConsole = true
        if (kind === 'Runtime.exceptionThrown' && text?.includes('OLD_EXCEPTION_DURING_NAV')) nativeObserved.cdpException = true
        record({ at: Date.now(), source: 'cdp', kind, context: event.executionContextId ?? event.exceptionDetails?.executionContextId, text, url: event.frame?.url }); release()
      })
      return session
    }
    return context
  }
}

let slowSeen = false, fetchSeen = false, exceptionSeen = false
let pendingSlow: http.ServerResponse | undefined
const gates: http.ServerResponse[] = []
const release = () => {
  if (slowSeen) for (const gate of gates.splice(0)) gate.end('go')
  // Preconditions concern native producers, never the harness's attribution or query results.
  if (pendingSlow && fetchSeen && exceptionSeen && Object.values(nativeObserved).every(Boolean)) { pendingSlow.end('<html><body>fixed<script>console.log("NEW_READY")</script></body></html>'); pendingSlow = undefined }
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  if (req.url === '/slow') { slowSeen = true; pendingSlow = res; release() }
  else if (req.url === '/arm-gate') { gates.push(res); release() }
  else if (req.url === '/old-fetch' || req.url === '/old-exception-fired') { if (req.url === '/old-fetch') fetchSeen = true; else exceptionSeen = true; res.end('ok'); release() }
  else if (req.url?.startsWith('/mime/')) res.end(`<html><body><script type="${req.url.slice(6)}">const p=1;function p(){}</script></body></html>`)
  else res.end('<html><body>old<script>window.addEventListener("error",()=>{fetch("/old-exception-fired")});window.arm=()=>{fetch("/arm-gate").then(()=>{console.error("OLD_DURING_NAV");fetch("/old-fetch");setTimeout(()=>{throw new Error("OLD_EXCEPTION_DURING_NAV")},0)})}</script></body></html>')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cwd = mkdtempSync(join(tmpdir(), 'browser-provenance-')), sessionId = 'browser-provenance-smoke'
const tool = createBrowserDebugTool({ enabled: true, userDataDir: () => join(cwd, 'profile') })
const call = async (input: Record<string, unknown>) => {
  const result = await tool.execute({ cwd, sessionId, toolUseId: 'smoke', input: { headless: true, ...input } })
  assert.ok(!result.isError, result.content)
  return result
}
try {
  await call({ action: 'open', url: base + '/old' })
  const old = getSession(sessionId)!.driver.currentDiagnosticScope!()
  if (fallback) {
    assert.ok(old.navigationId)
    for (const expression of ['location.hash = "hash-route"', 'history.pushState({}, "", "/spa#push-route")']) {
      await call({ action: 'eval', expression })
      await call({ action: 'eval', expression: 'void 0' })
      assert.equal(getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId, old.navigationId)
      assert.match((await call({ action: 'network' })).content, /\/old/)
    }
    await call({ action: 'eval', expression: 'console.error("FALLBACK_SOURCE_UNKNOWN")' })
    assert.match((await call({ action: 'console', scope: 'session' })).content, /FALLBACK_SOURCE_UNKNOWN/)
    await call({ action: 'navigate', url: base + '/next-document' })
    assert.notEqual(getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId, old.navigationId)
    console.log('PASS: real Playwright fallback retains current navigation/network across hash and pushState; new documents change identity; console provenance remains unknown')
  } else {
  await call({ action: 'eval', expression: 'arm()' })
  await call({ action: 'navigate', url: base + '/slow' })
  const current = await call({ action: 'console', level: 'error' })
  assert.doesNotMatch(current.content, /OLD_DURING_NAV|OLD_EXCEPTION_DURING_NAV/)
  const history = await call({ action: 'console', level: 'error', navigation_id: old.navigationId })
  assert.match(history.content, /OLD_DURING_NAV/)
  assert.match(history.content, /OLD_EXCEPTION_DURING_NAV/)
  assert.match((await call({ action: 'network', navigation_id: old.navigationId })).content, /old-fetch/)
  assert.doesNotMatch((await call({ action: 'network' })).content, /old-fetch/)
  assert.match((await call({ action: 'console', level: 'log' })).content, /NEW_READY/)
  const before = getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId
  await call({ action: 'eval', expression: 'history.pushState({}, "", "#same-document")' })
  assert.equal(getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId, before)
  await call({ action: 'history', go: 'reload' })
  assert.notEqual(getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId, before)
  for (let i = 0; i < 3 && !getSession(sessionId)!.driver.currentUrl().endsWith('/old'); i++) await call({ action: 'history', go: 'back' })
  assert.ok(getSession(sessionId)!.driver.currentUrl().endsWith('/old'))
  assert.notEqual(getSession(sessionId)!.driver.currentDiagnosticScope!().navigationId, old.navigationId)
  assert.doesNotMatch((await call({ action: 'console', level: 'error' })).content, /OLD_DURING_NAV|OLD_EXCEPTION_DURING_NAV/)
  await call({ action: 'eval', expression: 'console.error("NEW_AFTER_BACK")' })
  assert.match((await call({ action: 'console', level: 'error' })).content, /NEW_AFTER_BACK/)
  for (const type of ['application/x-javascript', 'text/javascript1.5']) {
    await call({ action: 'navigate', url: base + '/mime/' + type })
    assert.match((await call({ action: 'console', level: 'error' })).content, /already been declared/)
  }
  console.log('PASS: old console, exception and fetch stay on old document during delayed navigation; current log, SPA, reload, back and legacy JS MIME verified in Chromium; no clear_logs')
  }
} catch (error) {
  const session = getSession(sessionId)
  console.error('local-fixture diagnostics', JSON.stringify({
    slowSeen, fetchSeen, exceptionSeen, nativeObserved, current: session?.driver.currentDiagnosticScope?.(), url: session?.driver.currentUrl(),
    console: session?.log.getConsole(), network: session?.log.getNetwork().map(r => ({ url: r.url, navigationId: r.navigationId, status: r.status, failed: r.failed })),
  }))
  throw error
} finally {
  await closeSession(sessionId)
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (process.argv.includes('--trace')) console.error('local-fixture raw event trace', JSON.stringify(trace))
}
