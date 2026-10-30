import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRepairPrefixCommand } from '../repair-prefix.js'
import type { TuiApp } from '../engine/app.js'
import type { SlashCommand } from '../slash-command-registry.js'
import type { BootstrapContext } from '../../bootstrap.js'
import { continuityFixture } from '../../agent/__tests__/continuity-projection-fixture.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { readFileSync } from 'node:fs'

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

test('/repair-prefix rescue exports before confirmation and seeds only a reference in a new session', async t => {
  const f = continuityFixture(t)
  await f.agent.run('Please write result.txt.', f.callbacks)
  await f.agent.drainPersistWrites(); await f.persist.drainFrozenSnapshots()
  const original = readFileSync(f.persist.getFilePath())
  const sends = f.bodies.length
  let command!: SlashCommand
  const lines: string[] = []
  const app = { busy: false, registerSlashCommand(value: SlashCommand) { command = value }, commitStatic(text: string) { lines.push(text) } } as unknown as TuiApp
  registerRepairPrefixCommand(app, { agent: f.agent, cwd: f.root } as BootstrapContext)
  const invoke = (input: string) => command.handler({ app, input, trimmed: input })
  await invoke('/repair-prefix --rescue-confirm invalid')
  assert.match(lines.at(-1)!, /预览不存在/)
  await invoke('/repair-prefix --rescue')
  const hash = lines.at(-1)!.match(/--rescue-confirm ([a-f0-9]{64})/)?.[1]
  assert.ok(hash)
  assert.match(lines.at(-1)!, /可能有缺失/)
  await invoke(`/repair-prefix --rescue-confirm ${hash}`)
  const target = lines.at(-1)!.match(/\/resume ([a-f0-9-]{36})/)?.[1]
  assert.ok(target)
  const child = new SessionPersist(target, f.root)
  assert.equal(child.readFrozenSnapshot(), undefined)
  assert.equal(child.loadOai().length, 1)
  assert.equal(child.loadOai()[0]!.role, 'user')
  await invoke(`/repair-prefix --rescue-confirm ${hash}`)
  assert.match(lines.at(-1)!, new RegExp(target))
  assert.deepEqual(readFileSync(f.persist.getFilePath()), original)
  assert.equal(f.bodies.length, sends)
})
