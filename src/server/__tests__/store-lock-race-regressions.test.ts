import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { StoreLock, type LockInfo } from '../store-lock.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'store-lock-race-'))
  const path = join(dir, 'sidecar.lock')
  const holder: LockInfo = { pid: process.ppid, hostname: hostname(), acquiredAt: new Date().toISOString(), ownerToken: 'old-owner', startedAtMs: 1 }
  return { dir, path, holder }
}

test('main lock replaced during the second identity probe is preserved', async () => {
  const { dir, path, holder } = fixture()
  const replacement = { ...holder, ownerToken: 'new-owner', startedAtMs: Date.now() }
  let probes = 0
  const lock = new StoreLock({ lockPath: path, legacyWriterLockPaths: [], processStartMs: async () => {
    if (++probes === 2) writeFileSync(path, JSON.stringify(replacement))
    return Date.now()
  } })
  try {
    writeFileSync(path, JSON.stringify(holder))
    const result = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(result.acquired, false)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ownerToken, replacement.ownerToken)
    assert.equal(existsSync(path + '.reclaim'), false)
  } finally { lock.release(); rmSync(dir, { recursive: true, force: true }) }
})

test('reclaim lock replaced during its identity probe is preserved', async () => {
  const { dir, path, holder } = fixture()
  const replacement = { ...holder, ownerToken: 'new-reclaimer', startedAtMs: Date.now() }
  const lock = new StoreLock({ lockPath: path, legacyWriterLockPaths: [], processStartMs: async () => {
    writeFileSync(path + '.reclaim', JSON.stringify(replacement))
    return Date.now()
  } })
  try {
    writeFileSync(path, JSON.stringify({ ...holder, pid: 999_999_999 }))
    writeFileSync(path + '.reclaim', JSON.stringify(holder))
    const result = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(result.acquired, false)
    assert.equal(JSON.parse(readFileSync(path + '.reclaim', 'utf8')).ownerToken, replacement.ownerToken)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ownerToken, holder.ownerToken)
  } finally { lock.release(); rmSync(dir, { recursive: true, force: true }) }
})

for (const missingStart of [false, true]) {
  test(`unverifiable legacy writer blocks a new writer (missing timestamp=${missingStart})`, async () => {
    const { dir, path, holder } = fixture()
    const legacy = { ...holder, startedAtMs: missingStart ? undefined : Date.now() }
    const lock = new StoreLock({ lockPath: path, processStartMs: async () => undefined })
    try {
      writeFileSync(join(dir, 'scheduled_tasks.lock'), JSON.stringify(legacy))
      const result = await lock.acquire({ retryWindowMs: 0 })
      assert.equal(result.status, 'contended')
      assert.equal(result.acquired, false)
      assert.equal(existsSync(path), false)
    } finally { lock.release(); rmSync(dir, { recursive: true, force: true }) }
  })
}
