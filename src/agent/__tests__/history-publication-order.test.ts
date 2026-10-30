import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { continuityFixture } from './continuity-projection-fixture.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { SessionPersist } from '../session-persist.js'
import { PromptEngine } from '../../prompt/engine.js'
import { TurnCompletionController } from '../turn-completion.js'
import { sessionFailureFields } from '../../server/session-failure-fields.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

test('a real guarded HTTP request cannot publish its seal before the source transcript is durable', async t => {
  const f = continuityFixture(t), entered = deferred(), release = deferred()
  let released = false
  f.engine.setExecutionSnapshotCommit(async snapshot => {
    assert.equal(released, true, 'durable seal publication must follow the transcript barrier')
    await f.persist.commitFrozenSnapshot(snapshot)
  })
  const append = f.persist.appendOaiWithChecksum.bind(f.persist)
  t.mock.method(f.persist, 'appendOaiWithChecksum', async (message: OaiMessage, options?: { flush?: boolean }) => {
    entered.resolve(); await release.promise; return append(message, options)
  })
  f.agent.session.addUserMessage('Please inspect the project.')
  const request = f.engine.buildOaiRequest(f.agent.session.getMessages())
  const sending = f.client.stream(request, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } })
  try {
    await entered.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.bodies.length, 0, 'the actual HTTP boundary must wait, even without AgentLoop.streamTurn')
    assert.equal(existsSync(f.persist.getFilePath()), false)
    assert.equal(existsSync(f.persist.getFilePath().replace(/\.jsonl$/, '.frozen.json')), false, 'seal must not get ahead of its source')
  } finally { released = true; release.resolve(); await sending }
  assert.equal(f.bodies.length, 1)
  assert.deepEqual(f.persist.loadOai(), f.agent.session.getMessages())
  assert.equal(f.persist.readFrozenSnapshot()!.publishedHistory!.length, 1)
})

test('a cold resume preserves the sealed source and adds unknown tool outcomes only after its published prefix', async t => {
  const f = continuityFixture(t)
  f.agent.session.addUserMessage('Inspect the project.')
  await f.client.stream(f.engine.buildOaiRequest(f.agent.session.getMessages()), {
    onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error },
  })
  f.agent.session.addAssistantBlocks([{ type: 'tool_use', id: 'unfinished', name: 'write_file', input: { file_path: f.target, content: 'new version' } }])
  await f.agent.drainPersistWrites(); await f.persist.drainFrozenSnapshots()
  const original = structuredClone(f.agent.session.getMessages())
  const reopened = new SessionPersist('fixture', f.root)
  assert.deepEqual(reopened.loadOai(), original, 'loading cannot strip a durable tool intent or prepend a system message')
  assert.deepEqual(reopened.getLastInjectedUncertain(), [{ id: 'unfinished', name: 'write_file' }])
  const snapshot = reopened.readFrozenSnapshot()!
  const engine = new PromptEngine({ ...f.config, inheritFrozenFrom: snapshot })
  engine.setHistoryDurabilityBarrier(() => f.agent.drainPersistWrites())
  engine.setExecutionSnapshotCommit(data => f.persist.commitFrozenSnapshot(data))
  f.agent.session.addUserMessage('Continue after checking existing work.')
  const request = engine.buildOaiRequest(f.agent.session.getMessages(), undefined, undefined, {
    onOrphanRepair: messages => f.agent.session.replaceMessages(messages),
  })
  await f.client.stream(request, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } })
  assert.equal(f.bodies.length, 2)
  assert.equal(existsSync(f.target), false, 'resume must not automatically replay an interrupted write')
  assert.deepEqual(f.agent.session.getMessages().slice(0, original.length), original)
  assert.match(String(f.agent.session.getMessages().find(message => message.role === 'tool')?.content), /结果未知/)
  assert.deepEqual(new SessionPersist('fixture', f.root).loadOai(), f.agent.session.getMessages())
})

for (const stage of ['intent', 'result', 'answer'] as const) {
  test(`the real agent cannot advance past a pending durable ${stage}`, async t => {
    const f = continuityFixture(t), entered = deferred(), release = deferred()
    let released = false
    if (stage === 'intent') {
      const execute = f.agent.toolExecution.executeBatch.bind(f.agent.toolExecution)
      t.mock.method(f.agent.toolExecution, 'executeBatch', async (params: Parameters<typeof f.agent.toolExecution.executeBatch>[0]) => {
        assert.equal(released, true, 'tool execution must wait for its durable intent')
        return execute(params)
      })
    }
    if (stage === 'answer') {
      const complete = TurnCompletionController.prototype.complete
      t.mock.method(TurnCompletionController.prototype, 'complete', async function (this: TurnCompletionController, params: Parameters<TurnCompletionController['complete']>[0]) {
        if (params.isFinal) assert.equal(released, true, 'completion cannot acknowledge an undurable answer')
        return complete.call(this, params)
      })
    }
    const append = f.persist.appendOaiWithChecksum.bind(f.persist)
    t.mock.method(f.persist, 'appendOaiWithChecksum', async (message: OaiMessage, options?: { flush?: boolean }) => {
      const selected = stage === 'intent' ? message.role === 'assistant' && !!message.tool_calls?.length
        : stage === 'result' ? message.role === 'tool' : message.role === 'assistant' && !message.tool_calls?.length
      if (selected) { entered.resolve(); await release.promise }
      return append(message, options)
    })
    let completed = false
    const running = f.agent.run('Please write result.txt.', { ...f.callbacks, onTurnComplete(_usage, _turn, final) { if (final) completed = true } })
    try {
      await entered.promise
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(completed, false)
      if (stage === 'intent') {
        assert.equal(f.bodies.length, 1)
        assert.equal(existsSync(f.target), false, 'file side effects require a durable call intent')
      } else if (stage === 'result') {
        assert.equal(existsSync(f.target), true)
        assert.equal(f.bodies.length, 1, 'next model request requires durable prior tool results')
        assert.equal(f.persist.readFrozenSnapshot()!.publishedHistory!.length, 1)
      } else assert.equal(f.bodies.length, 2)
    } finally { released = true; release.resolve(); await running }
    assert.deepEqual(f.errors.map(error => error.message), [])
    assert.equal(readFileSync(f.target, 'utf8'), 'saved once')
    assert.deepEqual(f.persist.loadOai(), f.agent.session.getMessages())
    assert.equal(completed, true)
  })
}

test('a real storage sync failure prevents tool effects and recovers without permanently poisoning the write barrier', async t => {
  const f = continuityFixture(t)
  const writer = (f.persist as unknown as { batchWriter: { syncFileAsync(): Promise<void> } }).batchWriter
  const original = writer.syncFileAsync.bind(writer)
  t.mock.method(writer, 'syncFileAsync', async () => { throw new Error('injected sync outage') })
  try {
    await f.agent.run('Please write result.txt.', f.callbacks)
    assert.equal(f.bodies.length, 1)
    assert.equal(existsSync(f.target), false)
    assert.ok(f.errors.some(error => {
      const fields = sessionFailureFields(error)
      return fields.scope === 'local' && fields.continuity?.kind === 'persistence'
        && fields.guidance?.includes('存储恢复后可重试')
    }), 'a disk outage must be reported as local persistence failure, not provider/network failure')
    assert.equal(f.persist.readFrozenSnapshot()!.publishedHistory!.length, 1)
  } finally {
    writer.syncFileAsync = original
    await f.agent.drainPersistWrites()
  }
  await f.agent.drainPersistWrites()
  assert.deepEqual(f.persist.loadOai(), f.agent.session.getMessages())
})

test('abort releases a run stalled on persistence without allowing a late send or tool execution', async t => {
  const f = continuityFixture(t), entered = deferred(), enteredDrain = deferred(), release = deferred()
  const drain = f.agent.drainPersistWrites.bind(f.agent)
  t.mock.method(f.agent, 'drainPersistWrites', () => { enteredDrain.resolve(); return drain() })
  const append = f.persist.appendOaiWithChecksum.bind(f.persist)
  t.mock.method(f.persist, 'appendOaiWithChecksum', async (message: OaiMessage, options?: { flush?: boolean }) => {
    entered.resolve(); await release.promise; return append(message, options)
  })
  const running = f.agent.run('Please write result.txt.', f.callbacks)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.all([entered.promise, enteredDrain.promise])
    f.agent.abort()
    const state = await Promise.race([running.then(() => 'settled'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('hung'), 1500) })])
    assert.equal(state, 'settled', 'saving must not make user cancellation hang')
    assert.equal(f.bodies.length, 0)
    assert.equal(existsSync(f.target), false)
  } finally { clearTimeout(timer); release.resolve(); await running; await f.agent.drainPersistWrites() }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.bodies.length, 0, 'late disk completion must not resume an aborted HTTP request')
  assert.equal(existsSync(f.target), false)
})
