import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalHookHost } from '../external-hook-host.js'
import { HookRpcClient, HookRpcServer } from '../hook-host-rpc.js'

process.env.RIVET_TRUST_PROJECT = '1'
const posix = { skip: process.platform === 'win32' }
test('remote runtimes use the parent workspace and share its queue', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-rpc-'))
  const host = new ExternalHookHost({ concurrency: 1 })
  let client!: HookRpcClient
  const server = new HookRpcServer(host, { cwd, sessionId: 'bound-session' }, response => queueMicrotask(() => client.receive(response)))
  client = new HookRpcClient(request => queueMicrotask(() => server.receive(request)))
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'hook.sh'), '#!/bin/sh\necho "$RIVET_SESSION_ID"\nsleep 0.1\n')
    await chmod(join(cwd, 'hook.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'hook.sh' }] }))
    const remote = client.createRuntime({ cwd: '/untrusted', sessionId: 'forged' })
    remote.beginRun('one')
    const first = remote.execute({ event: 'preTurn', cwd: '/forged', sessionId: 'forged' }, { runId: 'one' })
    const local = host.createRuntime({ cwd, sessionId: 'local' }); local.beginRun('local')
    const second = local.execute({ event: 'preTurn', cwd }, { runId: 'local' })
    const [a, b] = await Promise.all([first.result, second.result])
    assert.equal(a.results[0]?.output, 'bound-session')
    assert.equal(b.results[0]?.output, 'local')
    assert.ok(a.queueWaitMs >= 50 || b.queueWaitMs >= 50)
    assert.equal(await first.reaped, 'exited')
    await remote.close()
  } finally { await server.close(); client.disconnect(); await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})

test('remote cancellation and transport loss settle all waiters', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-rpc-cancel-'))
  const host = new ExternalHookHost()
  let client!: HookRpcClient
  const server = new HookRpcServer(host, { cwd }, response => queueMicrotask(() => client.receive(response)))
  client = new HookRpcClient(request => queueMicrotask(() => server.receive(request)))
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'hook.sh'), '#!/bin/sh\necho ready >ready\nsleep 5\necho late >late\n')
    await chmod(join(cwd, 'hook.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'postSession', script: 'hook.sh' }] }))
    const runtime = client.createRuntime({ cwd }); runtime.beginRun('one')
    const handle = runtime.execute({ cwd, event: 'postSession' }, { runId: 'one' })
    const deadline = Date.now() + 3_000
    while (!await readFile(join(cwd, 'ready')).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10))
    }
    handle.cancel('cancelled')
    assert.equal((await handle.result).status, 'cancelled')
    assert.equal(await handle.reaped, 'exited')
    client.disconnect()
    await assert.rejects(runtime.barrier(), /closed|disconnected/)
  } finally { await server.close(); client.disconnect(); await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})

test('parent run replacement invalidates nested worker runtimes', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-parent-'))
  const host = new ExternalHookHost()
  try {
    const root = host.createRuntime({ cwd }); root.beginRun('old')
    const worker = host.createRuntime({ cwd, parent: { runtimeId: root.runtimeId, runId: 'old' } }); worker.beginRun('worker')
    root.beginRun('new')
    const late = worker.execute({ cwd, event: 'preTurn' }, { runId: 'worker' })
    assert.equal((await late.result).reason, 'owner_closed')
    assert.equal(await late.reaped, 'exited')
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})
