import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '../../artifact/store.js'
import { imageBudgetSignature, prepareImageBudgetCandidate } from '../image-budget.js'
import { loadContextImage } from '../context-image-archive.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { SessionContext } from '../context.js'
import { RequestContextController } from '../request-context-controller.js'
import type { AgentLoop } from '../loop.js'
import { parseFrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import { isRewindGenerationAuthorization, proveWirePrefix } from '../../api/continuation-prefix.js'
import { wireOaiMessage } from '../../api/oai-types.js'
import { createHash, type Hash } from 'node:crypto'

function image(n: number): OaiMessage {
  return { role: 'user', origin: 'hook', content: [{ type: 'text', text: `Screenshot ${n}` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${String(n).repeat(1_000_000)}` } }] }
}

test('image budget archives pixels and preserves protected input, text and the latest three images above target', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new ArtifactStore(dir, 's')
  const active: OaiMessage = { role: 'user', content: 'Preserve these requirements.' }
  const source = [image(1), image(2), image(3), image(4), image(5), image(6), image(7), active]
  const before = JSON.stringify(source)
  const result = await prepareImageBudgetCandidate(store, source, { protectedUser: active, wireBytes: 12_000_000,
    prepare: async (_store, urls) => ({ images: urls, refs: [], notice: '' }) })
  assert.ok(result)
  assert.equal(JSON.stringify(source), before)
  assert.equal(result.messages.at(-1), active)
  assert.ok(result.reclaimedBytes > 3_000_000)
  assert.equal(result.targetReached, false, 'protected recent images may keep the request above target')
  const retained = result.messages.flatMap(message => message.role === 'user' && Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : [])
  assert.deepEqual(retained, [5, 6, 7].map(n => `data:image/png;base64,${String(n).repeat(1_000_000)}`))
  const encoded = JSON.stringify(result.messages)
  for (let n = 1; n <= 7; n++) assert.ok(encoded.includes(`Screenshot ${n}`))
  const ref = /context-image:[a-zA-Z0-9_-]+/.exec(encoded)?.[0]
  assert.ok(ref)
  assert.ok((await loadContextImage(new ArtifactStore(dir, 's'), ref))?.dataUrl.startsWith('data:image/png;base64,'))
})

test('image_budget authorization survives pending frozen-snapshot parsing', () => {
  const prior = { ...proveWirePrefix({ model: 'm', messages: [{ role: 'user', content: 'before' }] }, 'p', 'r', 'https://fixture.invalid'), cacheGenerationId: 'old', credentialScope: 'p:fixture' }
  const authorization = { version: 1 as const, reason: 'image_budget' as const, cacheGenerationId: 'new', model: 'm', history: prior.messages, prior }
  assert.equal(isRewindGenerationAuthorization(authorization), true)
  const snapshot = { v: 1, frozenUserMerged: [], frozenPendingMerged: [], firstUserKey: null, collapseWatermark: 0, collapseTokenStep: 0,
    rewindAuthorization: authorization, pendingCompaction: { version: 1, priorHistory: prior.messages, authorization } }
  assert.ok(parseFrozenSnapshotData(snapshot), 'both authorization and pending-journal validators must accept the reason')
  assert.equal(parseFrozenSnapshotData({ ...snapshot, pendingCompaction: { ...snapshot.pendingCompaction, authorization: { ...authorization, reason: 'arbitrary' } } }), undefined)
})

test('explicit original visual re-query remains full-fidelity until consumed and policy stays local', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-budget-original-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = { ...image(9), imagePolicy: 'original' as const } as OaiMessage
  const source: OaiMessage[] = [image(1), image(2), image(3), image(4), { role: 'assistant', content: 'asking for original' }, original]
  const result = await prepareImageBudgetCandidate(new ArtifactStore(dir, 's'), source, { wireBytes: 9_000_000,
    prepare: async (_store, urls) => ({ images: urls, refs: [], notice: '' }) })
  assert.ok(result, 'older images can be reclaimed while the explicit query remains protected')
  assert.equal(result.messages.at(-1), original)
  assert.equal('imagePolicy' in wireOaiMessage(original), false)
  assert.equal('origin' in wireOaiMessage(original), false)
})

test('real request controller starts a generation for oversized image bytes even below token budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-budget-controller-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = new SessionContext()
  session.replaceMessages([image(1), image(2), image(3), image(4), image(5), image(6), image(7), image(8), image(9), { role: 'user', content: 'active' }])
  const store = new ArtifactStore(dir, 's'), reasons: string[] = []
  const agent = { session, artifactStore: store, persist: {}, getRunSignal: () => new AbortController().signal,
    drainPersistWrites: async () => {}, commitBudgetHistory: async (_source: OaiMessage[], target: OaiMessage[]) => { session.replaceMessages(target) },
    config: { contextWindow: 1_000_000, client: { authorizeCacheGeneration: (reason: string) => reasons.push(reason) }, promptEngine: {
      getRequestBudgetPolicy: () => undefined, getModel: () => 'm', getExecutionSnapshot: () => undefined, getRewindAuthorization: () => undefined,
      assertPublishedHistory: () => false, getPublishedUserCount: () => 0, authorizeCacheGeneration: () => {}, resetAppendixBaseline: () => {},
    } },
  } as unknown as AgentLoop
  const controller = new RequestContextController(agent)
  Object.defineProperty(agent, 'requestContext', { value: controller })
  controller.activeUserMessage = session.getMessages().at(-1)
  const build = () => ({ model: 'm', messages: session.getMessages(), max_tokens: 256_000 })
  const serialize = JSON.stringify, first = session.getMessages()[0], active = controller.activeUserMessage
  let sourceSerializations = 0
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    if (Array.isArray(args[0]) && args[0][0] === first && args[0].at(-1) === active) sourceSerializations++
    return serialize(...args)
  })
  const result = await controller.prepare(build, {} as never)
  assert.equal(sourceSerializations, 4, 'snapshot, concurrency guard and transaction checks remain; the candidate reuses snapshot bytes')
  assert.deepEqual(reasons, ['image_budget'])
  assert.ok(result.contextBudget!.inputTokens < result.contextBudget!.inputBudget)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6_000_000)
  await controller.prepare(build, {} as never)
  assert.equal(reasons.length, 1, 'the settled image set must not create another cold generation')
})

test('a protected-only oversized request reports an unmet budget once without rewriting history', async () => {
  const session = new SessionContext()
  session.replaceMessages([image(1)])
  const original = JSON.stringify(session.getMessages()), phases: string[] = []
  const agent = { session, persist: {}, artifactStore: {}, getRunSignal: () => new AbortController().signal, config: {
    client: { authorizeCacheGeneration: () => assert.fail('protected-only input must not start a generation') },
    promptEngine: { getRequestBudgetPolicy: () => undefined },
  } } as unknown as AgentLoop
  const controller = new RequestContextController(agent)
  controller.activeUserMessage = session.getMessages()[0]
  const build = () => ({ model: 'm', messages: [{ role: 'system' as const, content: 's'.repeat(8_000_000) }, ...session.getMessages()], max_tokens: 1 })
  const callbacks = { onPhaseChange: (phase: string) => phases.push(phase) } as never
  await controller.prepare(build, callbacks)
  await controller.prepare(build, callbacks)
  assert.equal(JSON.stringify(session.getMessages()), original)
  assert.deepEqual(phases, ['preparing', 'image-budget'])
})

test('image budget reuses the source byte measurement and serializes its candidate only once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-budget-serialization-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const active: OaiMessage = { role: 'user', content: 'active' }
  const source = [image(1), image(2), image(3), image(4), active]
  const serialize = JSON.stringify, sourceBytes = Buffer.byteLength(serialize(source))
  let historySerializations = 0
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    const value = args[0]
    if (Array.isArray(value) && value.at(-1) === active) historySerializations++
    return serialize(...args)
  })
  const candidate = await prepareImageBudgetCandidate(new ArtifactStore(dir, 's'), source, { protectedUser: active, wireBytes: 9_000_000, sourceBytes,
    prepare: async (_store, urls) => ({ images: urls, refs: [], notice: '' }) })
  assert.ok(candidate)
  assert.equal(historySerializations, 1)
  assert.equal(candidate.reclaimedBytes, sourceBytes - Buffer.byteLength(serialize(candidate.messages)))
})

test('cached image signatures still detect replaced URLs and changed protected boundaries', () => {
  const source = [image(1), image(2)]
  const initial = imageBudgetSignature(source, source[0])
  assert.equal(imageBudgetSignature(source, source[0]), initial)
  const message = source[0]!
  if (message.role !== 'user' || !Array.isArray(message.content)) assert.fail('fixture must contain an image')
  const part = message.content.find(p => p.type === 'image_url')!
  part.image_url.url += 'A'
  assert.notEqual(imageBudgetSignature(source, source[0]), initial)
  assert.notEqual(imageBudgetSignature(source, source[0]), imageBudgetSignature(source, source[1]))
})

test('stable image signatures do not hash retained multi-megabyte URL strings again', t => {
  const prototype = Object.getPrototypeOf(createHash('sha256')) as Hash
  const update = prototype.update
  let largeHashUpdates = 0
  t.mock.method(prototype, 'update', function (this: Hash, ...args: Parameters<Hash['update']>) {
    if (typeof args[0] === 'string' && args[0].length >= 1_000_000) largeHashUpdates++
    return Reflect.apply(update, this, args)
  })
  const messages = [image(1), image(2)]
  imageBudgetSignature(messages)
  assert.equal(largeHashUpdates, 2)
  imageBudgetSignature(messages)
  assert.equal(largeHashUpdates, 2, 'only small cached digests may be rehashed')
})
