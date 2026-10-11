/**
 * TokenLedgerService 测试：同步编排（refresh→digest 判重→推送→回执）、
 * 配置/env 解析、autoSync 开关。fetch 注入打桩，不出网。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema, type Config } from '../../config/schema.js'
import { TokenLedgerService } from '../service.js'
import type { FetchLike } from '../forum-sync.js'

const T0 = Date.parse('2026-10-10T10:00:00')
const tmpRoots: string[] = []

after(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeConfig(tokenLedger?: Record<string, unknown>): Config {
  return configSchema.parse({
    provider: { default: 'deepseek', providers: {} },
    ...(tokenLedger ? { tokenLedger } : {}),
  })
}

function setup(name: string, tokenLedger?: Record<string, unknown>) {
  const base = mkdtempSync(join(tmpdir(), `token-ledger-svc-${name}-`))
  tmpRoots.push(base)
  const sessionsRoot = join(base, 'sessions')
  const logDir = join(sessionsRoot, 'proj', 'sess-1')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'cache-log.jsonl')
  writeFileSync(logFile, JSON.stringify({
    t: T0, turn: 1, model: 'deepseek-flash', provider: 'deepseek',
    input: 1000, cacheRead: 800, cacheCreate: 0, output: 100,
  }) + '\n')
  return {
    logFile,
    makeService: (over: { fetchImpl?: FetchLike } = {}) => new TokenLedgerService(makeConfig(tokenLedger), {
      statePath: join(base, 'ledger.json'),
      sessionsRoot,
      now: () => T0 + 86_400_000,
      ...over,
    }),
  }
}

function okFetch(calls: Array<{ body?: string }>): FetchLike {
  return async (_url, init) => {
    calls.push({ body: init?.body })
    return { status: 200, text: async () => '{}' }
  }
}

test('未配置 endpoint：syncNow 跳过 no_endpoint，refresh 仍执行', async () => {
  const fx = setup('no-endpoint')
  const svc = fx.makeService()
  const outcome = await svc.syncNow()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.skipped, 'no_endpoint')
  assert.equal(outcome.newRows, 1) // 本地台账照常被折叠
  assert.equal(svc.status().totals.requests, 1)
})

test('推送成功：载荷上达、回执落盘、pending 翻转', async () => {
  const fx = setup('push-ok', { forum: { endpoint: 'https://forum.example.com/api/token-usage', apiKey: 'k' } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })

  const outcome = await svc.syncNow()
  assert.equal(outcome.ok, true)
  assert.equal(outcome.newRows, 1)
  assert.equal(calls.length, 1)

  const body = JSON.parse(calls[0]!.body ?? '{}')
  assert.equal(body.version, 1)
  assert.equal(body.totals.requests, 1)
  assert.equal(body.days[0].date, '2026-10-10')

  const status = svc.status()
  assert.equal(status.pending, false)
  assert.equal(status.endpointConfigured, true)
  assert.ok(status.lastPushAt)
  assert.equal(status.lastPushResult?.ok, true)
})

test('无变更不重复推送；新增行后再次推送', async () => {
  const fx = setup('dedupe-push', { forum: { endpoint: 'https://forum.example.com/x' } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })

  await svc.syncNow()
  assert.equal(calls.length, 1)

  const again = await svc.syncNow()
  assert.equal(again.skipped, 'unchanged')
  assert.equal(calls.length, 1)

  appendFileSync(fx.logFile, JSON.stringify({
    t: T0, turn: 2, model: 'deepseek-flash', provider: 'deepseek',
    input: 500, cacheRead: 0, cacheCreate: 0, output: 50,
  }) + '\n')
  const third = await svc.syncNow()
  assert.equal(third.ok, true)
  assert.equal(third.skipped, undefined)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1]!.body ?? '{}').totals.requests, 2)
})

test('推送失败：不钉摘要、pending 保持、下次重推（幂等累计快照）', async () => {
  const fx = setup('push-fail', { forum: { endpoint: 'https://forum.example.com/x' } })
  let failing = true
  const fetchImpl: FetchLike = async () => ({
    status: failing ? 500 : 200,
    text: async () => '{}',
  })
  const svc = fx.makeService({ fetchImpl })

  // 客户端自带一次重试，整趟（含重试）持续 500 才算本趟失败
  const first = await svc.syncNow()
  assert.equal(first.ok, false)
  assert.equal(svc.status().pending, true)
  assert.equal(svc.status().lastPushResult?.ok, false)

  failing = false
  const second = await svc.syncNow()
  assert.equal(second.ok, true)
  assert.equal(svc.status().pending, false)
})

test('RIVET_FORUM_API env 覆盖 config endpoint', async () => {
  const prev = process.env.RIVET_FORUM_API
  process.env.RIVET_FORUM_API = 'https://env-forum.example.com/push'
  try {
    const fx = setup('env-override')
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url)
      return { status: 200, text: async () => '{}' }
    }
    const svc = fx.makeService({ fetchImpl })
    const outcome = await svc.syncNow()
    assert.equal(outcome.ok, true)
    assert.deepEqual(seen, ['https://env-forum.example.com/push'])
  } finally {
    if (prev === undefined) delete process.env.RIVET_FORUM_API
    else process.env.RIVET_FORUM_API = prev
  }
})

test('enabled=false：refresh 与 syncNow 都短路', async () => {
  const fx = setup('disabled', { enabled: false, forum: { endpoint: 'https://x.example.com' } })
  const svc = fx.makeService()
  const refresh = await svc.refresh()
  assert.equal(refresh.newRows, 0)
  const outcome = await svc.syncNow()
  assert.deepEqual(outcome, { ok: false, skipped: 'disabled' })
  assert.equal(svc.status().totals.requests, 0)
})

test('startAutoSync：缺 endpoint 或 autoSync!=true 不启动；齐全才启动', async () => {
  const noEndpoint = setup('auto-1').makeService()
  assert.equal(noEndpoint.startAutoSync(), false)

  const noAuto = setup('auto-2', { forum: { endpoint: 'https://x.example.com' } }).makeService()
  assert.equal(noAuto.startAutoSync(), false)

  const full = setup('auto-3', { forum: { endpoint: 'https://x.example.com', autoSync: true, intervalMinutes: 60 } }).makeService()
  assert.equal(full.startAutoSync(), true)
  assert.equal(full.status().autoSync, true)
  assert.equal(full.startAutoSync(), false) // 幂等：已启动不重复建定时器
  full.stopAutoSync()
  assert.equal(full.status().autoSync, false)
})

test('shutdownFlush：autoSync 运行时推最后一趟且限时返回', async () => {
  const fx = setup('flush', { forum: { endpoint: 'https://x.example.com', autoSync: true, intervalMinutes: 60 } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })
  svc.startAutoSync()
  const started = Date.now()
  await svc.shutdownFlush(2_000)
  assert.ok(Date.now() - started < 2_000)
  assert.equal(calls.length, 1)
  assert.equal(svc.status().autoSync, false)
})
