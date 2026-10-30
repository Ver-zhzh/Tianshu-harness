import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import { attachSessionPersistListener } from '../session-persist-listener.js'
import type { SessionPersist } from '../session-persist.js'

for (const mutation of ['append', 'rewrite']) {
  test(`durability barrier rejects a failed ${mutation} instead of acknowledging it`, async () => {
    const session = new SessionContext()
    const error = new Error('injected storage failure')
    const persist = {
      appendOaiWithChecksum: async () => { throw error },
      compactOaiAsync: async () => { throw error },
      flushSessionBuffer: async () => {},
      matchesOaiSessionProjection: () => false,
    } as unknown as SessionPersist
    const listener = attachSessionPersistListener({ session, persist })
    if (mutation === 'append') session.addUserMessage('test')
    else session.replaceMessages([{ role: 'user', content: 'prefix' }])
    await assert.rejects(listener.drain(), error)
    await assert.rejects(listener.drain(), error)
  })
}
