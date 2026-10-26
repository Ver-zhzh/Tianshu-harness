import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExternalHookHost } from '../external-hook-host.js'
import { startHookProcess } from '../hook-process.js'
import { HookCleanupUnconfirmedError } from '../external-hook-types.js'

process.env.RIVET_TRUST_PROJECT = '1'
const posix = { skip: process.platform === 'win32' }
async function fixture(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-external-hooks-'))
  await mkdir(join(cwd, '.rivet'))
  const script = join(cwd, 'hook with spaces.sh')
  await writeFile(script, `#!/bin/sh\nexec '${process.execPath}' -e ${quote(body)}\n`)
  await chmod(script, 0o755)
  await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script, timeoutMs: 2_000 }] }))
  return { cwd, script, remove: () => rm(cwd, { recursive: true, force: true }) }
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach barrier'); await wait(10) }
}

test('group deadline frees the event loop and cancellation prevents late writes', posix, async () => {
  const f = await fixture(`require('fs').writeFileSync('ready','1');setTimeout(()=>require('fs').writeFileSync('late','1'),700)`)
  const host = new ExternalHookHost()
  try {
    const events: unknown[] = []
    const runtime = host.createRuntime({ cwd: f.cwd, emitResult: (results, meta) => events.push({ results, meta }) })
    runtime.beginRun('one')
    let beats = 0
    const heartbeat = setInterval(() => beats++, 10)
    const handle = runtime.execute({ cwd: f.cwd, event: 'preTurn', turn: 1 }, { runId: 'one', budgetMs: 150 })
    const result = await handle.result
    clearInterval(heartbeat)
    assert.equal(result.status, 'timed_out')
    assert.ok(beats >= 2, `heartbeat stalled (${beats})`)
    assert.equal(await handle.reaped, 'exited')
    await wait(750)
    assert.equal(await readFile(join(f.cwd, 'late')).then(() => true, () => false), false)
    assert.equal(events.length, 1)
    assert.equal(host.snapshot().running, 0)
  } finally { await host.shutdown(); await f.remove() }
})

test('superseding a run reaps its process before the next run crosses the barrier', posix, async () => {
  const f = await fixture(`require('fs').writeFileSync('ready','1');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`)
  const host = new ExternalHookHost()
  try {
    const runtime = host.createRuntime({ cwd: f.cwd })
    runtime.beginRun('old')
    const old = runtime.execute({ cwd: f.cwd, event: 'preTurn', turn: 1 }, { runId: 'old' })
    await until(() => readFile(join(f.cwd, 'ready')).then(() => true, () => false))
    runtime.beginRun('new')
    assert.equal((await old.result).reason, 'superseded')
    assert.equal(host.snapshot().cleaning, 1)
    await runtime.barrier()
    assert.equal(await old.reaped, 'exited')
    assert.equal(host.snapshot().running, 0)
    const stale = runtime.execute({ cwd: f.cwd, event: 'preTurn', turn: 1 }, { runId: 'old' })
    assert.equal((await stale.result).status, 'cancelled')
  } finally { await host.shutdown(); await f.remove() }
})

test('same real directory is serial across runtimes and aliases; other directories progress', posix, async () => {
  const body = `const f=require('fs');f.appendFileSync('order','start\\n');setTimeout(()=>f.appendFileSync('order','end\\n'),120)`
  const a = await fixture(body), b = await fixture(body)
  const alias = `${a.cwd}-alias`
  await symlink(a.cwd, alias)
  const host = new ExternalHookHost({ concurrency: 2 })
  try {
    const runtimes = [a.cwd, alias, b.cwd].map(cwd => host.createRuntime({ cwd }))
    const handles = runtimes.map((runtime, i) => {
      runtime.beginRun(String(i))
      return runtime.execute({ cwd: [a.cwd, alias, b.cwd][i]!, event: 'preTurn' }, { runId: String(i) })
    })
    const results = await Promise.all(handles.map(handle => handle.result))
    assert.ok(results.every(result => result.status === 'completed'), JSON.stringify(results))
    assert.equal(await readFile(join(a.cwd, 'order'), 'utf8'), 'start\nend\nstart\nend\n')
    assert.ok(results[2]!.queueWaitMs < results[1]!.durationMs)
  } finally { await host.shutdown(); await rm(alias); await a.remove(); await b.remove() }
})

test('queue cancellation and shutdown settle every pending request', posix, async () => {
  const f = await fixture('setInterval(()=>{},1000)')
  const host = new ExternalHookHost({ concurrency: 1, perDirectoryQueue: 1 })
  try {
    const runtime = host.createRuntime({ cwd: f.cwd }); runtime.beginRun('one')
    const first = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(async () => host.snapshot().running === 1)
    const second = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    const third = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    assert.equal((await third.result).reason, 'queue_full')
    await host.shutdown()
    assert.equal((await first.result).reason, 'host_shutdown')
    assert.equal((await second.result).reason, 'host_shutdown')
    assert.equal(host.snapshot().running, 0)
  } finally { await host.shutdown(); await f.remove() }
})

test('output is byte bounded and output overflow reaps the child', posix, async () => {
  const handle = startHookProcess({ cmd: process.execPath, args: ['-e', `setInterval(()=>process.stdout.write('你'.repeat(10000)),1)`],
    cwd: tmpdir(), env: process.env, input: '{}', timeoutMs: 1_000, maxOutputBytes: 1_000 })
  const result = await handle.result
  assert.equal(result.reason, 'output_limit')
  assert.ok(Buffer.byteLength(result.output) <= 1_000)
  assert.equal(result.output.includes('\ufffd'), false)
  assert.equal(await handle.reaped, 'exited')
})

test('parent exit does not release a live descendant that closed its pipes', posix, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-tree-'))
  try {
    const descendant = `setTimeout(()=>require('fs').writeFileSync('late','1'),500)`
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`
    const handle = startHookProcess({ cmd: process.execPath, args: ['-e', parent], cwd, env: process.env, input: '{}', timeoutMs: 1_000 })
    assert.equal((await handle.result).reason, 'background_process_left')
    assert.equal(await handle.reaped, 'exited')
    await wait(600)
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('unknown cleanup retains both leases, blocks the directory and leaves other directories usable', async () => {
  const a = await fixture(''), b = await fixture('')
  let reportUnknown!: () => void
  const pending = new Promise<'unknown'>(resolve => { reportUnknown = () => resolve('unknown') })
  const host = new ExternalHookHost({ concurrency: 2, runner: async (cwd, _ctx, _plugins, options) => {
    if (cwd !== a.cwd) return []
    options?.onProcess?.({ result: Promise.resolve({ status: 'cancelled', output: '', truncated: false, durationMs: 0, cleanup: 'pending' }),
      reaped: pending, cancel() {}, forceExit() {} })
    await pending
    return []
  } })
  try {
    const first = host.createRuntime({ cwd: a.cwd }); first.beginRun('one')
    const execution = first.execute({ cwd: a.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(async () => host.snapshot().running === 1)
    // Ensure the controlled runner owns the process before cancelling it.
    await wait(10)
    first.beginRun('two')
    assert.equal((await execution.result).reason, 'superseded')
    reportUnknown()
    assert.equal(await execution.reaped, 'unknown')
    await assert.rejects(first.barrier(), HookCleanupUnconfirmedError)
    await assert.rejects(first.close(), HookCleanupUnconfirmedError)
    assert.equal(host.snapshot().running, 1)
    assert.equal(host.snapshot().quarantined, 1)
    const other = host.createRuntime({ cwd: b.cwd }); other.beginRun('other')
    assert.equal((await other.execute({ cwd: b.cwd, event: 'preTurn' }, { runId: 'other' }).result).status, 'completed')
  } finally { reportUnknown(); await host.shutdown(); await a.remove(); await b.remove() }
})

test('queued group budget includes queue time and never launches expired scripts', posix, async () => {
  const f = await fixture(`require('fs').appendFileSync('calls','x');setTimeout(()=>{},400)`)
  const host = new ExternalHookHost()
  try {
    const runtime = host.createRuntime({ cwd: f.cwd }); runtime.beginRun('one')
    const first = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(() => readFile(join(f.cwd, 'calls')).then(() => true, () => false))
    const queued = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one', budgetMs: 30 })
    assert.equal((await queued.result).status, 'timed_out')
    assert.equal(await queued.reaped, 'exited')
    assert.equal((await first.result).status, 'completed')
    assert.equal(await readFile(join(f.cwd, 'calls'), 'utf8'), 'x')
  } finally { await host.shutdown(); await f.remove() }
})

test('submitted groups retain their configuration snapshot while later groups use saved edits', posix, async () => {
  const f = await fixture(`require('fs').appendFileSync('calls','x');setTimeout(()=>{},180)`)
  const host = new ExternalHookHost()
  try {
    const runtime = host.createRuntime({ cwd: f.cwd }); runtime.beginRun('one')
    const first = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(() => readFile(join(f.cwd, 'calls')).then(() => true, () => false))
    const second = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(async () => host.snapshot().queued === 1)
    await writeFile(join(f.cwd, '.rivet/hooks.json'), '{"hooks":[]}')
    assert.ok((await Promise.all([first.result, second.result])).every(result => result.status === 'completed'))
    const third = await runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' }).result
    assert.equal(third.results.length, 0)
    assert.equal(await readFile(join(f.cwd, 'calls'), 'utf8'), 'xx')
  } finally { await host.shutdown(); await f.remove() }
})

test('plugin disable is rechecked when a captured queued script reaches execution', posix, async () => {
  const f = await fixture(`require('fs').appendFileSync('calls','x');setTimeout(()=>{},180)`)
  await writeFile(join(f.cwd, '.rivet/hooks.json'), '{"hooks":[]}')
  const host = new ExternalHookHost()
  let enabled = true
  try {
    const runtime = host.createRuntime({ cwd: f.cwd, getPluginHooks: () => enabled ? [{ pluginName: 'fixture', event: 'preTurn', script: f.script }] : [] })
    runtime.beginRun('one')
    const first = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(() => readFile(join(f.cwd, 'calls')).then(() => true, () => false))
    const second = runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' })
    await until(async () => host.snapshot().queued === 1)
    enabled = false
    await first.result
    assert.equal((await second.result).results[0]?.reason, 'authorization_revoked')
    assert.equal(await readFile(join(f.cwd, 'calls'), 'utf8'), 'x')
  } finally { await host.shutdown(); await f.remove() }
})

test('oversized merged plugin lists report a skipped diagnostic instead of false completion', posix, async () => {
  const f = await fixture(`require('fs').writeFileSync('wrong','1')`)
  await writeFile(join(f.cwd, '.rivet/hooks.json'), '{"hooks":[]}')
  const host = new ExternalHookHost()
  try {
    const runtime = host.createRuntime({ cwd: f.cwd, getPluginHooks: () => Array.from({ length: 129 }, () => ({ pluginName: 'fixture', event: 'preTurn', script: f.script })) })
    runtime.beginRun('one')
    const result = await runtime.execute({ cwd: f.cwd, event: 'preTurn' }, { runId: 'one' }).result
    assert.notEqual(result.status, 'completed')
    assert.equal(result.results[0]?.reason, 'config_limit')
    assert.equal(await readFile(join(f.cwd, 'wrong')).then(() => true, () => false), false)
  } finally { await host.shutdown(); await f.remove() }
})
