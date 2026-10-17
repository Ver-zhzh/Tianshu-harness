import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { rewindAgentSession } from '../session-persist-listener.js'

test('TUI run waits for the durable rewind before appending the next human input', async () => {
  const session = new SessionContext()
  session.addUserMessage('retained')
  session.addAssistantBlocks([{ type: 'text', text: 'removed' }])
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const engine = new PromptEngine({ model: 'fixture', maxTokens: 4096,
    staticCtx: { tools: [] }, volatileCtx: { cwd: '/controlled-fixture' } })
  let started = false
  const agent = Object.assign(Object.create(AgentLoop.prototype), {
    session,
    config: { promptEngine: engine, client: {}, toolRegistry: { freezeExternalDefinitions() {} } },
    decisionShifts: { discard() {} }, courseEpisodes: { callbacks: (value: unknown) => value },
    zenController: { currentPhase: 'full' }, emitZenPhaseEvent() {}, zenTurnBoundary() {},
    drainPersistWrites: () => pending, async cancelIdleCompaction() {}, scheduleIdleCompaction() {},
    async _runInner(prompt: string) { started = true; session.addUserMessage(prompt) },
  }) as AgentLoop
  rewindAgentSession(agent, session.getMessages().slice(0, 1))
  const run = agent.run('next input', {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {},
    onTurnComplete() {}, onError() {}, onAbort() {}, async onApprovalRequired() { return false },
  })
  void run.catch(() => {})
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(started, false, 'the runtime must hold input behind the rewind write barrier')
    assert.equal(session.getMessages().length, 1)
  } finally { release() }
  assert.equal(await run, 'completed')
  assert.equal(started, true)
  assert.equal(session.getMessages().length, 2)
  assert.equal(agent.isRunning(), false)
})
