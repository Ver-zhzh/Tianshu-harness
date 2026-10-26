import type { DiagnosticScope } from './log-capture.js'
import type { PwContext, PwPage, PwCDPSession } from './pw-surface.js'

/** CDP realms identify the emitting document, including events queued across navigation. */
export async function observeDocumentDiagnostics(context: PwContext | undefined, page: PwPage, options: {
  commit(loaderId: string, url: string): DiagnosticScope
  console(level: string, text: string, scope: DiagnosticScope): void
  activate(enabled: boolean): void
  bindFlush(flush: () => Promise<boolean>): void
}): Promise<boolean> {
  if (!context?.newCDPSession) return false
  let session: PwCDPSession | undefined, expired = false, active = false
  const frames = new Map<string, { loaderId: string; rootLoaderId: string; scope: DiagnosticScope }>()
  const realms = new Map<number, { frameId: string; loaderId: string; rootLoaderId: string; scope: DiagnosticScope }>()
  const unknown = (): DiagnosticScope => ({ pageId: null, navigationId: null })
  const commitFrame = (frame: { id: string; parentId?: string; loaderId: string; url: string }): void => {
    if (expired || !frame?.id || !frame.loaderId) return
    const scope = frame.parentId ? frames.get(frame.parentId)?.scope ?? unknown() : options.commit(frame.loaderId, frame.url)
    const rootLoaderId = frame.parentId ? frames.get(frame.parentId)?.rootLoaderId ?? '' : frame.loaderId
    frames.set(frame.id, { loaderId: frame.loaderId, rootLoaderId, scope })
    while (frames.size > 256) frames.delete(frames.keys().next().value!)
    // A cached document can reactivate without creating a new execution context.
    for (const realm of realms.values()) if (frame.parentId ? realm.frameId === frame.id && realm.loaderId === frame.loaderId : realm.rootLoaderId === frame.loaderId) realm.scope = scope
  }
  const textOf = (arg: { value?: unknown; unserializableValue?: string; description?: string; type?: string }): string => {
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
    return arg.unserializableValue ?? arg.description ?? arg.type ?? 'undefined'
  }
  const setup = async () => {
    session = await context.newCDPSession(page)
    if (expired) { await session.detach().catch(() => {}); return false }
    session.on('Page.frameNavigated', ((event: any) => commitFrame(event.frame)) as never)
    session.on('Runtime.executionContextCreated', (({ context: realm }: any) => {
      const frameId = realm.auxData?.frameId, frame = frames.get(frameId)
      realms.set(realm.id, { frameId, loaderId: frame?.loaderId ?? '', rootLoaderId: frame?.rootLoaderId ?? '', scope: frame?.scope ?? unknown() })
      while (realms.size > 256) realms.delete(realms.keys().next().value!)
    }) as never)
    session.on('Runtime.consoleAPICalled', ((event: any) => {
      if (!active || expired) return
      options.console(event.type, (event.args ?? []).map(textOf).join(' '), realms.get(event.executionContextId)?.scope ?? unknown())
    }) as never)
    session.on('Runtime.exceptionThrown', ((event: any) => {
      if (!active || expired) return
      const detail = event.exceptionDetails
      options.console('error', detail?.exception?.description ?? detail?.text ?? 'Unknown page exception', realms.get(detail?.executionContextId)?.scope ?? unknown())
    }) as never)
    session.on('Log.entryAdded', (({ entry }: any) => {
      if (active && !expired && entry?.source !== 'javascript') options.console(entry?.level ?? 'error', entry?.text ?? 'Unknown browser diagnostic', unknown())
    }) as never)
    await session.send('Page.enable')
    const tree = await session.send('Page.getFrameTree') as { frameTree?: { frame: any; childFrames?: any[] } }
    if (!tree?.frameTree) throw new Error('Document provenance unavailable')
    const visit = (node: any): void => { if (!frames.has(node.frame?.id)) commitFrame(node.frame); for (const child of node.childFrames ?? []) visit(child) }
    visit(tree.frameTree)
    if (expired) return false
    // The owning session buffers replayed records while its driver is opening.
    active = true; options.activate(true)
    await session.send('Runtime.enable')
    await session.send('Log.enable').catch(() => {})
    if (expired) return false
    options.bindFlush(async () => {
      if (expired || !session) return false
      let flushTimer: ReturnType<typeof setTimeout> | undefined
      try {
        // Playwright owns page/network delivery; the diagnostic CDP session is a separate receiver.
        // Synchronize both with a fixed side-effect-free expression and a read-only Runtime RPC.
        const drain = async () => { await page.evaluate('void 0'); await session!.send('Runtime.getIsolateId'); return true }
        return await Promise.race([drain(), new Promise<boolean>(resolve => { flushTimer = setTimeout(() => resolve(false), 1000) })])
      } catch { return false }
      finally { if (flushTimer) clearTimeout(flushTimer) }
    })
    page.on('close', (() => { expired = true; void session?.detach().catch(() => {}) }) as never)
    return true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([setup(), new Promise<boolean>(resolve => { timer = setTimeout(() => { expired = true; options.activate(false); void session?.detach().catch(() => {}); resolve(false) }, 3000) })])
  } catch { expired = true; options.activate(false); void session?.detach().catch(() => {}); return false }
  finally { if (timer) clearTimeout(timer) }
}
