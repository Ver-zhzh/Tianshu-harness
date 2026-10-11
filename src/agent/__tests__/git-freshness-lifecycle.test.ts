import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { getGitChangeRate } from '../git-freshness.js'

function holdProbes(t: import('node:test').TestContext) {
  const children: Array<{ child: EventEmitter; signal?: AbortSignal }> = []
  t.mock.method(childProcess, 'spawn', (_command: string, _args: string[], opts: childProcess.SpawnOptions) => {
    const child = new EventEmitter()
    children.push({ child, signal: opts.signal })
    return child as childProcess.ChildProcess
  })
  syncBuiltinESMExports()
  t.after(() => {
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
