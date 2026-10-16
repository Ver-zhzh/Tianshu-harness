import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ImageGenerationService } from '../image-generation-service.js'
import { imageDirectory } from '../image-generation-store.js'

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
const result = { bytes: png, mimeType: 'image/png', source: 'b64_json' as const }

async function input() {
  return {
    cwd: await mkdtemp(join(tmpdir(), 'tianshu-delete-')),
    requestId: randomUUID(),
    origin: 'workbench' as const,
    parameters: { provider: 'image', model: 'model', prompt: 'test', prefix: '', size: '1024x1024', sizeField: 'image_size' as const },
    connection: { baseUrl: 'https://example.com/v1', apiKey: 'not-a-real-key' },
  }
}

test('delete removes record and image file from disk', async () => {
  const service = new ImageGenerationService(undefined, async () => result)
  const request = await input()
  const record = await service.start(request)
  const done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'succeeded')
  const dir = imageDirectory(request.cwd)
  assert.equal((await readdir(dir)).filter(f => f.endsWith('.json')).length, 1)
  assert.equal((await readdir(dir)).filter(f => f.endsWith('.png')).length, 1)
  const deleted = await service.delete(request.cwd, record.id)
  assert.equal(deleted.deleted, true)
  assert.equal((await readdir(dir)).filter(f => f.endsWith('.json')).length, 0)
  assert.equal((await readdir(dir)).filter(f => f.endsWith('.png')).length, 0)
})

test('delete returns not-found for missing record', async () => {
  const service = new ImageGenerationService(undefined, async () => result)
  const request = await input()
  const deleted = await service.delete(request.cwd, '00000000-0000-0000-0000-000000000000')
  assert.equal(deleted.deleted, false)
  assert.equal(deleted.reason, 'not-found')
})

test('delete rejects invalid id format', async () => {
  const service = new ImageGenerationService(undefined, async () => result)
  const request = await input()
  const deleted = await service.delete(request.cwd, '../../etc/passwd')
  assert.equal(deleted.deleted, false)
  assert.equal(deleted.reason, 'invalid-id')
})
