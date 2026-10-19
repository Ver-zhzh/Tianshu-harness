import type { SessionEvent } from './protocol.js'

/** A bounded page acknowledges only the events it actually returned. */
export function boundedEventPage(events: SessionEvent[], since: number, requested: string) {
  const page = events.slice(0, Math.min(Math.max(Number(requested) || 500, 1), 2000))
  return { events: page, lastSeq: page.at(-1)?.seq ?? since }
}
