import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersist } from '../../agent/session-persist.js'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { assertCompleteAttachments } from '../../api/attachment-integrity.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { providerSchema } from '../../config/schema.js'

const image: OaiMessage = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(300000) } }, { type: 'text', text: 'inspect' }] }
const make = () => new PromptEngine({ model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: '/test' } })

test('complete image survives actual batched file and sync/async reload; ordered snapshot failures remain observable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-lifecycle-'))
  const previous = process.env.RIVET_SESSION_DIR; process.env.RIVET_SESSION_DIR = dir
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  try {
    const persist = new SessionPersist('images', dir)
    await persist.appendOaiWithChecksum(image)
    await persist.flushSessionBuffer()
    const reloaded = new SessionPersist('images', dir)
    assert.deepEqual(reloaded.loadOai(), [image])
    assert.deepEqual(await reloaded.loadOaiAsync(), [image])
    const engine = make()
    engine.setOnFrozenSnapshotChanged(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
    const provider = providerSchema.parse({ name: 'fixture', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture', maxTokens: 4096 }] })
    const client = createProviderClient(provider, resolveCapabilities('fixture'), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
    const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error: Error) { throw error } }
    await client.stream(engine.buildOaiRequest([image]), callbacks)
    await client.stream(engine.buildOaiRequest([image, { role: 'user', content: 'next' }]), callbacks)
    await persist.drainFrozenSnapshots()
    assert.deepEqual(reloaded.readFrozenSnapshot(), engine.exportFrozenSnapshot())
    const path = persist.getFilePath().replace(/\.jsonl$/, '.frozen.json')
    await rm(path); await mkdir(path)
    persist.queueFrozenSnapshot(engine.exportFrozenSnapshot())
    await persist.drainFrozenSnapshots()
    assert.equal(persist.getFrozenSnapshotError(), 'snapshot_save_failed')
    await rm(path, { recursive: true })
    persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()); await persist.drainFrozenSnapshots()
    assert.equal(persist.getFrozenSnapshotError(), undefined)
  } finally {
    globalThis.fetch = previousFetch
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('a controlled history replacement never borrows another duplicate occurrence', () => {
  const engine = make()
  engine.buildOaiRequest([{ role: 'user', content: 'continue' }])
  engine.buildOaiRequest([{ role: 'user', content: 'continue' }, { role: 'user', content: 'continue' }])
  engine.resetAppendixBaseline()
  engine.buildOaiRequest([{ role: 'user', content: 'continue' }])
  assert.equal(engine.consumeFrozenRestoreReason(), 'history_replaced')
  assert.equal(engine.exportFrozenSnapshot().anchors?.length, 1)
})

test('damaged legacy attachments fail before sending; plain text markers are allowed', () => {
  assert.throws(() => assertCompleteAttachments([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ABC\n<session-message-truncated original_chars="300000" />' } }] }]), /附件不完整/)
  assert.doesNotThrow(() => assertCompleteAttachments([{ role: 'user', content: 'Please explain <session-message-truncated original_chars="1" />' }]))
})
