import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../config/schema.js'
import { TokenLedgerService } from '../service.js'
import { pushTokenUsageSnapshot } from '../forum-sync.js'
import type { TokenUsageSnapshot } from '../types.js'

const snapshot: TokenUsageSnapshot = { version: 1, deviceId: 'cooldown-fixture', deviceName: 'Fixture', sentAt: '2026-10-17T00:00:00.000Z', totals: { requests: 1, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0 }, days: [] }

test('429 Retry-After prevents an immediate transport retry', async () => {
  let calls = 0
  const result = await pushTokenUsageSnapshot(snapshot, {
    endpoint: 'https://ledger.example.test/v1/token-usage', retries: 1, backoffMs: 0,
    fetchImpl: async () => { calls++; return { status: 429, headers: new Headers({ 'retry-after': '120' }), text: async () => '{}' } },
  })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.equal((result as { retryAfterMs?: number }).retryAfterMs, 120_000)
})

test('service failures back off across sync calls without confirming or discarding local usage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-cooldown-'))
  let now = Date.parse('2026-10-17T00:00:00.000Z'), calls = 0
  const sessions = join(directory, 'sessions')
  mkdirSync(join(sessions, 'project', 'session'), { recursive: true })
  writeFileSync(join(sessions, 'project', 'session', 'cache-log.jsonl'), JSON.stringify({ t: now, turn: 1, model: 'fixture', input: 10, output: 1, cacheRead: 0, cacheCreate: 0 }) + '\n')
  const config = configSchema.parse({ provider: { default: 'fixture', providers: {} }, tokenLedger: { forum: { apiKey: 'fixture-key' } } })
  const service = new TokenLedgerService(config, {
    statePath: join(directory, 'ledger.json'), sessionsRoot: sessions, now: () => now,
    fetchImpl: async () => { calls++; return { status: calls > 2 ? 200 : 503, text: async () => '{"ok":true,"stale":false}' } },
  })
  try {
    assert.equal((await service.syncNow()).ok, false)
    const firstCalls = calls
    assert.ok(firstCalls <= 2)
    assert.equal((await service.syncNow()).skipped, 'backoff')
    assert.equal(calls, firstCalls)
    assert.equal(service.status().pending, true)
    assert.equal(service.status().totals.requests, 1)
    now += 120_000
    await service.syncNow()
    assert.ok(calls > firstCalls)
  } finally { service.stopAutoSync(); rmSync(directory, { recursive: true, force: true }) }
})
