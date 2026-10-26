export interface ToolInputProgress {
  requestId?: string
  attemptId?: string
  toolCallId: string
  toolName?: string
  argumentBytes: number
  state: 'generating' | 'complete' | 'aborted'
}

/** Parser-local counters. Raw argument fragments are counted, never retained. */
export class ProviderToolProgress {
  private calls = new Map<string, ToolInputProgress>()
  private aliases = new Map<string, string>()
  constructor(private identity: { requestId?: string; attemptId?: string } = {}) {}
  update(key: string, id: string | undefined, name: string | undefined, delta: string, emit: ((p: ToolInputProgress) => void) | undefined, state: ToolInputProgress['state'] = 'generating', totalBytes?: number): void {
    let previous = this.calls.get(key)
    if (id && previous && previous.toolCallId !== key && id !== previous.toolCallId) previous = undefined
    const progress: ToolInputProgress = { ...this.identity, toolCallId: id ?? previous?.toolCallId ?? key,
      toolName: name ?? previous?.toolName, argumentBytes: totalBytes === undefined ? (previous?.argumentBytes ?? 0) + Buffer.byteLength(delta) : Math.max(previous?.argumentBytes ?? 0, totalBytes), state }
    this.calls.set(key, progress)
    if (id || (previous && previous.toolCallId !== key)) emit?.(progress)
  }
  responses(event: Record<string, any>, emit: ((p: ToolInputProgress) => void) | undefined): void {
    const item = event.item
    const identity = event.item_id ?? item?.id
    const index = event.output_index === undefined ? undefined : `index:${event.output_index}`
    const key = String(identity ?? (index ? this.aliases.get(index) ?? index : ''))
    if (!key) return
    if (identity && index) this.aliases.set(index, String(identity))
    if (event.type === 'response.output_item.added' && item?.type === 'function_call') {
      this.update(key, item.call_id ?? item.id, item.name, '', emit)
    } else if (event.type === 'response.function_call_arguments.delta') {
      this.update(key, undefined, undefined, typeof event.delta === 'string' ? event.delta : '', emit)
    } else if (event.type === 'response.output_item.done' && item?.type === 'function_call') {
      // The terminal item may carry arguments without any preceding delta.
      this.update(key, item.call_id ?? item.id, item.name, '', emit, 'complete', Buffer.byteLength(String(item.arguments ?? '')))
    }
  }
}

/** First and terminal events are immediate; intermediate events are bounded. */
export class ToolInputProgressEmitter {
  private pending = new Map<string, ToolInputProgress>()
  private published = new Map<string, { at: number; name?: string }>()
  private timer?: ReturnType<typeof setTimeout>
  constructor(private emit: (progress: ToolInputProgress) => void, private now: () => number = Date.now) {}
  push(progress: ToolInputProgress): void {
    if (!Number.isFinite(progress.argumentBytes) || progress.argumentBytes < 0 || !progress.toolCallId) return
    progress = { requestId: progress.requestId?.slice(0, 256), attemptId: progress.attemptId?.slice(0, 256),
      toolCallId: progress.toolCallId.slice(0, 256), toolName: progress.toolName?.slice(0, 160),
      argumentBytes: progress.argumentBytes, state: progress.state }
    const key = `${progress.attemptId ?? ''}:${progress.toolCallId}`
    const previous = this.published.get(key)
    if (!previous || progress.state !== 'generating' || previous.name !== progress.toolName || this.now() - previous.at >= 100) {
      this.pending.delete(key)
      this.published.set(key, { at: this.now(), name: progress.toolName })
      this.emit(progress)
      if (progress.state !== 'generating') this.published.delete(key)
    } else {
      this.pending.set(key, progress)
      this.scheduleFlush()
    }
  }
  flush(): void {
    const now = this.now()
    for (const [key, progress] of this.pending) {
      if (now - (this.published.get(key)?.at ?? -Infinity) < 100) continue
      this.pending.delete(key)
      this.published.set(key, { at: now, name: progress.toolName }); this.emit(progress)
    }
    this.scheduleFlush()
  }
  private scheduleFlush(): void {
    if (this.timer || !this.pending.size) return
    const now = this.now()
    const delay = Math.max(0, Math.min(...[...this.pending.keys()].map(key => (this.published.get(key)?.at ?? now) + 100 - now)))
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, delay)
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear(); this.published.clear()
  }
}
