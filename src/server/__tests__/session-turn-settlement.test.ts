import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

class ControlledAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  readonly prompts: string[] = []
  abortCalls = 0
  private resolveRun?: () => void

  run(prompt: string, callbacks: AgentCallbacks): Promise<void> {
    this.prompts.push(prompt)
    this.callbacks = callbacks
    return new Promise<void>((resolve) => { this.resolveRun = resolve })
  }

  completeFinalTurn(): void {
    this.callbacks!.onTurnComplete({ input_tokens: 1 }, this.prompts.length, true)
  }

  finish(): void {
    const resolve = this.resolveRun
    this.resolveRun = undefined
    resolve?.()
  }

  abort(): void {
    this.abortCalls++
    this.callbacks?.onAbort()
  }

  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_messages: OaiMessage[]): void {}
  rewindToMessages(_messages: OaiMessage[]): void {}
}

function setup(t: import('node:test').TestContext) {
  const agent = new ControlledAgent()
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: '/tmp/session-turn-settlement' })
  t.after(async () => {
    manager.abortAll()
    agent.finish()
    await manager.shutdownAll()
  })
  const session = manager.createSession({ prompt: 'first' })
  assert.deepEqual(agent.prompts, ['first'])
  return { agent, manager, id: session.id }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function isSettled(manager: RuntimeSessionManager, id: string): boolean {
  const session = (manager as unknown as {
    sessions: Map<string, { running: boolean; activeRunSettlement?: unknown }>
  }).sessions.get(id)!
  return !session.running && !session.activeRunSettlement
}

test('healthy final turn settles completed, done, and idle', async (t) => {
  const { agent, manager, id } = setup(t)
  agent.completeFinalTurn()
  agent.finish()
  await waitUntil(() => isSettled(manager, id))

  assert.equal(manager.getSession(id)!.status, 'completed')
  const events = manager.getEvents(id, 0)!.events
  assert.deepEqual(events.filter((event) => event.type === 'done').map((event) => event.data.status), ['completed'])
  assert.equal(isSettled(manager, id), true)
})

test('post-final abort stays truthful and bounded Git unwinding releases queue continuation', async (t) => {
  const { agent, manager, id } = setup(t)
  assert.equal(typeof manager.queue(id, 'queued after final'), 'object')
  agent.completeFinalTurn()

  manager.abort(id)
  manager.abort(id)

  assert.equal(agent.abortCalls, 2, 'repeated abort must reach the non-cooperative unwinding agent')
  assert.equal(manager.getSession(id)!.status, 'aborted')
  assert.equal(isSettled(manager, id), false)
  const abortedEvents = manager.getEvents(id, 0)!.events
  assert.equal(abortedEvents.some((event) => event.type === 'done' && event.data.status === 'completed'), false)
  assert.deepEqual(agent.prompts, ['first'], 'queued work must not start before agent unwinding settles')

  agent.finish()
  assert.equal(await manager.waitForRunSettled(id, 100), true)
  await waitUntil(() => agent.prompts.length === 2)
  assert.equal(
    agent.prompts[1],
    '[排队跟进 — 上轮已被用户打断，以下是打断后的新指示，请以此为准]\nqueued after final',
  )
  const queueEvents = manager.getEvents(id, 0)!.events
  assert.ok(queueEvents.some((event) => event.type === 'queue_status' && event.data.status === 'merged'))

  agent.completeFinalTurn()
  agent.finish()
  await waitUntil(() => isSettled(manager, id))
  assert.equal(manager.getSession(id)!.status, 'completed')
  assert.equal(manager.run(id, 'manual after recovery'), true)
  assert.deepEqual(agent.prompts, ['first', agent.prompts[1]!, 'manual after recovery'])
})

test('mid-run abort retains aborted status and no completed done', async (t) => {
  const { agent, manager, id } = setup(t)
  manager.abort(id)

  assert.equal(agent.abortCalls, 1)
  assert.equal(manager.getSession(id)!.status, 'aborted')
  assert.equal(isSettled(manager, id), false)
  agent.finish()
  await waitUntil(() => isSettled(manager, id))

  assert.equal(manager.getSession(id)!.status, 'aborted')
  const events = manager.getEvents(id, 0)!.events
  assert.equal(events.some((event) => event.type === 'done'), false)
  assert.equal(events.some((event) => event.type === 'status' && event.data.status === 'aborted'), true)
})
