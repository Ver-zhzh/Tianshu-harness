/**
 * TokenLedgerStore 测试：折叠口径、增量游标、截断失效方向、落盘重建。
 * 夹具统一 mkdtemp（仓库外）；每个用例独立的 sessionsRoot/statePath，
 * cache-log 行形态对齐 loop-factory recordTurnCache。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenLedgerStore, ledgerDigest } from '../store.js'
import type { PricingResolver } from '../../cache/usage-aggregator.js'

const T0 = Date.parse('2026-10-10T10:00:00')
const tmpRoots: string[] = []

after(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mainRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: T0, turn: 1, model: 'deepseek-flash', provider: 'deepseek',
    input: 1000, cacheRead: 800, cacheCreate: 0, output: 100, hitRate: 80,
    ...over,
  })
}

function sidePathRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'side_path', kind: 'speculation', t: T0, model: 'deepseek-flash', provider: 'deepseek',
    input: 200, cacheRead: 0, cacheCreate: 0, output: 50, ...over,
  })
}

function setup(name: string, resolvePricing?: PricingResolver) {
  const base = mkdtempSync(join(tmpdir(), `token-ledger-${name}-`))
  tmpRoots.push(base)
  const sessionsRoot = join(base, 'sessions')
  return {
    sessionsRoot,
    statePath: join(base, 'ledger.json'),
    makeStore: () => new TokenLedgerStore({
      statePath: join(base, 'ledger.json'),
      sessionsRoot,
      ...(resolvePricing ? { resolvePricing } : {}),
      now: () => T0 + 86_400_000,
    }),
  }
}

function writeLog(sessionsRoot: string, relDir: string, lines: string[]): string {
  const dir = join(sessionsRoot, relDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cache-log.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

test('折叠口径：主行 + side_path + retry 计入，非计费行与坏行丢弃', async () => {
  const fx = setup('fold')
  writeLog(fx.sessionsRoot, 'proj-a/sess-1', [
    mainRow(),
    sidePathRow(),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'deepseek-flash', provider: 'deepseek', requestId: 'r1', attemptId: 'a1', input: 500, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'reclaim_decision', t: T0, decided: true }),   // 非计费行
    'not json at all',
  ])

  const store = fx.makeStore()
  const { newRows } = await store.refresh()
  assert.equal(newRows, 3)

  const totals = store.totals()
  assert.equal(totals.requests, 3)
  assert.equal(totals.input, 1000 + 200 + 500)
  assert.equal(totals.output, 150)
  assert.equal(totals.cacheRead, 800)
  assert.equal(totals.cost, 0) // 未注入定价 → 0，不硬造数字

  const records = store.records()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.date, '2026-10-10')
  assert.equal(records[0]!.model, 'deepseek-flash')
  assert.equal(records[0]!.provider, 'deepseek')
})

test('同 attempt 重复行只计一次；无 id 行不去重', async () => {
  const fx = setup('dedupe')
  writeLog(fx.sessionsRoot, 'sess-1', [
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', requestId: 'r1', attemptId: 'a1', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', requestId: 'r1', attemptId: 'a1', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
  ])
  const store = fx.makeStore()
  await store.refresh()
  // 同 (requestId, attemptId) 两行去重计 1，无 id 行不参与去重计 1 → 共 2 行
  assert.equal(store.totals().requests, 2)
  assert.equal(store.totals().input, 200)
})

test('增量游标：重复 refresh 不重算，追加后只折叠新行', async () => {
  const fx = setup('incremental')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()

  await store.refresh()
  assert.equal(store.totals().requests, 1)

  await store.refresh() // 无新增
  assert.equal(store.totals().requests, 1)

  appendFileSync(file, mainRow({ turn: 2, input: 2000 }) + '\n')
  const { newRows } = await store.refresh()
  assert.equal(newRows, 1)
  assert.equal(store.totals().requests, 2)
  assert.equal(store.totals().input, 3000)
})

test('截断失效方向：文件缩小时不重算旧行（宁可少算）', async () => {
  const fx = setup('truncate')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ input: 1000 }), mainRow({ input: 1000, turn: 2 })])
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().input, 2000)

  // 截断（模拟日志被外部清理）：旧行已折叠过，绝不重计
  truncateSync(file, JSON.stringify(mainRow({ input: 9999 })).length + 1)
  await store.refresh()
  assert.equal(store.totals().input, 2000) // 不变：没有 9999，也没有重复 1000

  // 截断后的新追加从新区间继续，正常计入
  appendFileSync(file, '\n' + mainRow({ input: 7, turn: 9 }) + '\n')
  await store.refresh()
  assert.equal(store.totals().input, 2007)
})

test('落盘重建：新实例继承 deviceId / 游标 / 累计，不从零重扫', async () => {
  const fx = setup('persist')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store1 = fx.makeStore()
  await store1.refresh()
  const deviceId = store1.deviceId
  assert.ok(existsSync(fx.statePath))

  const store2 = fx.makeStore()
  assert.equal(store2.deviceId, deviceId)
  assert.equal(store2.totals().requests, 1)
  const { newRows } = await store2.refresh() // 游标已在 EOF，不重扫
  assert.equal(newRows, 0)
  assert.equal(store2.totals().requests, 1)
})

test('定价注入：按行折叠 cost；缺定价落 0', async () => {
  const fx = setup('pricing', () => ({ input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 }))
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ input: 1_000_000, cacheRead: 500_000, output: 100_000 })])
  const store = fx.makeStore()
  await store.refresh()
  // 未命中 input 500k×2/M=1 + output 100k×8/M=0.8 + cacheRead 500k×0.04/M=0.02
  assert.equal(store.totals().cost, 1.82)
})

test('markPushed 仅 2xx 钉摘要；回执随状态落盘', async () => {
  const fx = setup('digest')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  const digest = store.digest()
  assert.notEqual(digest, ledgerDigest({}))
  assert.equal(store.digest(), digest)

  store.markPushed({ ok: false, code: 'network', error: 'boom' })
  assert.equal(store.lastPushedDigest, undefined)
  assert.equal(store.lastPushResult?.ok, false)

  store.markPushed({ ok: true, status: 200 })
  assert.equal(store.lastPushedDigest, digest)
  assert.equal(store.lastPushResult?.ok, true)
  assert.ok(store.lastPushAt)

  const store2 = fx.makeStore()
  assert.equal(store2.lastPushedDigest, digest)
})

test('snapshot 形状：version/deviceId/sentAt/totals/days 齐全且为累计语义', async () => {
  const fx = setup('snapshot')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow(), sidePathRow()])
  const store = fx.makeStore()
  await store.refresh()
  const snap = store.snapshot('test-machine')
  assert.equal(snap.version, 1)
  assert.equal(snap.deviceId, store.deviceId)
  assert.equal(snap.deviceName, 'test-machine')
  assert.equal(snap.sentAt, new Date(T0 + 86_400_000).toISOString())
  assert.equal(snap.days.length, 1)
  assert.equal(snap.totals.requests, 2)
  assert.equal(snap.totals.input, 1200)

  // 快照必须可被 JSON 安全序列化（论坛契约）
  const parsed = JSON.parse(JSON.stringify(snap))
  assert.equal(parsed.days[0].model, 'deepseek-flash')
})

test('状态文件损坏：从空台账重建并全量重扫恢复', async () => {
  const fx = setup('corrupt')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  writeFileSync(fx.statePath, '{broken json')
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().requests, 1)
  assert.ok(store.deviceId)
  // 重建后状态文件被修复为合法 JSON
  assert.ok(JSON.parse(readFileSync(fx.statePath, 'utf8')).deviceId)
})
