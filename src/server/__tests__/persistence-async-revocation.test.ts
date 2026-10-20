import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionRecord, SessionEvent } from '../session-manager.js'

for (const stage of ['mkdir', 'writeFile'] as const) {
  test(`snapshot revocation after ${stage} preserves the new owner record`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'persistence-revoked-'))
    let allowed = true
    let reached = false
    let revokedWrites = 0
    const original = fsPromises[stage]
    t.mock.method(fsPromises, stage, async (...args: unknown[]) => {
      const result = await Reflect.apply(original, fsPromises, args)
      if (String(args[0]).startsWith(join(dir, 's1'))) {
        reached = true
        allowed = false
        writeFileSync(join(dir, 's1', 'index.json'), JSON.stringify({ id: 's1', status: 'new-owner' }))
      }
      return result
    })
    if (stage === 'mkdir') {
      const write = fsPromises.writeFile
      t.mock.method(fsPromises, 'writeFile', async (...args: Parameters<typeof write>) => {
        if (!allowed) revokedWrites++
        return Reflect.apply(write, fsPromises, args)
      })
    }
    syncBuiltinESMExports()
    const p = new FileSessionPersistence(dir, { canWrite: () => allowed })
    try {
      p.saveRecord({ id: 's1', status: 'running', createdAt: 1, updatedAt: 2, cwd: dir, lastSeq: 1, pendingApprovals: 0 } as SessionRecord)
      // Wait for the in-flight writer; revoked flushAllAsync intentionally returns early.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const end = Date.now() + 1000
      while ((p as unknown as { recordWrites: Map<string, { running: boolean }> }).recordWrites.get('s1')?.running && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(reached, true)
      assert.equal(revokedWrites, 0, '撤销后不得再发起临时快照写入')
      assert.equal(JSON.parse(readFileSync(join(dir, 's1', 'index.json'), 'utf8')).status, 'new-owner')
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }) }
  })
}

test('event writer revoked after mkdir cannot append to the new owner log', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'events-revoked-'))
  let allowed = true
  let reached = false
  const original = fsPromises.mkdir
  t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof original>) => {
    const result = await Reflect.apply(original, fsPromises, args)
    if (String(args[0]) === join(dir, 's1')) {
      reached = true
      allowed = false
      writeFileSync(join(dir, 's1', 'events.jsonl'), 'new-owner\n')
    }
    return result
  })
  syncBuiltinESMExports()
  const p = new FileSessionPersistence(dir, { canWrite: () => allowed })
  try {
    p.appendEvent('s1', { seq: 1, ts: 1, type: 'user', data: { text: 'old' } } as SessionEvent)
    await p.flushSessionAsync('s1', 1000)
    assert.equal(reached, true)
    assert.equal(readFileSync(join(dir, 's1', 'events.jsonl'), 'utf8'), 'new-owner\n')
    assert.equal(existsSync(join(dir, 's1', 'events.index.jsonl')), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }) }
})
