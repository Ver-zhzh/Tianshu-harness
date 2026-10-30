import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent, type SessionPersistenceAdapter } from '../session-manager.js'
import { buildUpdateRestartRoutes } from '../update-restart-routes.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t: TestContext) {
  const persistence: SessionPersistenceAdapter = { saveRecord() {}, appendEvent() {}, loadAll: () => [],
    flushThrough: async (_id, seq) => seq, flushAllAsync: async () => {},
    healthSnapshot: () => ({ failedSessions: 0, pendingEvents: 0 }) }
  const manager = new RuntimeSessionManager({ defaultCwd: process.cwd(), createAgent: () => ({} as ManagedAgent), persistence })
  const record = manager.createSession()
  const session = (manager as unknown as { sessions: Map<string, { agent?: ManagedAgent; jobs?: { killAllAsync: () => Promise<void>; list: () => [] } }> }).sessions.get(record.id)!
  t.after(async () => { manager.cancelUpdateRestart(); await manager.shutdownAll() })
  return { manager, persistence, session, record }
}

async function boundedResult(operation: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => ({ state: 'ready' as const }), error => ({ state: 'error' as const, error })),
      new Promise<{ state: 'pending' }>(resolve => { timer = setTimeout(() => resolve({ state: 'pending' }), 200) }),
    ])
  } finally { clearTimeout(timer) }
}

for (const stage of ['agent', 'events', 'all', 'jobs'] as const) {
  for (const allowUnsaved of [false, true]) {
    test(`${stage} ignores abort: deadline is bounded with allowUnsaved=${allowUnsaved}`, async t => {
      const { manager, persistence, session } = fixture(t)
      const pending = deferred(), started = deferred()
      const hang = () => { started.resolve(); return pending.promise }
      if (stage === 'agent') session.agent = { flushPersistence: hang, shutdown: async () => {} } as ManagedAgent
      if (stage === 'events') persistence.flushThrough = async (_id, seq) => { await hang(); return seq }
      if (stage === 'all') persistence.flushAllAsync = hang
      if (stage === 'jobs') session.jobs = { killAllAsync: hang, list: () => [] }
      const controller = new AbortController()
      const operation = manager.prepareUpdateRestart(stage === 'jobs', controller.signal, { allowUnsaved })
      const observed = boundedResult(operation)
      await started.promise
      controller.abort(new DOMException('deadline expired', 'TimeoutError'))
      try {
        const result = await observed
        assert.notEqual(result.state, 'pending', 'deadline must interrupt a non-cooperative promise')
        assert.equal(result.state, allowUnsaved && stage !== 'jobs' ? 'ready' : 'error')
        if (result.state === 'error') assert.match(result.error.message, stage === 'jobs' ? /UPDATE_BUSY_TIMEOUT/ : /deadline expired/)
        assert.equal(manager.isUpdateRestartPreparing(), allowUnsaved && stage !== 'jobs')
      } finally {
        pending.resolve()
        await operation.catch(() => {})
      }
    })
  }
}

test('explicit cancellation interrupts agent persistence and late rejection cannot unlock a new preparation', async t => {
  const { manager, session } = fixture(t)
  const first = deferred(), second = deferred(), started = deferred(), secondStarted = deferred()
  session.agent = { flushPersistence: () => { started.resolve(); return first.promise }, shutdown: async () => {} } as ManagedAgent
  const old = boundedResult(manager.prepareUpdateRestart(false, AbortSignal.timeout(5000), { allowUnsaved: true }))
  await started.promise
  manager.cancelUpdateRestart()
  session.agent.flushPersistence = () => { secondStarted.resolve(); return second.promise }
  const next = manager.prepareUpdateRestart(false, AbortSignal.timeout(5000))
  try {
    const result = await old
    assert.equal(result.state, 'error')
    if (result.state === 'error') assert.equal(result.error.name, 'AbortError')
    await secondStarted.promise
    first.reject(new Error('late write failure'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.isUpdateRestartPreparing(), true)
  } finally {
    first.resolve(); second.resolve()
    await next
  }
})

test('route timeout releases the gate and retry prepares normally', async t => {
  const { manager, session, record } = fixture(t)
  const pending = deferred(), started = deferred()
  session.agent = { flushPersistence: () => { started.resolve(); return pending.promise }, shutdown: async () => {} } as ManagedAgent
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  const routes = buildUpdateRestartRoutes(manager, 'fixture')
  const headers = { authorization: 'Bearer fixture' }
  const first = routes['POST /runtime/update-prepare']!({}, {}, headers)
  await started.promise
  deadline.abort(new DOMException('deadline expired', 'TimeoutError'))
  try {
    let response: Awaited<typeof first> | undefined
    const result = await boundedResult(Promise.resolve(first).then(value => { response = value }))
    assert.equal(result.state, 'ready')
    assert.equal(response?.status, 503)
    assert.equal(manager.isUpdateRestartPreparing(), false)
    session.agent.flushPersistence = async () => {}
    const retryDeadline = new AbortController()
    t.mock.method(AbortSignal, 'timeout', () => retryDeadline.signal)
    assert.equal((await routes['POST /runtime/update-prepare']!({}, {}, headers)).status, 200)
    assert.equal(manager.run(record.id, 'blocked during preparation'), false)
    await routes['POST /runtime/update-cancel']!({}, {}, headers)
    assert.equal(manager.isUpdateRestartPreparing(), false)
  } finally { pending.resolve(); await first; await routes['POST /runtime/update-cancel']!({}, {}, headers) }
})

test('a cancelled route response cannot cancel or acknowledge a newer request', async () => {
  const old = deferred(), next = deferred()
  let calls = 0, cancelled = 0
  const routes = buildUpdateRestartRoutes({ updateRestartActivity: () => ({ sessions: 0, tasks: 0 }),
    prepareUpdateRestart: () => ++calls === 1 ? old.promise : next.promise,
    cancelUpdateRestart: () => { cancelled++ } }, 'fixture')
  const headers = { authorization: 'Bearer fixture' }
  const first = routes['POST /runtime/update-prepare']!({}, {}, headers)
  await routes['POST /runtime/update-cancel']!({}, {}, headers)
  const second = routes['POST /runtime/update-prepare']!({}, {}, headers)
  old.resolve()
  assert.equal((await first).status, 503)
  assert.equal(cancelled, 1)
  assert.equal((await routes['POST /runtime/update-prepare']!({}, {}, headers)).status, 409)
  next.resolve()
  assert.equal((await second).status, 200)
  await routes['POST /runtime/update-cancel']!({}, {}, headers)
})
