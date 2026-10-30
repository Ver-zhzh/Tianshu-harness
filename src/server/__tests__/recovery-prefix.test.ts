import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersist } from '../../agent/session-persist.js'
import { SessionContext } from '../../agent/context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { proveWirePrefix } from '../../api/continuation-prefix.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { formatDiskReconciliationNote } from '../../context/write-evidence-probe.js'
import { prepareRecoveredMessagesAsync } from '../serve-agent.js'
import { restoreHistoryMessages } from '../serve.js'

const warning = 'Disk reconciliation is incomplete; verify existing work before repeating any external operation.'

for (const mode of ['sync', 'async'] as const) {
  for (const scenario of ['changed-age', 'stale-note', 'first-recovery'] as const) {
    test(`${mode} ${scenario}: recovery preserves published bytes and persists additions before the next restart`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'recovery-prefix-'))
      const cwd = join(directory, 'work')
      mkdirSync(cwd)
      const previous = process.env.RIVET_SESSION_DIR
      process.env.RIVET_SESSION_DIR = join(directory, 'sessions')
      t.after(() => {
        if (previous === undefined) delete process.env.RIVET_SESSION_DIR
        else process.env.RIVET_SESSION_DIR = previous
        rmSync(directory, { recursive: true, force: true })
      })
      if (scenario !== 'stale-note') writeFileSync(join(cwd, 'product.ts'), 'done')
      const oldNote = formatDiskReconciliationNote([{ path: 'product.ts', bytes: 4, mtimeMs: 0 }], 60_000)!
      const original: OaiMessage[] = [
        { role: 'user', origin: 'human', content: 'Inspect the project.' },
        ...(scenario === 'first-recovery' ? [] : [{ role: 'user' as const, content: oldNote }, { role: 'system' as const, content: warning }]),
        { role: 'assistant', content: 'Inspection complete.' },
      ]
      const persist = new SessionPersist(`recover-${mode}-${scenario}`, cwd)
      persist.initMetadata({ cleanExit: false, updatedAt: Date.now() })
      await persist.compactOaiAsync(original, true)
      const config = { model: 'test', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd } }
      const engine = new PromptEngine(config)
      const request = engine.buildOaiRequest(original)
      const proof = proveWirePrefix({ model: request.model, messages: request.messages, max_tokens: request.max_tokens,
        stream: request.stream, stream_options: request.stream_options, tools: request.tools, tool_choice: request.tool_choice },
      'fixture', 'first', 'https://fixture.invalid')
      proof.cacheGenerationId = 'fixture-generation'
      proof.credentialScope = 'fixture:default'
      await request.onExecutionSnapshot!(proof)
      await persist.commitFrozenSnapshot(engine.exportFrozenSnapshot())

      const recover = async (store: SessionPersist) => {
        if (mode === 'async') return prepareRecoveredMessagesAsync(store, cwd)
        const session = new SessionContext()
        restoreHistoryMessages(store, session, cwd)
        return session.getMessages()
      }
      const messages = await recover(persist)
      assert.deepEqual(messages.slice(0, original.length), original)
      assert.equal(messages.length, original.length + (scenario === 'stale-note' ? 0 : 1))
      if (scenario !== 'stale-note') assert.equal((messages.at(-1) as { origin?: string }).origin, 'hook')
      const resumed = new PromptEngine({ ...config, inheritFrozenFrom: persist.readFrozenSnapshot() })
      assert.equal(resumed.assertPublishedHistory(messages), true, 'compaction can still prove the published source')
      assert.doesNotThrow(() => resumed.buildOaiRequest([...messages, { role: 'user', origin: 'human', content: 'Continue.' }]))

      // A fresh store must see the new reminders without a later compact/replace.
      const reopened = new SessionPersist(`recover-${mode}-${scenario}`, cwd)
      assert.deepEqual(reopened.loadOai(), messages)
      const second = await recover(reopened)
      assert.deepEqual(second.slice(0, messages.length), messages)
      assert.deepEqual(reopened.loadOai(), second)
    })
  }
}
