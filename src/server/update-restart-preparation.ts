/** One preparation owns its cancellation even after the shared deadline expires. */
export class UpdateRestartPreparation {
  private readonly cancellation = new AbortController()
  readonly signal: AbortSignal

  constructor(deadline: AbortSignal) {
    this.signal = AbortSignal.any([deadline, this.cancellation.signal])
  }

  cancel(): void { this.cancellation.abort() }
  throwIfCancelled(): void { this.cancellation.signal.throwIfAborted() }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfCancelled()
    this.signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(this.signal.reason) }
      const cleanup = () => this.signal.removeEventListener('abort', onAbort)
      this.signal.addEventListener('abort', onAbort, { once: true })
      // Both branches stay attached after cancellation, including late rejection.
      Promise.resolve().then(() => {
        this.throwIfCancelled()
        this.signal.throwIfAborted()
        return operation()
      }).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  }
}
