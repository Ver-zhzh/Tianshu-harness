import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { ArtifactStore } from '../../artifact/store.js'
import { prepareVisionImages } from '../vision-image-preparation.js'
import { loadContextImage } from '../context-image-archive.js'
import { processVisionImage } from '../../utils/vision-image-worker.js'

test('archive precedes preview and durable image id survives registry absence and restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-preview-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new ArtifactStore(dir, 's'), original = 'data:image/png;base64,b3JpZ2luYWw='
  let calls = 0
  const process = async () => {
    calls++
    assert.ok(store.listByTarget('context-image:' + (await import('node:crypto')).createHash('sha256').update(original).digest('hex')).length)
    return { dataUrl: 'data:image/png;base64,cHJldmlldw==', originalWidth: 4000, originalHeight: 2000, width: 2000, height: 1000 }
  }
  const first = await prepareVisionImages(store, [original], { process })
  const second = await prepareVisionImages(store, [original], { process })
  assert.equal(calls, 1); assert.deepEqual(second, first)
  assert.equal((await loadContextImage(new ArtifactStore(dir, 's'), first.refs[0]))?.dataUrl, original)
  assert.match(first.notice, /scale x=2.0000, y=2.0000/)
  assert.equal((await prepareVisionImages(store, [original], { original: true, process })).images[0], original)
})

test('archive failure preserves pixels and cannot invoke the image processor', async () => {
  const store = { listByTarget: () => [], saveDurable: async () => { throw new Error('disk') } } as unknown as ArtifactStore
  const original = 'data:image/png;base64,YQ=='
  const result = await prepareVisionImages(store, [original], { process: async () => { throw new Error('must not run') } })
  assert.deepEqual(result.images, [original]); assert.deepEqual(result.refs, [])
})

test('real worker preserves transparent pixels, limits dimensions and leaves the original intact', async () => {
  const image = new PNG({ width: 2400, height: 100 }); image.data.fill(255); image.data[3] = 0
  const original = 'data:image/png;base64,' + PNG.sync.write(image).toString('base64')
  const result = await processVisionImage(original)
  assert.equal(result.reason, undefined, 'worker must run, not silently take its passthrough fallback')
  assert.ok(result.width! <= 2000 && result.height! <= 2000)
  assert.match(result.dataUrl, /^data:image\/png/)
  const decoded = PNG.sync.read(Buffer.from(result.dataUrl.split(',')[1]!, 'base64'))
  assert.ok(decoded.data.some((value, i) => i % 4 === 3 && value < 255))
  assert.equal(PNG.sync.read(Buffer.from(original.split(',')[1]!, 'base64')).width, 2400)
})

test('animation and cancellation never silently discard source images', async () => {
  const gif = 'data:image/gif;base64,' + Buffer.from('GIF89aanimated').toString('base64')
  assert.equal((await processVisionImage(gif)).dataUrl, gif)
  const abort = new AbortController(); abort.abort(new Error('cancelled'))
  await assert.rejects(processVisionImage(gif, abort.signal), /cancelled/)
})
