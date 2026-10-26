import { performance } from 'node:perf_hooks'

export interface RequestMeasurements {
  runFirstTextMs?: number
  requestPreparationMs?: number
  bodyPreparationMs?: number
  authenticationMs?: number
  rateLimitWaitMs?: number
  preRequestMs?: number
  firstTextMs?: number
  firstToolInputMs?: number
  firstOutputMs?: number
  requestDurationMs?: number
  requestBodyBytes?: number
  imageCount?: number
  imageBytes?: number
}

type PreparationPhase = 'bodyPreparationMs' | 'authenticationMs' | 'rateLimitWaitMs'

/** Counts only image payloads, never retains content or changes a wire object. */
export function measureRequestImages(body: unknown): { imageCount: number; imageBytes: number } {
  let imageCount = 0, imageBytes = 0
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    const item = value as Record<string, unknown>
    if (item.type === 'image_url' || item.type === 'input_image') {
      const image = item.image_url
      const url = typeof image === 'string' ? image : (image as { url?: string } | undefined)?.url
      if (typeof url === 'string') { imageCount++; imageBytes += Buffer.byteLength(url) }
      return
    }
    const source = item.source as { type?: string; data?: string } | undefined
    const inline = (item.inlineData ?? item.inline_data) as { mimeType?: string; mime_type?: string; data?: string } | undefined
    if (item.type === 'image' && source?.type === 'base64' && typeof source.data === 'string') {
      imageCount++; imageBytes += Buffer.byteLength(source.data); return
    }
    if (inline && (inline.mimeType ?? inline.mime_type)?.startsWith('image/') && typeof inline.data === 'string') {
      imageCount++; imageBytes += Buffer.byteLength(inline.data); return
    }
    for (const child of Object.values(item)) if (child && typeof child === 'object') visit(child)
  }
  visit(body)
  return { imageCount, imageBytes }
}

export class RequestObservation {
  private readonly started: number
  private facts: RequestMeasurements = {}
  constructor(private readonly now: () => number = () => performance.now(), startedAt?: number) { this.started = startedAt ?? now() }
  elapsed(): number { return Math.max(0, this.now() - this.started) }
  measure<T>(phase: PreparationPhase, action: () => T): T {
    const started = this.now()
    try { return action() } finally { this.facts[phase] = (this.facts[phase] ?? 0) + Math.max(0, this.now() - started) }
  }
  async measureAsync<T>(phase: PreparationPhase, action: () => Promise<T>): Promise<T> {
    const started = this.now()
    try { return await action() } finally { this.facts[phase] = (this.facts[phase] ?? 0) + Math.max(0, this.now() - started) }
  }
  output(kind: 'text' | 'thinking' | 'tool'): void {
    const elapsed = this.elapsed()
    this.facts.firstOutputMs ??= elapsed
    if (kind === 'text') this.facts.firstTextMs ??= elapsed
    if (kind === 'tool') this.facts.firstToolInputMs ??= elapsed
  }
  sent(serialized: string, body: unknown): void {
    this.facts = { ...this.facts, requestPreparationMs: this.elapsed(), requestBodyBytes: Buffer.byteLength(serialized), ...measureRequestImages(body) }
  }
  snapshot(): RequestMeasurements { return { ...this.facts, requestDurationMs: this.elapsed() } }
}
