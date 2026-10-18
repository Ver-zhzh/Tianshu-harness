import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { proveWirePrefix } from '../../api/continuation-prefix.js'

const make = () => new PromptEngine({ model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: '/fixture', gitStatus: '' } })
function publish(request: ReturnType<PromptEngine['buildOaiRequest']>, id = 'first') {
  const proof = { ...proveWirePrefix({ model: request.model, messages: request.messages, tools: request.tools }, 'fixture', id), cacheGenerationId: 'gen', credentialScope: 'fixture:default' }
  return request.onExecutionSnapshot!(proof)
}

test('published user survives memory, route and progress invalidation until a new occurrence', async () => {
  const engine = make()
  const history = [{ role: 'user' as const, content: 'continue' }]
  engine.setSessionState('STATE_A')
  const first = engine.buildOaiRequest(history)
  const firstAppendix = engine.getCachedAppendix()
  await publish(first)
  engine.setSessionState('STATE_B')
  engine.updateSessionMemory('NEW_MEMORY')
  engine.setIntentRetrievalRoute('NEW_ROUTE')
  const next = engine.buildOaiRequest(history)
  assert.deepEqual(next.messages, first.messages)
  assert.equal(engine.getCachedAppendix(), firstAppendix, 'diagnostics must describe the pinned bytes actually rendered')
  const fresh = engine.buildOaiRequest([...history, { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' }])
  assert.deepEqual(fresh.messages[1], first.messages[1])
  assert.match(String(fresh.messages.at(-1)?.content), /STATE_B/)
  assert.match(String(fresh.messages.at(-1)?.content), /NEW_MEMORY/)
})

test('a same-text new occurrence refreshes its appendix without touching its predecessor', () => {
  const engine = make()
  engine.setSessionState('STATE_A')
  const first = engine.buildOaiRequest([{ role: 'user', content: 'continue' }])
  engine.setSessionState('STATE_B')
  const next = engine.buildOaiRequest([{ role: 'user', content: 'continue' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' }])
  assert.deepEqual(next.messages[1], first.messages[1])
  assert.match(String(next.messages.at(-1)?.content), /STATE_B/)
})

test('publication commits its own captured render rather than a later preview', async () => {
  const engine = make()
  engine.setSessionState('STATE_A')
  const first = engine.buildOaiRequest([{ role: 'user', content: 'first' }])
  engine.setSessionState('STATE_B')
  engine.setIntentRetrievalRoute('new route')
  engine.buildOaiRequest([{ role: 'user', content: 'first' }, { role: 'user', content: 'speculative' }])
  await publish(first)
  const frozen = engine.exportFrozenSnapshot()
  const restored = new PromptEngine({ model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: '/fixture', gitStatus: '' }, inheritFrozenFrom: frozen })
  assert.deepEqual(restored.buildOaiRequest([{ role: 'user', content: 'first' }]).messages, first.messages)
  assert.equal(frozen.userKeys?.length, 1)
})

test('building a speculative request cannot replace the published disk projection', async () => {
  const engine = make()
  await publish(engine.buildOaiRequest([{ role: 'user', content: 'first' }]))
  const before = engine.exportFrozenSnapshot()
  engine.setSessionState('different')
  engine.buildOaiRequest([{ role: 'user', content: 'first' }, { role: 'user', content: 'unpublished' }])
  assert.deepEqual(engine.exportFrozenSnapshot(), before)
})

test('published source mutation fails before changing any render state', async () => {
  const engine = make()
  await publish(engine.buildOaiRequest([{ role: 'user', content: 'first' }]))
  const before = engine.exportFrozenSnapshot()
  assert.throws(() => engine.buildOaiRequest([{ role: 'user', content: 'changed' }]), /prefix diverged at source/)
  assert.deepEqual(engine.exportFrozenSnapshot(), before)
})

test('an older construction cannot overwrite a more recently published request', async () => {
  const engine = make()
  const old = engine.buildOaiRequest([{ role: 'user', content: 'first' }])
  const next = engine.buildOaiRequest([{ role: 'user', content: 'first' }, { role: 'user', content: 'next' }])
  await publish(next, 'next')
  const before = engine.exportFrozenSnapshot()
  assert.throws(() => publish(old), /构建已过期/)
  assert.deepEqual(engine.exportFrozenSnapshot(), before)
})

test('overlapping durable commits reject stale constructions before writing them', async () => {
  const engine = make()
  const writes: string[] = []
  engine.setExecutionSnapshotCommit(async snapshot => { writes.push(snapshot.executionSnapshot!.requestId) })
  const old = engine.buildOaiRequest([{ role: 'user', content: 'first' }])
  const next = engine.buildOaiRequest([{ role: 'user', content: 'first' }, { role: 'user', content: 'next' }])
  const later = publish(next, 'next')
  const earlier = publish(old, 'old')
  await later
  await assert.rejects(Promise.resolve(earlier), /构建已过期/)
  assert.deepEqual(writes, ['next'])
})

test('a failed durable publication leaves the previous frozen render untouched', async () => {
  const engine = make()
  await publish(engine.buildOaiRequest([{ role: 'user', content: 'first' }]))
  const before = engine.exportFrozenSnapshot()
  engine.setExecutionSnapshotCommit(async () => { throw new Error('disk full') })
  const next = engine.buildOaiRequest([{ role: 'user', content: 'first' }, { role: 'user', content: 'next' }])
  await assert.rejects(Promise.resolve(publish(next, 'next')), /disk full/)
  assert.deepEqual(engine.exportFrozenSnapshot(), before)
})

test('a published anchor missing from v2 can be recovered only from exact legacy bytes', async () => {
  const engine = make()
  const request = engine.buildOaiRequest([{ role: 'user', content: 'first' }])
  await publish(request)
  const snapshot = engine.exportFrozenSnapshot()
  snapshot.anchors = []
  const config = { model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: '/fixture', gitStatus: '' } }
  const restored = new PromptEngine({ ...config, inheritFrozenFrom: snapshot })
  assert.deepEqual(restored.buildOaiRequest([{ role: 'user', content: 'first' }]).messages, request.messages)
  snapshot.frozenPendingMerged = [['first', 'foreign bytes']]
  const corrupt = new PromptEngine({ ...config, inheritFrozenFrom: snapshot })
  assert.throws(() => corrupt.buildOaiRequest([{ role: 'user', content: 'first' }]), /已发布锚点缺失/)
})

test('a published multimodal anchor keeps part order and image bytes across invalidation', async () => {
  const engine = make()
  const image = { role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(300000) } }] }
  const first = engine.buildOaiRequest([image])
  await publish(first)
  engine.updateSessionMemory('new memory')
  assert.deepEqual(engine.buildOaiRequest([image]).messages, first.messages)
  assert.ok(JSON.stringify(engine.exportFrozenSnapshot()).length < 100000)
})
