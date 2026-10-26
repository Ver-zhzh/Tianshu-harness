import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { createFileRepairStore } from '../../agent/file-repair-store.js'
import { WorkProgressFacts } from '../../agent/work-progress-facts.js'

test('retained structural damage drives persistent repair, not reads or repeated callbacks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'repair-facts-')), previous = process.env.RIVET_SESSION_DIR, guard = process.env.RIVET_WRITE_OVERWRITE_GUARD
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
  const store = createFileRepairStore(cwd, 'owner')
  const facts = new WorkProgressFacts({ cwd, config: { sessionId: 'owner' }, modelObservationTurn: 1 } as any)
  try {
    writeFileSync(join(cwd, 'a.json'), '{"a":1}')
    for (const id of ['bad-1', 'bad-2']) {
      const result = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'owner', toolUseId: id, input: { file_path: 'a.json', content: '{' + id }, hasWriteClaim: () => false })
      assert.equal(result.isError, true)
      assert.equal(result.mutations?.length, 1)
      const [fact] = result.mutations!
      assert.equal(fact!.before.parse, id === 'bad-1' ? 'valid' : 'invalid'); assert.equal(fact!.after.parse, 'invalid')
      assert.equal(fact!.attemptedParse, 'invalid'); assert.equal(fact!.restoration, 'conflict')
      assert.equal(readFileSync(join(cwd, 'a.json'), 'utf8'), '{' + id)
      store.record(result.mutations!)
      store.record(result.mutations!)
    }
    assert.equal(store.list()[0]!.failures, 2)
    assert.equal(store.list()[0]!.state, 'active')
    assert.equal(facts.hasActiveRepair(), true)
    facts.recordFileProgress({ outcome: 'changed', targets: ['a.json'] })
    assert.equal(facts.progressRevision, 0, 'broken repair must not earn progress credit')
    assert.equal(createFileRepairStore(cwd, 'other').list().length, 0)
    const fixed = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'owner', toolUseId: 'fixed', input: { file_path: 'a.json', content: '{"a":2}' }, hasWriteClaim: () => true })
    store.record(fixed.mutations!)
    assert.equal(store.list()[0]!.state, 'recovered'); assert.equal(facts.hasActiveRepair(), false)
    const preexisting = { ...fixed.mutations![0]!, toolCallId: 'preexisting', file: 'old.json', before: { version: 'old', parse: 'invalid' as const }, after: { version: 'new', parse: 'invalid' as const }, attemptedParse: 'invalid' as const }
    store.record([preexisting]); assert.equal(store.list().some(f => f.file === 'old.json'), false)
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    if (guard === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD; else process.env.RIVET_WRITE_OVERWRITE_GUARD = guard
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('successful exact rollback is structural recovery and never becomes an active repair gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rollback-recovered-')), guard = process.env.RIVET_WRITE_OVERWRITE_GUARD
  process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
  try {
    const store = createFileRepairStore(cwd, 'rollback-owner'), facts = new WorkProgressFacts({ cwd, config: { sessionId: 'rollback-owner' }, modelObservationTurn: 1 } as any)
    writeFileSync(join(cwd, 'a.json'), '{"a":1}')
    for (const toolUseId of ['one', 'two']) {
      const result = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'rollback-owner', toolUseId, input: { file_path: 'a.json', content: '{bad' }, hasWriteClaim: () => true })
      assert.equal(result.mutations![0]!.restoration, 'restored')
      store.record(result.mutations!)
    }
    assert.equal(store.list()[0]!.state, 'recovered'); assert.equal(facts.hasActiveRepair(), false)
  } finally { if (guard === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD; else process.env.RIVET_WRITE_OVERWRITE_GUARD = guard; rmSync(cwd, { recursive: true, force: true }) }
})

test('a restarted session sees the same active repair without replaying mutations', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'repair-restart-')), previous = process.env.RIVET_SESSION_DIR, guard = process.env.RIVET_WRITE_OVERWRITE_GUARD
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
  try {
    const store = createFileRepairStore(cwd, 'restart-owner')
    writeFileSync(join(cwd, 'a.json'), '{"a":1}')
    for (const id of ['bad-1', 'bad-2']) {
      const result = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'restart-owner', toolUseId: id, input: { file_path: 'a.json', content: '{' + id }, hasWriteClaim: () => false })
      store.record(result.mutations!)
    }
    assert.equal(store.list()[0]!.state, 'active')
    const restarted = new WorkProgressFacts({ cwd, config: { sessionId: 'restart-owner' }, modelObservationTurn: 1 } as any)
    assert.equal(restarted.hasActiveRepair(), true, '重启后的新实例必须读到同一事实源')
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    if (guard === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD; else process.env.RIVET_WRITE_OVERWRITE_GUARD = guard
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('resolving the repair in the store releases the reminder gate immediately', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'repair-resolve-')), previous = process.env.RIVET_SESSION_DIR, guard = process.env.RIVET_WRITE_OVERWRITE_GUARD
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
  try {
    const store = createFileRepairStore(cwd, 'resolve-owner')
    const facts = new WorkProgressFacts({ cwd, config: { sessionId: 'resolve-owner' }, modelObservationTurn: 1 } as any)
    writeFileSync(join(cwd, 'a.json'), '{"a":1}')
    for (const id of ['bad-1', 'bad-2']) {
      const result = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'resolve-owner', toolUseId: id, input: { file_path: 'a.json', content: '{' + id }, hasWriteClaim: () => false })
      store.record(result.mutations!)
    }
    assert.equal(facts.hasActiveRepair(), true)
    store.resolve('a.json', 'deferred', '等待用户确认')
    assert.equal(facts.hasActiveRepair(), false, '解绑只写 store 一次即可生效')
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    if (guard === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD; else process.env.RIVET_WRITE_OVERWRITE_GUARD = guard
    rmSync(cwd, { recursive: true, force: true })
  }
})
