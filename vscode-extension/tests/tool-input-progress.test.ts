import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretSessionEvent } from '../src/chat/turn-events.js'
import { isLivenessEvent } from '../src/shared/session-state-reducer.js'

test('native chat receives tool-input counts and recognizes generation as activity', () => {
  const event = { type: 'tool_input_progress' as const, seq: 1, ts: 1,
    data: { toolCallId: 'call', attemptId: 'attempt', toolName: 'write_file', argumentBytes: 1024, state: 'generating' } }
  assert.equal(isLivenessEvent(event), true)
  assert.deepEqual(interpretSessionEvent(event), { kind: 'tool-input-progress', id: 'call', name: 'write_file', bytes: 1024, state: 'generating' })
  assert.equal(interpretSessionEvent({ ...event, data: { ...event.data, argumentBytes: NaN } }), undefined)
})
