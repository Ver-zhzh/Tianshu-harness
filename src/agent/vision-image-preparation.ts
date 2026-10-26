import { createHash } from 'node:crypto'
import type { ArtifactStore } from '../artifact/store.js'
import { archiveContextImages } from './context-image-archive.js'
import { VISION_IMAGE_PROFILE, type VisionImagePreview } from '../utils/vision-image-core.js'
import { processVisionImage } from '../utils/vision-image-worker.js'

export interface PreparedVisionImages { images: string[]; notice: string; refs: string[] }
const caches = new WeakMap<ArtifactStore, Map<string, Promise<VisionImagePreview>>>()

export async function prepareVisionImages(store: ArtifactStore | undefined, images: string[], options: {
  original?: boolean; signal?: AbortSignal
  process?: (url: string, signal?: AbortSignal) => Promise<VisionImagePreview>
} = {}): Promise<PreparedVisionImages> {
  const signal = options.signal
  signal?.throwIfAborted()
  if (!store || process.env.RIVET_IMAGE_PREVIEWS === '0') return { images, notice: '', refs: [] }
  // Never replace pixels until their original is durably indexed and readable.
  let refs: string[]
  try { refs = await archiveContextImages(store, [{ role: 'user', content: images.map(url => ({ type: 'image_url', image_url: { url } })) }]) }
  catch { signal?.throwIfAborted(); return { images, notice: '[Image preview unavailable: original archive failed; original images retained.]', refs: [] } }
  signal?.throwIfAborted()
  if (refs.length === 0) return { images, refs, notice: '' }
  let cache = caches.get(store)
  if (!cache) { cache = new Map(); caches.set(store, cache) }
  const output: string[] = [], notes: string[] = []
  for (const url of images) {
    signal?.throwIfAborted()
    if (options.original) { output.push(url); continue }
    const key = `${VISION_IMAGE_PROFILE}:${createHash('sha256').update(url).digest('hex')}`
    let job = cache.get(key)
    if (!job) {
      job = (options.process ?? processVisionImage)(url, signal)
      cache.set(key, job)
      // Bound retained base64, not merely entry count.
      while (cache.size > 4) cache.delete(cache.keys().next().value!)
    }
    let result: VisionImagePreview
    try { result = await job } catch { cache.delete(key); signal?.throwIfAborted(); result = { dataUrl: url, reason: 'processor-unavailable' } }
    signal?.throwIfAborted()
    output.push(result.dataUrl)
    if (result.reason) { cache.delete(key); notes.push(`preview fallback: ${result.reason}`) }
    if (result.originalWidth && result.width && result.originalHeight && result.height && result.dataUrl !== url) {
      notes.push(`Original ${result.originalWidth}x${result.originalHeight}; preview ${result.width}x${result.height}; coordinate scale x=${(result.originalWidth / result.width).toFixed(4)}, y=${(result.originalHeight / result.height).toFixed(4)}.`)
    }
  }
  return { images: output, refs, notice: `[Original images retained: ${refs.join(', ')}. Recall with ask_image(imageId). ${notes.join(' ')}]` }
}
