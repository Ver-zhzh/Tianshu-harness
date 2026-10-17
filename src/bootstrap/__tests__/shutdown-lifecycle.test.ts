import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShutdownHandler, type BootstrapContext } from '../../bootstrap.js'
import { SessionContext } from '../../agent/context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { rewindAgentSession } from '../../agent/session-persist-listener.js'

interface ShutdownFixture {
  ctx: BootstrapContext
  unregistered: string[]
}

function makeFixture(workerSettled: boolean, mainRunning = false): ShutdownFixture {
  const unregistered: string[] = []
  const heartbeatInterval = setInterval(() => {}, 60_000)
  const ctx = {
    sessionId: 'tui-main',
    cwd: process.cwd(),
    heartbeatInterval,
    persist: {
      updateMetadata: () => {},
      writeFrozenSnapshot: () => {},
      compactOai: () => {},
    },
    session: { getMessages: () => [] },
    fileHistory: null,
    agent: {
      config: { promptEngine: { exportFrozenSnapshot: () => ({}) } },
      flushStigmergySync: () => {},
      abort: () => {},
      isRunning: () => mainRunning,
    },
    refs: {
      coordinator: { shutdownAndWait: async () => workerSettled },
      sessionRegistry: { unregister: (id: string) => { unregistered.push(id) } },
      lspManager: null,
      mcpManager: null,
    },
  } as unknown as BootstrapContext
  return { ctx, unregistered }
}

test('shutdown unregisters a TUI session after all work has settled', async () => {
  const fixture = makeFixture(true)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, ['tui-main'])
})

test('shutdown keeps the registry row when a worker shutdown times out', async () => {
  const fixture = makeFixture(false)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, [])
})

test('shutdown keeps the registry row while the main turn is still running', async () => {
  const fixture = makeFixture(true, true)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, [])
})

test('TUI shutdown waits for pending rewind before exporting the frozen snapshot', async () => {
  const fixture = makeFixture(true)
  const session = new SessionContext()
  session.addUserMessage('retained')
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const engine = new PromptEngine({ model: 'fixture', maxTokens: 4096,
    staticCtx: { tools: [] }, volatileCtx: { cwd: '/controlled-fixture' } })
  Object.assign(fixture.ctx.agent, {
    session, config: { promptEngine: engine, client: {} }, drainPersistWrites: () => pending,
  })
  Object.assign(fixture.ctx, { session, claimStore: { async flushWrites() {} } })
  let snapshots = 0
  Object.assign(fixture.ctx.persist, {
    queueFrozenSnapshot() { snapshots++ }, async drainFrozenSnapshots() {},
  })
  rewindAgentSession(fixture.ctx.agent, session.getMessages())
  const shutdown = createShutdownHandler(fixture.ctx)()
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(snapshots, 0, 'shutdown cannot export the previous proof before rewind commits')
    assert.deepEqual(fixture.unregistered, [])
  } finally { release() }
  await shutdown
  assert.equal(snapshots, 1)
  assert.deepEqual(fixture.unregistered, ['tui-main'])
})
