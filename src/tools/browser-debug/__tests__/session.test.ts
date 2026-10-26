import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrCreateSession,
  getSession,
  closeSession,
  __resetSessionForTest,
  __sessionCountForTest,
  DEFAULT_SESSION_KEY,
} from '../session.js'
import type { BrowserDebugDriver, DriverEvents, DriverLaunchOptions } from '../driver.js'

class FakeDriver implements BrowserDebugDriver {
  static instances: FakeDriver[] = []
  readonly key: string
  closed = false
  alive = true
  closeError: Error | null = null
  constructor(key: string, _events: DriverEvents) {
    this.key = key
    FakeDriver.instances.push(this)
  }
  async goto() {}
  async evaluate() { return '' }
  async screenshot() { return Buffer.from('') }
  async snapshot() { return '' }
  async click() {}
  async type() {}
  async press() {}
  async selectOption() { return [] as string[] }
  async hover() {}
  async scroll() {}
  async waitForSelector() {}
  async waitForLoadState() {}
  async reload() {}
  async goBack() { return true }
  async goForward() { return true }
  async cookies() { return [] }
  async storage() { return {} }
  async addCookie() {}
  async clearCookies() {}
  async setStorage() {}
  async clearStorage() {}
  async setViewport() {}
  viewportSize() { return { width: 1280, height: 800 } }
  currentUrl() { return 'about:blank' }
  pageUrls() { return ['about:blank'] }
  async bringToFront() {}
  isAlive() { return this.alive }
  async close() {
    this.closed = true
    if (this.closeError) throw this.closeError
  }
}

test('browser diagnostics emitted during driver opening are buffered and retained once', async () => {
  const key = 'opening-diagnostics'
  try {
    const session = await getOrCreateSession({ sessionKey: key, headless: true, userDataDir: 'opening-fixture', driverFactory: async opts => {
      opts.events.onConsole('error', 'opening-error', { pageId: 'p', navigationId: 'n' })
      opts.events.onRequestStart('opening-r', 'GET', '/early', 'document', undefined, undefined, { pageId: 'p', navigationId: 'n' })
      opts.events.onResponse('opening-r', 200)
      return new FakeDriver(key, opts.events)
    } })
    assert.equal(session.log.getConsole('error').length, 1)
    assert.equal(session.log.getConsole('error')[0]?.navigationId, 'n')
    assert.equal(session.log.getNetwork()[0]?.status, 200)
  } finally { await closeSession(key) }
})

test('sessions are isolated by sessionKey', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  const factory = async (o: DriverLaunchOptions) => new FakeDriver(o.userDataDir, o.events)

  await getOrCreateSession({
    sessionKey: 'sess-a',
    headless: true,
    userDataDir: 'profile-a',
    driverFactory: factory,
  })
  await getOrCreateSession({
    sessionKey: 'sess-b',
    headless: true,
    userDataDir: 'profile-b',
    driverFactory: factory,
  })

  assert.equal(__sessionCountForTest(), 2)
  assert.ok(getSession('sess-a'))
  assert.ok(getSession('sess-b'))
  assert.equal(getSession(DEFAULT_SESSION_KEY), null)

  await closeSession('sess-a')
  assert.equal(__sessionCountForTest(), 1)
  assert.equal(FakeDriver.instances[0]!.closed, true)
  assert.equal(FakeDriver.instances[1]!.closed, false)

  await closeSession('sess-b')
  assert.equal(__sessionCountForTest(), 0)
})

test('closeSession is idempotent for missing key', async () => {
  __resetSessionForTest()
  await closeSession('missing')
  assert.equal(__sessionCountForTest(), 0)
})

test('alive session is reused; dead session is evicted and rebuilt', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  const factory = async (o: DriverLaunchOptions) => new FakeDriver(o.userDataDir, o.events)

  const first = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  const again = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  assert.equal(again, first, '存活会话必须复用，不重建')
  assert.equal(FakeDriver.instances.length, 1)

  const firstDriver = first.driver as FakeDriver
  firstDriver.alive = false
  const rebuilt = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  assert.notEqual(rebuilt, first)
  assert.equal(FakeDriver.instances.length, 2)
  assert.equal(firstDriver.closed, true, '死会话的 driver 必须被尽力关闭')
  assert.equal(getSession('s'), rebuilt)
})

test('rebuild inherits the old LogCapture (death must not erase evidence)', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  const factory = async (o: DriverLaunchOptions) => new FakeDriver(o.userDataDir, o.events)

  const first = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  first.log.addConsole('error', 'before death')
  const firstDriver = first.driver as FakeDriver
  firstDriver.alive = false

  const rebuilt = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  assert.equal(rebuilt.log, first.log, '重建必须继承同一个 LogCapture')
  assert.equal(rebuilt.log.getConsole().length, 1)
  assert.equal(rebuilt.log.getConsole()[0]!.text, 'before death')
})

test('close swallows driver close errors (half-dead browser must still close)', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  const factory = async (o: DriverLaunchOptions) => new FakeDriver(o.userDataDir, o.events)

  const session = await getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  const driver = session.driver as FakeDriver
  driver.closeError = new Error('Target page, context or browser has been closed')

  await closeSession('s')
  assert.equal(__sessionCountForTest(), 0, 'close 失败也必须从 Map 删除')
})

test('closeSession during in-flight open leaves no zombie session', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const factory = async (o: DriverLaunchOptions) => {
    await gate
    return new FakeDriver(o.userDataDir, o.events)
  }

  const opening = getOrCreateSession({ sessionKey: 's', headless: true, userDataDir: 'p', driverFactory: factory })
  await closeSession('s')
  release?.()
  await opening.catch(() => {})

  assert.equal(__sessionCountForTest(), 0, '过期 opening 不得写回 Map')
  assert.equal(FakeDriver.instances.length, 1)
  assert.equal(FakeDriver.instances[0]!.closed, true, '过期会话必须立刻关闭')
})
