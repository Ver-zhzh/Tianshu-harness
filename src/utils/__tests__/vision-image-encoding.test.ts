import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { createVisionImagePreview } from '../vision-image-core.js'

function largeImage(): string {
  const image = new PNG({ width: 2400, height: 100 })
  image.data.fill(255)
  return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`
}

test('a fitting PNG never spends time encoding unused JPEG candidates', async t => {
  const jpeg = t.mock.method(PhotonImage.prototype, 'get_bytes_jpeg', () => { throw new Error('unused JPEG encoder ran') })
  const result = await createVisionImagePreview(largeImage())
  assert.equal(jpeg.mock.callCount(), 0)
  assert.equal(result.width, 2000)
  assert.ok(result.dataUrl.length <= 1024 * 1024)
  assert.match(result.dataUrl, /^data:image\/png;base64,/)
})

test('JPEG 70 is attempted only if PNG and JPEG 80 exceed the encoded budget', async t => {
  t.mock.method(PhotonImage.prototype, 'get_bytes', () => new Uint8Array(800_000))
  const jpeg = t.mock.method(PhotonImage.prototype, 'get_bytes_jpeg', (quality: number) => {
    assert.equal(quality, 80, 'JPEG 70 should not run when JPEG 80 fits')
    return new Uint8Array(100)
  })
  const result = await createVisionImagePreview(largeImage())
  assert.equal(jpeg.mock.callCount(), 1)
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/)
})

test('JPEG 70 remains available when the earlier encodings are too large', async t => {
  t.mock.method(PhotonImage.prototype, 'get_bytes', () => new Uint8Array(800_000))
  const qualities: number[] = []
  t.mock.method(PhotonImage.prototype, 'get_bytes_jpeg', (quality: number) => {
    qualities.push(quality)
    return new Uint8Array(quality === 80 ? 800_000 : 100)
  })
  const result = await createVisionImagePreview(largeImage())
  assert.deepEqual(qualities, [80, 70])
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/)
})
