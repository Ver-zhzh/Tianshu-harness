import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { previewContinuityRecovery, applyContinuityRecovery, withContinuityAvailable } from '../continuity-recovery.js'
import { continuityFixture as fixture } from './continuity-projection-fixture.js'
import { PromptEngine } from '../../prompt/engine.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'

for (const size of [20, 150_000]) test(`real write + memory refresh preserves the published prefix (${size} chars)`, async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt. ' + 'x'.repeat(size), f.callbacks)
  assert.deepEqual(f.errors, [])
  assert.equal(f.bodies.length, 2)
  assert.deepEqual(f.bodies[1]!.messages.slice(0, f.bodies[0]!.messages.length), f.bodies[0]!.messages)
  assert.equal(readFileSync(f.target, 'utf8'), 'saved once')
  await f.agent.run('continue', f.callbacks)
  assert.deepEqual(f.errors, [])
  assert.equal(f.toolResults(), 1)
  assert.match(JSON.stringify(f.bodies[2]), /NEW_MEMORY_AFTER_WRITE/)
  await f.persist.drainFrozenSnapshots()
  assert.deepEqual(f.persist.readFrozenSnapshot(), f.engine.exportFrozenSnapshot())
})

test('explicit recovery preserves transcript, consumes a durable authorization once, and fences stale builds', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const history = JSON.stringify(f.agent.session.getMessages())
  await f.agent.drainPersistWrites(); await f.persist.drainFrozenSnapshots()
  const stale = f.engine.buildOaiRequest(f.agent.session.getMessages())
  const old = f.persist.readFrozenSnapshot()!
  const plan = await previewContinuityRecovery(f.agent)
  assert.equal(plan.status, 'ready', plan.reason)
  const sends = f.bodies.length
  assert.equal((await applyContinuityRecovery(f.agent, plan.recoveryId!)).status, 'applied')
  assert.equal(f.bodies.length, sends, 'recovery never sends HTTP')
  assert.equal(JSON.stringify(f.agent.session.getMessages()), history)
  const pending = f.persist.readFrozenSnapshot()!
  assert.equal(pending.rewindAuthorization?.reason, 'explicit_projection_recovery')
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'sessions', 'fixture', 'continuity-backups', `${plan.recoveryId}.json`), 'utf8')), old)
  assert.throws(() => stale.onExecutionSnapshot!(old.executionSnapshot!), /构建已过期/)
  assert.equal((await applyContinuityRecovery(f.agent, plan.recoveryId!)).status, 'applied')
  await f.client.stream(f.engine.buildOaiRequest(f.agent.session.getMessages()), f.callbacks)
  const consumed = f.persist.readFrozenSnapshot()!
  assert.equal(consumed.rewindAuthorization, undefined)
  assert.equal(consumed.executionSnapshot?.cacheGenerationId, plan.recoveryId)
  assert.equal(f.toolResults(), 1)
  assert.equal((await applyContinuityRecovery(f.agent, plan.recoveryId!)).status, 'applied')
})

test('preview is bound to the complete history and refuses missing source evidence', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const plan = await previewContinuityRecovery(f.agent)
  assert.equal(plan.status, 'ready', plan.reason)
  f.agent.session.addUserMessage('arrived after preview')
  await f.agent.drainPersistWrites()
  await assert.rejects(applyContinuityRecovery(f.agent, plan.recoveryId!), /变化|不一致/)
  const snapshot = f.persist.readFrozenSnapshot()!
  delete snapshot.publishedHistory
  await f.persist.commitFrozenSnapshot(snapshot)
  assert.equal((await previewContinuityRecovery(f.agent)).status, 'blocked')
})

test('changed binding and active workers cannot obtain recovery authorization', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const altered = f.persist.readFrozenSnapshot()!
  altered.executionSnapshot!.credentialScope = 'other'
  await f.persist.commitFrozenSnapshot(altered)
  assert.equal((await previewContinuityRecovery(f.agent)).status, 'blocked')
  f.agent.config.coordinatorRef = () => ({ hasRunningWork: () => true } as never)
  assert.match((await previewContinuityRecovery(f.agent)).reason, /worker/)
})

test('a valid idle binding becomes ineligible while an independent worker is running', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  assert.equal((await previewContinuityRecovery(f.agent)).status, 'ready')
  f.agent.config.coordinatorRef = () => ({ hasRunningWork: () => true } as never)
  const blocked = await previewContinuityRecovery(f.agent)
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.reason, /worker/)
})

test('a durable recovery survives restart and seals source history before the next send', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const plan = await previewContinuityRecovery(f.agent)
  await applyContinuityRecovery(f.agent, plan.recoveryId!)
  const snapshot = f.persist.readFrozenSnapshot()!
  const restored = new PromptEngine({ ...f.config, inheritFrozenFrom: snapshot })
  restored.setExecutionSnapshotCommit(data => f.persist.commitFrozenSnapshot(data))
  const client = createProviderClient(f.provider, resolveCapabilities('fixture'), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
  client.restoreRewindAuthorization!(snapshot.rewindAuthorization!)
  const history = f.persist.loadOai()
  const sends = f.bodies.length
  assert.throws(() => restored.buildOaiRequest([{ role: 'user', content: 'foreign history' }]), /保留历史发生变化/)
  assert.equal(f.bodies.length, sends)
  await client.stream(restored.buildOaiRequest(history), f.callbacks)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
  assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, plan.recoveryId)
  assert.equal(f.toolResults(), 1)
})

test('an old snapshot with poisoned anchors can be explicitly repaired without deleting chat', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const damaged = f.persist.readFrozenSnapshot()!
  damaged.anchors![0]!.prefix += 'x'.repeat(50)
  await f.persist.commitFrozenSnapshot(damaged)
  const engine = new PromptEngine({ ...f.config, inheritFrozenFrom: damaged })
  f.agent.config.promptEngine = engine
  const history = f.persist.loadOai()
  assert.throws(() => engine.buildOaiRequest(history), /锚点与冻结投影不一致/)
  const plan = await previewContinuityRecovery(f.agent)
  assert.equal(plan.status, 'ready', plan.reason)
  await applyContinuityRecovery(f.agent, plan.recoveryId!)
  await f.client.stream(engine.buildOaiRequest(history), f.callbacks)
  assert.deepEqual(f.persist.loadOai(), history)
  assert.equal(f.toolResults(), 1)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
})

test('backup and durable-write failures preserve the old proof and allow an explicit retry', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const plan = await previewContinuityRecovery(f.agent)
  const before = f.persist.readFrozenSnapshot()
  const dir = join(f.root, 'sessions', 'fixture', 'continuity-backups')
  writeFileSync(dir, 'occupied')
  await assert.rejects(applyContinuityRecovery(f.agent, plan.recoveryId!))
  assert.deepEqual(f.persist.readFrozenSnapshot(), before)
  rmSync(dir); mkdirSync(dir)
  const failed = t.mock.method(f.persist, 'commitFrozenSnapshot', async () => { throw new Error('disk full') })
  await assert.rejects(applyContinuityRecovery(f.agent, plan.recoveryId!), /disk full/)
  assert.deepEqual(f.persist.readFrozenSnapshot(), before)
  failed.mock.restore()
  assert.equal((await applyContinuityRecovery(f.agent, plan.recoveryId!)).status, 'applied')
})

test('a failure after authorization reaches disk can be resumed by the same confirmation', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const plan = await previewContinuityRecovery(f.agent)
  let fail = true
  f.agent.config.client = new Proxy(f.client, { get(target, property) {
    if (property === 'restoreRewindAuthorization') return (authorization: Parameters<NonNullable<typeof target.restoreRewindAuthorization>>[0]) => {
      if (fail) { fail = false; throw new Error('activation interrupted') }
      target.restoreRewindAuthorization!(authorization)
    }
    return Reflect.get(target, property, target)
  } })
  await assert.rejects(applyContinuityRecovery(f.agent, plan.recoveryId!), /activation interrupted/)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization?.cacheGenerationId, plan.recoveryId)
  await applyContinuityRecovery(f.agent, plan.recoveryId!)
  await f.agent.config.client.stream(f.engine.buildOaiRequest(f.persist.loadOai()), f.callbacks)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
  assert.equal(f.toolResults(), 1)
})

test('maintenance blocks new main requests and independent worker dispatch', async t => {
  const f = fixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const plan = await previewContinuityRecovery(f.agent)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  const commit = f.persist.commitFrozenSnapshot.bind(f.persist)
  t.mock.method(f.persist, 'commitFrozenSnapshot', async (snapshot: Parameters<typeof commit>[0]) => { entered = true; await gate; await commit(snapshot) })
  const applying = applyContinuityRecovery(f.agent, plan.recoveryId!)
  try {
    for (let i = 0; !entered && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(entered, true)
    await assert.rejects(f.agent.run('must not start', f.callbacks), /正在修复前缀/)
    await assert.rejects(withContinuityAvailable(f.agent, async () => assert.fail('worker must not start')), /禁止启动/)
    await assert.rejects(applyContinuityRecovery(f.agent, plan.recoveryId!), /正在运行/)
  } finally { release() }
  await applying
})
