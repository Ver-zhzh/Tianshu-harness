import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRepairPrefixCommand } from '../repair-prefix.js'
import type { TuiApp } from '../engine/app.js'
import type { SlashCommand } from '../slash-command-registry.js'
import type { BootstrapContext } from '../../bootstrap.js'
import { continuityFixture } from '../../agent/__tests__/continuity-projection-fixture.js'

test('/repair-prefix previews and confirms the real durable protocol without sending a request', async t => {
  const f = continuityFixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  let command!: SlashCommand
  const lines: string[] = []
  const app = { busy: false, registerSlashCommand(value: SlashCommand) { command = value }, commitStatic(text: string) { lines.push(text) } } as unknown as TuiApp
  registerRepairPrefixCommand(app, { agent: f.agent } as BootstrapContext)
  const sends = f.bodies.length
  await command.handler({ app, input: '/repair-prefix', trimmed: '/repair-prefix' })
  const recoveryId = lines.at(-1)!.match(/--confirm ([a-f0-9-]{36})/)?.[1]
  assert.ok(recoveryId)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
  const input = `/repair-prefix --confirm ${recoveryId}`
  await command.handler({ app, input, trimmed: input })
  assert.match(lines.at(-1)!, /恢复授权已提交/)
  assert.equal(f.persist.readFrozenSnapshot()!.rewindAuthorization?.cacheGenerationId, recoveryId)
  assert.equal(f.bodies.length, sends)
})
