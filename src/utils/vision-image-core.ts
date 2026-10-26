// @ts-ignore — source workers use Node's native type stripping; tsup resolves this import.
import { decodeImageDataUrl, sniffImageMime } from './image-bytes.ts'

export const VISION_IMAGE_PROFILE = 'preview-2000-1m-v1'
export interface VisionImagePreview {
  dataUrl: string
  originalWidth?: number
  originalHeight?: number
  width?: number
  height?: number
  reason?: string
}

/** Runs only in the image worker. Originals and animation are never rewritten. */
export async function createVisionImagePreview(dataUrl: string): Promise<VisionImagePreview> {
  const source = decodeImageDataUrl(dataUrl)
  if (!source) return { dataUrl, reason: 'external-or-invalid' }
  const mime = sniffImageMime(source.bytes)
  if (mime === 'image/gif' || (mime === 'image/webp' && source.bytes.includes(Buffer.from('ANIM')))
    || (mime === 'image/png' && source.bytes.includes(Buffer.from('acTL')))) return { dataUrl, reason: 'animated' }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')) return { dataUrl, reason: 'unsupported' }
  const photon = await import('@silvia-odwyer/photon-node')
  const image = photon.PhotonImage.new_from_byteslice(source.bytes)
  try {
    const originalWidth = image.get_width(), originalHeight = image.get_height()
    const dimensions = { originalWidth, originalHeight, width: originalWidth, height: originalHeight }
    if (originalWidth <= 2000 && originalHeight <= 2000 && dataUrl.length <= 1024 * 1024) return { dataUrl, ...dimensions }
    if (originalWidth * originalHeight > 40_000_000) return { dataUrl, reason: 'pixel-budget' }
    const pixels = image.get_raw_pixels()
    let transparent = false
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) { transparent = true; break }
    const scale = Math.min(1, 2000 / originalWidth, 2000 / originalHeight)
    let width = Math.max(1, Math.round(originalWidth * scale)), height = Math.max(1, Math.round(originalHeight * scale))
    for (let attempt = 0; attempt < 12; attempt++) {
      const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3)
      try {
        const candidates: Array<[string, () => Uint8Array]> = [['image/png', () => resized.get_bytes()]]
        if (!transparent) candidates.push(['image/jpeg', () => resized.get_bytes_jpeg(80)], ['image/jpeg', () => resized.get_bytes_jpeg(70)])
        for (const [type, encode] of candidates) {
          const bytes = encode(), prefix = `data:${type};base64,`
          if (prefix.length + 4 * Math.ceil(bytes.byteLength / 3) > 1024 * 1024) continue
          const result = prefix + Buffer.from(bytes).toString('base64')
          return { dataUrl: result, originalWidth, originalHeight, width, height }
        }
      } finally { resized.free() }
      width = Math.max(1, Math.floor(width * 0.75)); height = Math.max(1, Math.floor(height * 0.75))
    }
    return { dataUrl, reason: 'preview-budget' }
  } finally { image.free() }
}
