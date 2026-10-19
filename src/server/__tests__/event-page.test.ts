import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundedEventPage } from '../event-page.js'
import type { SessionEvent } from '../protocol.js'

test('incremental event pages never acknowledge an unreturned tail', () => {
  const events: SessionEvent[] = Array.from({ length: 1200 }, (_, i) => ({ seq: i + 1, ts: i, type: 'text_delta', data: { text: 'x' } }))
  const first = boundedEventPage(events, 0, '500')
  const second = boundedEventPage(events.filter(e => e.seq > first.lastSeq), first.lastSeq, '500')
  const third = boundedEventPage(events.filter(e => e.seq > second.lastSeq), second.lastSeq, '500')
  assert.deepEqual([first.lastSeq, second.lastSeq, third.lastSeq], [500, 1000, 1200])
  assert.deepEqual([...first.events, ...second.events, ...third.events], events)
  assert.equal(boundedEventPage([], 1200, '500').lastSeq, 1200)
})
