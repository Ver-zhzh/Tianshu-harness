import { test } from 'node:test'
import assert from 'node:assert/strict'
import { continuityFixture } from './continuity-projection-fixture.js'
import { HistoryIntegrityError, LocalWorkerPolicyError, continuityFailureDetails } from '../../api/continuation-prefix.js'
import { sessionFailureFields } from '../../server/session-failure-fields.js'

test('published-source mutation reports numeric evidence through the real engine while retaining the send guard', async t => {
  const f = continuityFixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  const original = structuredClone(f.agent.session.getMessages())
  const changed = structuredClone(original)
  changed[0]!.content = 'private replacement text'
  const requests = f.bodies.length
  assert.throws(() => f.engine.assertPublishedHistory(changed), (error: unknown) => {
    assert.ok(error instanceof HistoryIntegrityError)
    assert.ok(error instanceof LocalWorkerPolicyError)
    const fields = sessionFailureFields(error)
    assert.equal(fields.continuity?.historyIntegrity?.firstMismatch, 0)
    assert.equal(fields.continuity?.historyIntegrity?.memoryCount, original.length)
    assert.ok(fields.continuity?.historyIntegrity?.publishedCount)
    assert.equal(fields.continuity?.recovery, 'blocked')
    assert.match(fields.guidance!, /救援/)
    assert.doesNotMatch(JSON.stringify(fields), /private replacement text/)
    return true
  })
  assert.equal(f.bodies.length, requests)
  assert.deepEqual(f.agent.session.getMessages(), original)
})

test('old policy errors also expose a rescue action without inventing mismatch counts', () => {
  for (const message of ['压缩前的持久化历史不完整；禁止提交', '历史与压缩提交的旧态和新态均不匹配；禁止恢复']) {
    const details = continuityFailureDetails(new LocalWorkerPolicyError(message))
    assert.equal(details?.kind, 'source_history')
    assert.equal(details?.recovery, 'blocked')
    assert.equal(details?.historyIntegrity, undefined)
  }
})
