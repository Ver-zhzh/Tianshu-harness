import { test } from 'node:test'
import assert from 'node:assert/strict'
import { continuityFixture } from './continuity-projection-fixture.js'
import { PromptEngine } from '../../prompt/engine.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { proveRewindHistory, ContinuationPrefixError, continuityFailureDetails } from '../../api/continuation-prefix.js'
import { previewContinuityRecovery, applyContinuityRecovery } from '../continuity-recovery.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'

for (const size of [50, 70, 150_000]) test(`wire normalization preserves frozen injected memory through tools and repeated inputs (${size})`, async t => {
  const f = continuityFixture(t)
  const memory = 'External summary: ' + 'e\u0301'.repeat(Math.min(size, 70)) + 'x'.repeat(size)
  const callbacks = { ...f.callbacks, onToolResult() { f.callbacks.onToolResult(); f.agent.updateSessionMemory(memory) } }
  f.agent.updateSessionMemory(memory)
  await f.agent.run('Please write result.txt.', callbacks)
  assert.deepEqual(f.errors.map(error => error.message), [])
  assert.equal(f.bodies.length, 2)
  assert.deepEqual(f.bodies[1]!.messages.slice(0, f.bodies[0]!.messages.length), f.bodies[0]!.messages)
  await f.agent.run('continue', callbacks)
  await f.agent.run('continue', callbacks)
  assert.deepEqual(f.errors.map(error => error.message), [])
  assert.equal(f.bodies.length, 4)
  assert.equal(f.toolResults(), 1)
  for (let i = 1; i < f.bodies.length; i++) {
    assert.deepEqual(f.bodies[i]!.messages.slice(0, f.bodies[i - 1]!.messages.length), f.bodies[i - 1]!.messages)
  }
  const changed = structuredClone(f.agent.session.getMessages())
  changed[0]!.content = 'changed published user input'
  assert.throws(() => f.engine.buildOaiRequest(changed), error => {
    assert.ok(error instanceof ContinuationPrefixError)
    assert.equal(continuityFailureDetails(error)?.stage, 'source')
    assert.equal(continuityFailureDetails(error)?.sourcePrefix, 'changed')
    return true
  })
})

test('legacy unnormalized wire proof requires explicit repair and survives restart plus subsequent requests', async t => {
  const f = continuityFixture(t)
  const memory = 'External summary: ' + 'e\u0301'.repeat(50)
  f.agent.updateSessionMemory(memory)
  await f.agent.run('Please write result.txt.', f.callbacks)
  await f.agent.drainPersistWrites(); await f.persist.drainFrozenSnapshots()
  const snapshot = f.persist.readFrozenSnapshot()!
  const raw = f.engine.buildOaiRequest(f.agent.session.getMessages())
  snapshot.executionSnapshot!.messages = proveRewindHistory(raw.messages.slice(0, snapshot.executionSnapshot!.messages.length))
  delete snapshot.executionSnapshot!.wireTransformVersion
  await f.persist.commitFrozenSnapshot(snapshot)
  const config = { ...f.config, volatileCtx: { ...f.config.volatileCtx, sessionMemoryBlock: memory } }
  const oldEngine = new PromptEngine({ ...config, inheritFrozenFrom: snapshot })
  const oldClient = createProviderClient(f.provider, resolveCapabilities('fixture'), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
  oldClient.restoreExecutionSnapshot!(snapshot.executionSnapshot!)
  oldEngine.setExecutionSnapshotCommit(data => f.persist.commitFrozenSnapshot(data))
  f.agent.config.promptEngine = oldEngine; f.agent.config.client = oldClient
  const sent = f.bodies.length
  await f.agent.run('continue', f.callbacks)
  assert.equal(f.bodies.length, sent, 'resume must not silently replace a mismatched transport baseline')
  const failure = f.errors.find(error => error instanceof ContinuationPrefixError)
  assert.ok(failure)
  assert.equal(continuityFailureDetails(failure)?.stage, 'transport')
  assert.equal(oldClient.getMainPrefixProof!()!.cacheGenerationId, snapshot.executionSnapshot!.cacheGenerationId)
  const plan = await previewContinuityRecovery(f.agent)
  assert.equal(plan.status, 'ready', plan.reason)
  const transcript = f.persist.loadOai()
  await applyContinuityRecovery(f.agent, plan.recoveryId!)
  assert.equal(f.bodies.length, sent, 'confirmation never sends a model request')
  assert.deepEqual(f.persist.loadOai(), transcript)
  const durable = f.persist.readFrozenSnapshot()!
  const engine = new PromptEngine({ ...config, inheritFrozenFrom: durable })
  const client = createProviderClient(f.provider, resolveCapabilities('fixture'), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
  client.restoreRewindAuthorization!(durable.rewindAuthorization!)
  const session = new SessionContext(); session.replaceMessages(f.persist.loadOai())
  const restarted = new AgentLoop({ ...f.agent.config, promptEngine: engine, client }, session, f.root)
  engine.setExecutionSnapshotCommit(data => f.persist.commitFrozenSnapshot(data))
  engine.setOnFrozenSnapshotChanged(() => f.persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
  t.after(async () => {
    await restarted.cancelIdleCompaction(); await restarted.drainPostSession(); await restarted.drainPersistWrites()
    await restarted.telemetryWriter.flush(); await restarted.frameRecorder.flush()
    restarted.stopFsWatcher(); restarted.stopConfigWatcher()
  })
  const errors: Error[] = []
  const callbacks = { ...f.callbacks, onError(error: Error) { errors.push(error) } }
  for (let i = 0; i < 3; i++) await restarted.run('continue', callbacks)
  assert.deepEqual(errors, [])
  assert.equal(f.bodies.length, sent + 3)
  assert.equal(f.toolResults(), 1)
  for (let i = sent + 1; i < f.bodies.length; i++) {
    assert.deepEqual(f.bodies[i]!.messages.slice(0, f.bodies[i - 1]!.messages.length), f.bodies[i - 1]!.messages)
  }
  await f.persist.drainFrozenSnapshots()
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
  assert.equal(client.getMainPrefixProof!()!.generationReason, 'explicit_projection_recovery')
  assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, plan.recoveryId)
  assert.equal(client.getMainPrefixProof!()!.wireTransformVersion, 'openai-chat-canonical-v1')
})
