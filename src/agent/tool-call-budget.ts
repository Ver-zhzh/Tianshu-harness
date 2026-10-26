/** Machine-work watchdog. Human approval and scheduler waits do not spend it. */
export class ToolCallBudget {
  readonly signal: AbortSignal
  private readonly abort = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private remaining: number
  private armedAt = 0
  private suspended = 0
  private closed = false
  private dispatched = false
  private phase: 'preparation' | 'postprocessing' = 'preparation'

  constructor(private readonly name: string, private readonly timeoutMs: number, upstream?: AbortSignal) {
    this.remaining = timeoutMs
    this.signal = upstream ? AbortSignal.any([upstream, this.abort.signal]) : this.abort.signal
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.arm()
    try { return await this.untilAbort(operation) }
    finally { this.closed = true; this.clear() }
  }

  /** release() may be called at dispatch, before the queued operation settles. */
  async waiting<T>(operation: (release: () => void) => Promise<T>): Promise<T> {
    const release = this.pause()
    try { return await this.untilAbort(() => operation(release)) }
    finally { release() }
  }

  /** Execution has its own tool-specific deadline; post-work gets a fresh budget. */
  async executing<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const release = this.pause()
    this.dispatched = true
    try { return await operation() }
    finally {
      this.phase = 'postprocessing'
      this.remaining = this.timeoutMs
      release()
    }
  }

  private pause(): () => void {
    this.signal.throwIfAborted()
    if (this.suspended++ === 0) {
      if (this.timer !== undefined) this.remaining = Math.max(0, this.remaining - (performance.now() - this.armedAt))
      this.clear()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.suspended === 0) this.arm()
    }
  }

  private arm(): void {
    if (this.closed || this.signal.aborted || this.suspended > 0 || this.timer !== undefined) return
    this.armedAt = performance.now()
    this.timer = setTimeout(() => {
      const detail = this.dispatched
        ? '工具已开始执行，当前后处理未确认完成；先查询已有执行与文件状态，不要直接重跑。'
        : '本次工具主体未执行；准备阶段未完成，保留已有准备记录，核对后再决定下一步。'
      this.abort.abort(new Error(`Tool ${this.name} timed out after ${this.timeoutMs / 1000}s (${this.phase}) — ${detail}`))
    }, Math.max(1, this.remaining))
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private untilAbort<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason)
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', onAbort, { once: true })
      // Keep handlers on late results, but never resume a cancelled continuation.
      Promise.resolve().then(() => { this.signal.throwIfAborted(); return operation() }).then(resolve, reject)
        .finally(() => this.signal.removeEventListener('abort', onAbort))
    })
  }
}
