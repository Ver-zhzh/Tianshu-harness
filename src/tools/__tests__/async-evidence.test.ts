import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { fixture, available } from './framework-fixture.js'
import { prepareCompletionCaptureAsync } from '../test-completion-async.js'
import { evidenceProcess } from '../../workers/evidence-process.js'
import { SessionJobs, type JobEvent } from '../job-store.js'
import { join } from 'node:path'
import { BASH_TOOL } from '../bash.js'

test('bash preparation consumes the caller budget and blocks before execution', async () => {
  const f = fixture('node-test')
  try {
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'preparation-budget', input: { command: 'node -e "process.exit(0)"', timeout: 1 } })
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.equal(result.errorKind, 'timeout')
    assert.equal(result.verification?.status, 'blocked')
    assert.match(result.content, /未启动命令/)
  } finally { f.dispose() }
})

test('slow native configuration discovery runs outside the service event loop', { skip: !available('vitest') }, async () => {
  const f = fixture('vitest')
  let capture: Awaited<ReturnType<typeof prepareCompletionCaptureAsync>>, ticks = 0
  f.write('vitest.config.mjs', 'const until=Date.now()+1200;while(Date.now()<until){};export default {test:{}};')
  const timer = setInterval(() => { ticks++ }, 20)
  try {
    capture = await prepareCompletionCaptureAsync('npm test', f.cwd, 'bash', undefined, Date.now() + 20_000)
    assert.ok(capture); assert.equal(capture.preparationError, undefined)
    assert.ok(ticks >= 20, `configuration discovery blocked the service loop (${ticks} ticks)`)
  } finally { clearInterval(timer); capture?.dispose(); f.dispose() }
})

test('isolated evidence process preserves real Node per-file receipts', async () => {
  const f = fixture('node-test')
  let capture: Awaited<ReturnType<typeof prepareCompletionCaptureAsync>>
  try {
    capture = await prepareCompletionCaptureAsync('node --test a.test.mjs', f.cwd, 'bash', undefined, Date.now() + 20_000)
    assert.ok(capture)
    assert.equal(capture.preparationError, undefined)
    await promisify(exec)(capture.command, { cwd: f.cwd, env: { ...process.env, ...capture.env } })
    const proof = await capture.read(0)
    assert.equal(proof?.complete, true, JSON.stringify(proof))
    assert.equal(proof?.files[0]?.path, 'a.test.mjs')
    assert.equal(proof?.files[0]?.outcome, 'passed')
  } finally { capture?.dispose(); f.dispose() }
})

test('expired, cancelled and crashed evidence processes cannot fall back to inline proof', async () => {
  const f = fixture('node-test')
  try {
    const expired = await prepareCompletionCaptureAsync('node --test a.test.mjs', f.cwd, 'bash', undefined, Date.now() - 1)
    assert.match(expired?.preparationError ?? '', /budget/)
    assert.equal(await expired?.read(0), undefined)
    const controller = new AbortController()
    const worker = evidenceProcess(Date.now() + 20_000, controller.signal)
    controller.abort()
    await assert.rejects(worker.call('prepare', []))
    await worker.stop()
    const broken = evidenceProcess(Date.now() + 20_000)
    await assert.rejects(broken.call('unsupported', []), /worker_failed/)
    await assert.rejects(broken.call('read', [0]), /disposed/)
  } finally { f.dispose() }
})

test('background await and exit publication wait for asynchronous completion evidence exactly once', async () => {
  const f = fixture('node-test'), jobs = new SessionJobs(join(f.cwd, 'jobs'))
  let finish!: () => void, started!: () => void, calls = 0, published = false
  const began = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  jobs.on('event', (event: JobEvent) => { if (event.kind === 'exit') published = true })
  try {
    const job = jobs.spawn({ command: 'echo done', rawCommand: 'echo done', cwd: f.cwd, env: process.env,
      onCompleted: async () => { calls++; started(); await gate } })
    await began
    let resolved = false
    const awaiting = jobs.await(job.id, {}).then(() => { resolved = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(resolved, false); assert.equal(published, false)
    finish(); await awaiting
    assert.equal(published, true); assert.equal(calls, 1)
  } finally { finish?.(); await jobs.killAllAsync(); f.dispose() }
})
