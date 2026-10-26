import { randomUUID } from 'node:crypto'
/** One user run owns foreground effects and exactly one independent finalizer. */
export class RunLifecycle {
  readonly startedAt = Date.now()
  readonly id = randomUUID()
  private readonly controller = new AbortController()
  private finalization?: Promise<void>

  signalFor(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
  }

  close(): void { this.controller.abort() }

  finalize(start: () => Promise<void>): Promise<void> {
    return this.finalization ??= start()
  }
}
