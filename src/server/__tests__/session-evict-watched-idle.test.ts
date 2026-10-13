import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RuntimeSessionManager,
  type ManagedAgent,
} from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/** 照抄 src/server/__tests__/session-manager.test.ts 的 FakeAgent（同一契约：
 *  run 挂起到 finish()，callbacks 暴露给用例直接驱动事件）。 */
class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  aborted = false
  artifacts: Artifact[] = []
  /** Rewind: in-memory message store for testing. */
  messages: OaiMessage[] = []
  /** S — captures the mode this agent was built with + any live switches. */
  builtApprovalMode?: string
  liveApprovalMode?: string
  /** 每次 run 收到的 prompt，按序记录（含自动续跑注入的 'continue'）。 */
  prompts: string[] = []
  /** 累计用量快照——只有显式设值的用例才会让「中断补发」事件出现（默认
   *  undefined，避免给既有用例的事件流凭空多一条 turn_complete）。 */
  usageSnapshot?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  usageTurns = 0
  getTotalUsage() { return this.usageSnapshot ?? {} }
  getTurnCount() { return this.usageTurns }
  /** 实时上下文占用（默认 0 = 不携带，避免扰动既有用例的事件形状）。 */
  estimatedTokens = 0
  getEstimatedTokens() { return this.estimatedTokens }
  private resolveRun?: () => void

  run(prompt: string, cb: AgentCallbacks): Promise<void> {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  finish(): void { this.resolveRun?.() }
  abort(): void {
    this.aborted = true
    this.callbacks?.onAbort()
    this.resolveRun?.()
  }
  /** 模拟 agent 内部 watchdog 自中止：带 reason 的 onAbort + run settle。
   *  与 abort()（用户中止，无 reason）区分——manager.abort 不走这条路。 */
  watchdogAbort(reason = 'watchdog:goal'): void {
    this.callbacks?.onAbort(reason)
    this.resolveRun?.()
  }
  /** 模拟流错误（超时/网络）终结本 run：onError + onStreamInterrupted + run settle。
   *  区别于 abort()（用户中止→aborted）与 finish()（成功→completed）。 */
  streamInterrupt(message = 'Request timed out: server did not respond within 45 seconds'): void {
    const err = new Error(message)
    this.callbacks?.onError(err)
    this.callbacks?.onStreamInterrupted?.(err)
    this.resolveRun?.()
  }
  setApprovalMode(mode: string): void { this.liveApprovalMode = mode }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(id: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null)
  }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  /** P0-2: optional — plan_task onToolResult reads this to emit todo_state */
  getTodos?: () => Array<{ id: string; content: string; status: string }>
}

/**
 * issue #445 / PR #447 返工：watched-idle 淘汰差集。
 *
 * evictLoadedBeyondCap 在 LRU 超出 maxLoadedSessions 时淘汰日志，但此前对
 * 「被观察（listeners>0）且空闲」的会话一律跳过——长生命周期 SSE 标签页会把
 * 完整内存环永久钉住（内存泄漏）。修复后：被观察会话一旦静置超过 idleAgentTtlMs
 * 就与普通未观察会话一样可淘汰（事件已落盘，重连走 getEvents→ensureEvents 从
 * 磁盘重放，不丢事件）；idleAgentTtlMs<=0 关闭该路径，保持旧的「被观察永不淘汰」。
 */
function makeEvictManager(ttlMs: number) {
  const root = mkdtempSync(join(tmpdir(), 'evict-watched-'))
  let now = 1_000_000
  const agents: FakeAgent[] = []
  const persistence = new FileSessionPersistence(join(root, 'sessions'))
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a as any },
    defaultCwd: join(root, 'work'),
    persistence,
    maxLoadedSessions: 2,
    idleAgentTtlMs: ttlMs,
    watchdogContinueDelayMs: 0,
    now: () => now,
  })
  return {
    root,
    manager,
    agents,
    persistence,
    advance: (ms: number) => { now += ms },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

/** 内部状态探针：仓内既有用例同样用 as any 触达 InternalSession。 */
const sessionOf = (
  manager: RuntimeSessionManager,
  id: string,
): { eventsLoaded: boolean; events: Array<{ type: string; data: unknown }> } =>
  (manager as unknown as { sessions: Map<string, never> }).sessions.get(id) as never

test('超 TTL 的被观察会话被淘汰且事件可从磁盘重放', async () => {
  const f = makeEvictManager(1000)
  try {
    // 1. 建一个跑过又静置的会话，且被观察（SSE listener）。
    const rec = f.manager.createSession({ prompt: 'task one' })
    const agent = f.agents[0]!
    agent.callbacks!.onDelegationActivity!({
      workOrderId: 'w1',
      status: 'completed',
      parentToolId: 'tool',
      progressLine: 'DATA-ONE',
    })
    agent.finish()
    await f.manager.waitForRunSettled(rec.id)
    const unsub = f.manager.subscribe(rec.id, () => {})
    assert.ok(unsub, 'subscribe 必须返回 unsubscribe')

    // 2. 事件已落到磁盘（淘汰后的重放源）。事件写链是异步排空的，
    // 同步 flushSync 覆盖不了在途写链——用 flushThrough 等到磁盘高水位
    // ≥ 内存最新 seq（pr353 同款模式），再断言落盘。
    await f.persistence.flushThrough(rec.id, f.manager.getReplayWindow(rec.id)!.diskLastSeq)
    assert.ok(
      f.persistence.loadEvents(rec.id).some(
        (e) => e.type === 'delegation' && (e.data as any).workerId === 'w1',
      ),
      'delegation 事件必须先落盘',
    )

    // 3. 静置超过 TTL，sweep 释放已建 agent：会话变为无 agent、未运行、被观察、超 TTL。
    f.advance(1001)
    f.manager.sweepIdleAgents()

    // 4. 制造 LRU 溢出：loadedOrder=[s1,s2,s3] 长度 3 > maxLoadedSessions 2。
    f.manager.createSession({})
    const s3 = f.manager.createSession({})
    f.manager.getEvents(s3.id) // 触发 ensureEvents → touchLoaded → evictLoadedBeyondCap

    // 5. 超 TTL 的被观察会话必须被淘汰。
    assert.equal(sessionOf(f.manager, rec.id).eventsLoaded, false, 'watched-idle 超 TTL 必须淘汰')
    assert.equal(sessionOf(f.manager, rec.id).events.length, 0)

    // 6. 淘汰后从磁盘重放，事件无丢失。
    const replayed = f.manager.getEvents(rec.id)!
    assert.ok(
      replayed.events.some((e) => e.type === 'delegation' && (e.data as any).workerId === 'w1'),
      '淘汰后重放不得丢失 delegation 事件',
    )
    assert.equal(sessionOf(f.manager, rec.id).eventsLoaded, true, '重放后回到内存常驻')

    unsub!()
  } finally {
    f.cleanup()
  }
})

test('未超 TTL 的被观察会话不淘汰', async () => {
  const f = makeEvictManager(60_000)
  try {
    const s1 = f.manager.createSession({})
    const unsub = f.manager.subscribe(s1.id, () => {})

    const s2 = f.manager.createSession({})
    const s3 = f.manager.createSession({})
    f.manager.getEvents(s3.id)

    // 被观察且未超 TTL：必须跳过、保留在内存。
    assert.equal(sessionOf(f.manager, s1.id).eventsLoaded, true, '被观察且未超 TTL 不得淘汰')
    // 对照：淘汰逻辑确实跑了——淘汰的是无观察的 LRU 会话。
    assert.equal(sessionOf(f.manager, s2.id).eventsLoaded, false, '无观察的 LRU 会话应被淘汰')

    unsub!()
  } finally {
    f.cleanup()
  }
})

test('idleAgentTtlMs<=0 时被观察会话永不淘汰', async () => {
  const f = makeEvictManager(0)
  try {
    const s1 = f.manager.createSession({})
    const unsub = f.manager.subscribe(s1.id, () => {})

    // 远超任何 TTL，模拟长静置。
    f.advance(3_600_000)

    const s2 = f.manager.createSession({})
    const s3 = f.manager.createSession({})
    f.manager.getEvents(s3.id)

    // ttl<=0 时 watched-idle 淘汰路径关闭，永不淘汰被观察会话。
    assert.equal(sessionOf(f.manager, s1.id).eventsLoaded, true, 'ttl<=0 时被观察会话永不淘汰')
    // 对照：淘汰逻辑仍在跑（淘汰无观察会话）。
    assert.equal(sessionOf(f.manager, s2.id).eventsLoaded, false, '无观察的 LRU 会话应被淘汰')

    unsub!()
  } finally {
    f.cleanup()
  }
})

test('watched history without a persistence reader remains resident after TTL', () => {
  let now = 1000
  const manager = new RuntimeSessionManager({ createAgent: () => new FakeAgent() as any,
    now: () => now, idleAgentTtlMs: 100, maxLoadedSessions: 2, externalScanMs: 0 })
  const target = manager.createSession({})
  const before = manager.getEvents(target.id)!.events
  const unsubscribe = manager.subscribe(target.id, () => {})!
  try {
    now += 101
    manager.createSession({})
    const last = manager.createSession({})
    manager.getEvents(last.id)
    assert.equal(sessionOf(manager, target.id).eventsLoaded, true)
    assert.deepEqual(manager.getEvents(target.id)!.events, before)
  } finally { unsubscribe() }
})

test('evicted watched viewers receive external progress without retaining an untracked ring', async () => {
  const f = makeEvictManager(100)
  try {
    const target = f.manager.createSession({})
    const received: number[] = []
    const unsubscribe = f.manager.subscribe(target.id, event => { if (event.type === 'text_delta') received.push(event.seq) })!
    const initial = f.manager.getEvents(target.id)!.lastSeq
    await f.persistence.flushThrough(target.id, initial)
    f.advance(101)
    f.manager.createSession({})
    const last = f.manager.createSession({})
    f.manager.getEvents(last.id)
    assert.equal(sessionOf(f.manager, target.id).eventsLoaded, false)
    for (let step = 1; step <= 4; step++) {
      const seq = initial + step
      f.persistence.appendEvent(target.id, { seq, ts: 1_001_000 + step, type: 'text_delta', data: { text: `external-${step}` } })
      await f.persistence.flushThrough(target.id, seq)
      await Promise.all((f.manager as unknown as { adoptExternalSessions(): Promise<void>[] }).adoptExternalSessions())
      assert.deepEqual(received, Array.from({ length: step }, (_, index) => initial + index + 1))
      assert.equal(sessionOf(f.manager, target.id).eventsLoaded, false)
      assert.equal(sessionOf(f.manager, target.id).events.length, 0, 'live progress must not accumulate outside the LRU')
    }
    const replay = await f.manager.getEventsAsync(target.id)
    assert.equal(replay!.events.filter(event => event.type === 'text_delta').length, 4)
    assert.equal(replay!.lastSeq, initial + 4)
    unsubscribe()
  } finally { f.cleanup() }
})

for (const asyncRead of [false, true]) {
  test(`just opened watched history survives ${asyncRead ? 'async' : 'sync'} pressure from protected viewers`, async () => {
    const f = makeEvictManager(100)
    try {
      const target = f.manager.createSession({})
      const unsubscribe = f.manager.subscribe(target.id, () => {})!
      f.persistence.appendEvent(target.id, { seq: 1, ts: 1_000_000, type: 'text_delta', data: { text: 'persisted-history' } })
      await f.persistence.flushThrough(target.id, 1)
      f.advance(101)
      const second = f.manager.createSession({})
      const unsubscribeSecond = f.manager.subscribe(second.id, () => {})!
      const third = f.manager.createSession({})
      const unsubscribeThird = f.manager.subscribe(third.id, () => {})!
      f.manager.getEvents(third.id)
      assert.equal(sessionOf(f.manager, target.id).eventsLoaded, false)
      const replay = asyncRead ? await f.manager.getEventsAsync(target.id) : f.manager.getEvents(target.id)
      assert.ok(replay!.events.some(event => event.data.text === 'persisted-history'))
      assert.equal(sessionOf(f.manager, target.id).eventsLoaded, true)
      unsubscribe(); unsubscribeSecond(); unsubscribeThird()
    } finally { f.cleanup() }
  })
}
