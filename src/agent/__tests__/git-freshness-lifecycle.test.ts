import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { getGitChangeRate } from '../git-freshness.js'

type ProbeChild = EventEmitter & {
  pid?: number
  stdout: EventEmitter
  kill: (signal?: NodeJS.Signals) => boolean
}

function holdProbes(t: import('node:test').TestContext) {
  const children: Array<{ child: ProbeChild; signal?: AbortSignal }> = []
  t.mock.method(childProcess, 'spawn', (_command: string, _args: string[], opts: childProcess.SpawnOptions) => {
    const child = new EventEmitter() as ProbeChild
    child.kill = () => true
    child.stdout = new EventEmitter()
    children.push({ child, signal: opts.signal })
    return child as unknown as childProcess.ChildProcess
  })
  syncBuiltinESMExports()
  t.after(async () => {
    for (const { child } of children) child.emit('close', 0, null)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const { child } of children) child.emit('close', 0, null)
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return children
}

test('pre-aborted Git probe starts no process', async t => {
  const children = holdProbes(t)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await getGitChangeRate(process.cwd(), 5, controller.signal), 0)
  assert.equal(children.length, 0)
})

test('cancelled Git probe waits for close after error and starts no fallback', async t => {
  const children = holdProbes(t)
  const controller = new AbortController()
  let settled = false
  const result = getGitChangeRate(process.cwd(), 5, controller.signal)
  const observed = result.finally(() => { settled = true })
  assert.equal(children.length, 1)
  assert.equal(children[0]!.signal, controller.signal)
  controller.abort()
  children[0]!.child.emit('error', new Error('cancelled'))
  children[0]!.child.emit('exit', null, 'SIGTERM')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'neither error nor exit proves child handles are closed')
  children[0]!.child.emit('close', null, 'SIGTERM')
  assert.equal(await observed, 0)
  assert.equal(children.length, 1, 'cancellation must stop HEAD~N fallback probes')
})

test('spawn failure waits for close before starting fallback', async t => {
  const children = holdProbes(t)
  const result = getGitChangeRate(process.cwd(), 2)
  children[0]!.child.emit('error', new Error('spawn failed'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(children.length, 1)
  children[0]!.child.emit('close', -1, null)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(children.length, 2)
  children[1]!.child.emit('close', 1, null)
  assert.equal(await result, 0)
})

test('cancelling one owner leaves another owner running', async t => {
  const children = holdProbes(t)
  const first = new AbortController()
  const second = new AbortController()
  let secondSettled = false
  const one = getGitChangeRate(process.cwd(), 1, first.signal)
  const two = getGitChangeRate(process.cwd(), 1, second.signal).finally(() => { secondSettled = true })
  first.abort()
  children[0]!.child.emit('close', null, 'SIGTERM')
  assert.equal(await one, 0)
  assert.equal(children[1]!.signal, second.signal)
  assert.equal(second.signal.aborted, false)
  assert.equal(secondSettled, false)
  children[1]!.child.emit('close', 0, null)
  assert.equal(await two, 0)
})

test('normal close preserves chunked stdout', async t => {
  const children = holdProbes(t)
  const result = getGitChangeRate(process.cwd(), 1)
  const first = children[0]!.child
  first.stdout.emit('data', Buffer.from('1'))
  first.stdout.emit('data', Buffer.from('\n'))
  first.emit('close', 0, null)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(children.length, 2)
  const second = children[1]!.child
  second.stdout.emit('data', Buffer.from('a\nb\n'))
  second.emit('close', 0, null)
  assert.equal(await result, 0.5)
})

test('timeout escalates TERM to KILL and settles even when close never arrives', async t => {
  const children = holdProbes(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: NodeJS.Signals[] = []
  t.mock.method(process, 'kill', ((_pid: number, signal: NodeJS.Signals) => {
    signals.push(signal)
    return true
  }) as never)
  let settled = false
  const result = getGitChangeRate(process.cwd(), 1)
  const observed = result.finally(() => { settled = true })
  children[0]!.child.pid = 4242

  t.mock.timers.tick(400)
  assert.deepEqual(signals, ['SIGTERM'])
  t.mock.timers.tick(250)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(settled, false, 'KILL still gets a close grace window')
  t.mock.timers.tick(250)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, true, 'missing close must not leave the probe pending')
  assert.equal(await observed, 0)
})

test('abort settles without close and never starts HEAD~N fallback', async t => {
  const children = holdProbes(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let settled = false
  const result = getGitChangeRate(process.cwd(), 5, controller.signal)
  const observed = result.finally(() => { settled = true })

  controller.abort()
  t.mock.timers.tick(250)
  t.mock.timers.tick(250)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, true, 'abort must settle even if the child ignores TERM and never closes')
  assert.equal(await observed, 0)
  assert.equal(children.length, 1, 'cancellation must not fall through to another HEAD~N probe')
})

test('spawn error without close still settles', async t => {
  const children = holdProbes(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const result = getGitChangeRate(process.cwd(), 1)
  const observed = result.finally(() => { settled = true })

  children[0]!.child.emit('error', new Error('spawn failed without close'))
  t.mock.timers.tick(250)
  t.mock.timers.tick(250)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  assert.equal(await observed, 0)
})

test('exit without close has a bounded stdout drain and does not swallow collected output', async t => {
  const children = holdProbes(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = getGitChangeRate(process.cwd(), 1)
  const first = children[0]!.child
  first.stdout.emit('data', Buffer.from('1\n'))
  first.emit('exit', 0, null)

  t.mock.timers.tick(1_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(children.length, 2, 'the first probe must finish its bounded close wait')
  children[1]!.child.emit('close', 1, null)
  assert.equal(await result, 0)
})
