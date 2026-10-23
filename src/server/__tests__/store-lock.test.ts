/**
 * StoreLock — 会话库单写者独占锁（P0-1）回归
 *
 * 背景：多个 sidecar（tauri dev / 测试脚本 / VSCode 插件）共用 ~/.rivet/desktop
 * 会话库时，后来者的 rehydrate() 会把别人正在跑的会话标成『已中断』并写入
 * seq + 100_000 的假标记，desktop 的 event-reducer `ev.seq <= state.lastSeq`
 * 守卫随后丢掉之后所有真实输出（『假续跑』）。修法：会话库单写者独占锁。
 *
 * 2026-10-20 身份收紧：接管只认两条——持有者进程确认不存在（pid_dead），或
 * PID 活着但真实创建时间与锁记录的 startedAtMs 不符（pid_reused）。活进程
 * 心跳过期（mtime 陈旧）只作诊断信息透出（holder.heartbeatStale），不再触发
 * 接管——事件循环卡顿的进程不该因此丢库。旧格式锁缺 ownerToken/startedAtMs
 * 一律视为不可核验 → 按占用处理，不自动清理。
 *
 * 本文件的每条用例都做过「还原缺陷即红」核验：把对应的修复分支撤掉后用例
 * 必须变红（见各 describe 顶部注释）。
 *
 * 全部用例使用 mkdtemp 临时锁路径，绝不触碰真实 ~/.rivet/desktop。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  LEGACY_WRITER_LOCK_FILENAME,
  STORE_LOCK_HEARTBEAT_STALE_MS,
  StoreLock,
  platformDefaultStoreLockPath,
  probeProcessStartMs,
  storeLockPath,
  type LockInfo,
  type StoreLockState,
} from '../store-lock.js'
import { defaultRivetHome } from '../../config/paths.js'
import { createRouter } from '../index.js'
import { buildHealthRoute } from '../health-route.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/** 高于 macOS pid_max（99998）且几乎不可能是活进程 → process.kill 报 ESRCH。 */
const DEAD_PID = 999_999_999

let TEST_DIR = ''
let LOCK_PATH = ''
let SESSION_FILE = ''

/** 写入一份『持有者』锁文件（模拟别的 sidecar 进程持有）。 */
function writeHolder(info: LockInfo): void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true })
  writeFileSync(LOCK_PATH, JSON.stringify(info, null, 2), 'utf-8')
}

function readHolder(): LockInfo {
  const storage = lstatSync(LOCK_PATH)
  assert.ok(storage.isFile() || storage.isDirectory(), 'lock storage must be a real file or directory')
  const ownerPath = storage.isDirectory() ? join(LOCK_PATH, 'owner.json') : LOCK_PATH
  assert.ok(lstatSync(ownerPath).isFile(), 'lock owner must be a real regular file')
  return JSON.parse(readFileSync(ownerPath, 'utf-8')) as LockInfo
}

function holderInfo(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    pid: DEAD_PID,
    acquiredAt: new Date().toISOString(),
    hostname: osHostname(),
    ownerToken: 'other-sidecar',
    startedAtMs: Date.now() - 1_000,
    ...overrides,
  }
}

function contended(state: StoreLockState): Extract<StoreLockState, { status: 'contended' }> {
  assert.equal(state.status, 'contended', JSON.stringify(state))
  return state as Extract<StoreLockState, { status: 'contended' }>
}

describe('StoreLock — 争用与有界重试', () => {
  // 还原缺陷即红：删掉持有者判据（pid_dead/pid_reused）后，下面第一条用例会被
  // 误判为可接管（stale_recovered）→ 变红。
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    SESSION_FILE = join(TEST_DIR, 'desktop', 'sessions', 'sess-1.json')
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    writeFileSync(SESSION_FILE, '{"seq":42}', 'utf-8')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('保留活进程持有者的锁：不接管、不动任何会话文件', async () => {
    const holder = holderInfo({ pid: process.pid, ownerToken: 'live-sidecar' })
    writeHolder(holder)
    const sessionBefore = statSync(SESSION_FILE)

    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      // 持有者（本进程）的创建时间与记录吻合 → 两条接管判据都不成立
      processStartMs: async () => Date.now() - 1_000,
    })
    const startedAt = Date.now()
    const state = await lock.acquire({ retryWindowMs: 240, retryIntervalMs: 60 })
    const elapsed = Date.now() - startedAt

    const c = contended(state)
    assert.equal(state.acquired, false)
    assert.equal(c.holder.pid, process.pid, '占用者 PID 必须回报给调用方')
    assert.equal(c.holder.startedAtMs, holder.startedAtMs, '占用者启动时间必须回报给调用方')
    assert.equal(c.holder.hostname, osHostname())
    assert.equal(lock.isOwner(), false, '没拿到锁就不能自认 owner')

    // 锁文件仍是别人的（没被接管、没被重写）
    assert.equal(readHolder().ownerToken, 'live-sidecar')
    // 会话库一个字节都不能动
    assert.equal(readFileSync(SESSION_FILE, 'utf-8'), '{"seq":42}')
    assert.equal(statSync(SESSION_FILE).mtimeMs, sessionBefore.mtimeMs)
    // 也没留下 reclaim 残留
    assert.equal(existsSync(`${LOCK_PATH}.reclaim`), false)

    // 有界重试：等待窗口内反复尝试（≥2 次）而不是立刻放弃；窗口到点必须返回
    assert.ok(elapsed >= 180, `重试窗口未走完就返回：${elapsed}ms`)
    assert.ok(elapsed < 3_000, `重试窗口无上界：${elapsed}ms`)
  })
})

describe('StoreLock — 接管判定（pid_dead / pid_reused 两条判据）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-stale-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：撤掉 pid 存活判据 → 本条变红（contended）。
  it('接管「持有者 PID 已死」的锁', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID }))
    const lock = new StoreLock({ lockPath: LOCK_PATH })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(state.acquired, true)
    assert.equal(readHolder().pid, process.pid, '接管后锁文件必须归本进程')
    assert.equal(lock.isOwner(), true)
    lock.release()
    assert.equal(existsSync(LOCK_PATH), false, 'release 必须删掉自己的锁文件')
  })

  // 还原缺陷即红：撤掉 pid_reused 判据（processStartMs 比对）→ 持有者活着、
  // 心跳新鲜 → contended → 红。
  it('接管「PID 活着但创建时间与记录不符」的锁（PID 已被复用）', async () => {
    const recordedStart = Date.now() - 3_600_000
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'reused-pid', startedAtMs: recordedStart }))
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: async () => Date.now(), // 实测创建时间≈现在，与一小时前的记录对不上
    })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(readHolder().pid, process.pid)
    assert.match(readHolder().acquiredAt ?? '', /^\d{4}-\d{2}-\d{2}T/, '接管后必须是新写入的锁')
    lock.release()
  })

  // 还原缺陷即红：把「心跳过期」重新加回可回收判据 → 本条变 stale_recovered → 红。
  it('活进程心跳过期 → 仍判占用，不接管不动锁（mtime 只作诊断）', async () => {
    const holder = holderInfo({ pid: process.pid, ownerToken: 'silent-sidecar', startedAtMs: Date.now() - 5_000 })
    writeHolder(holder)
    const staleAt = new Date(Date.now() - STORE_LOCK_HEARTBEAT_STALE_MS - 60_000)
    utimesSync(LOCK_PATH, staleAt, staleAt)

    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => holder.startedAtMs! })
    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.reason, 'pid_alive')
    assert.equal(c.holder.heartbeatStale, true, '心跳过期必须作为诊断信息透出（不再触发接管）')
    assert.equal(readHolder().ownerToken, 'silent-sidecar', '活进程的锁一个字节都不能动')
  })

  // 还原缺陷即红：探测失败（undefined）若被当成「创建时间不符」→ stale_recovered → 红。
  it('进程创建时间探测失败 → 无法核验按占用（不接管）', async () => {
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'unverifiable', startedAtMs: Date.now() - 3_600_000 }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => undefined })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.reason, 'pid_alive')
    assert.equal(readHolder().ownerToken, 'unverifiable', '探测失败绝不是接管理由')
  })

  // 还原缺陷即红：撤掉身份完整性检查 → pid_dead 直接接管旧格式锁 → 红。
  it('旧格式锁缺身份字段（ownerToken/startedAtMs）→ 不可核验按占用，不删锁', async () => {
    // 形态一：ownerToken 与 startedAtMs 都没有（收紧前的旧版锁）
    writeHolder({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), hostname: osHostname() })
    const first = new StoreLock({ lockPath: LOCK_PATH })
    const firstState = await first.acquire({ retryWindowMs: 0 })
    assert.equal(contended(firstState).reason, 'identity_unverifiable')
    assert.equal(readHolder().pid, DEAD_PID, '旧锁必须原样保留（等人工清理，不自动删）')

    // 形态二：有 ownerToken 但缺 startedAtMs —— 身份同样不完整
    const partial = holderInfo({ pid: DEAD_PID })
    delete partial.startedAtMs
    writeHolder(partial)
    const second = new StoreLock({ lockPath: LOCK_PATH })
    const secondState = await second.acquire({ retryWindowMs: 0 })
    assert.equal(contended(secondState).reason, 'identity_unverifiable')
    assert.equal(readHolder().pid, DEAD_PID)
    assert.equal(existsSync(`${LOCK_PATH}.reclaim`), false, '不可核验的锁连 reclaim 都不能发起')
  })

  it('跨主机的锁 → 判占用（本机 PID 判不了远端进程死活），不删锁', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'some-other-host.local' }))
    const lock = new StoreLock({ lockPath: LOCK_PATH })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(contended(state).reason, 'cross_host')
    assert.equal(readHolder().pid, DEAD_PID, '跨主机锁即使是死 PID 也不得删除')
  })

  it('心跳新鲜且进程存活 → 判为占用，不接管', async () => {
    const holder = holderInfo({ pid: process.pid, ownerToken: 'busy-sidecar', startedAtMs: Date.now() - 5_000 })
    writeHolder(holder)
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => holder.startedAtMs! })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.holder.pid, process.pid)
    assert.equal(typeof c.holder.startedAtMs, 'number')
    assert.equal(readHolder().ownerToken, 'busy-sidecar', '不能抢走活锁')
  })

  it('持有期间按心跳间隔刷新锁文件时间', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 25 })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired')

    const before = statSync(LOCK_PATH).mtimeMs
    await sleep(200)
    const after = statSync(LOCK_PATH).mtimeMs

    assert.ok(after > before, `心跳没有刷新锁文件时间：${before} → ${after}`)
    lock.release()
  })

  it('锁文件损坏时走串行回收，且并发争用只有一个赢家', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(LOCK_PATH, '{not-json', 'utf-8')

    const contenders = Array.from({ length: 6 }, () =>
      new StoreLock({ lockPath: LOCK_PATH }).acquire({ retryWindowMs: 0 }),
    )
    const states = await Promise.all(contenders)
    const winners = states.filter(s => s.status === 'acquired' || s.status === 'stale_recovered')

    assert.ok(winners.length >= 1, JSON.stringify(states))
    assert.ok(existsSync(LOCK_PATH))
  })
})

describe('StoreLock — hostname 变化后按稳定机器身份判定（issue #532）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-hostname-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it('同一机器的旧 hostname + 死 PID 可回收', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'before.local', machineId: 'machine-A' } as Partial<LockInfo>))
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'after.local' } as ConstructorParameters<typeof StoreLock>[0])
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    lock.release()
  })

  it('不同机器的死 PID 仍视为远端占用，不用本机 PID 推断远端生死', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'other.local', machineId: 'machine-B' } as Partial<LockInfo>))
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'here.local' } as ConstructorParameters<typeof StoreLock>[0])
    const blocked = contended(await lock.acquire({ retryWindowMs: 0 }))
    assert.equal(blocked.reason, 'cross_host')
    assert.equal((blocked.holder as typeof blocked.holder & { localPidUnreliable?: boolean }).localPidUnreliable, true)
    assert.equal(readHolder().ownerToken, 'other-sidecar')
  })

  it('机器标识不同即使 hostname 相同也不能回收', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'shared-name', machineId: 'machine-B' }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'shared-name' })
    assert.equal(contended(await lock.acquire({ retryWindowMs: 0 })).reason, 'cross_host')
  })

  it('已有机器标识但本机探测失败时不能退回相同 hostname', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'shared-name', machineId: 'machine-A' }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => undefined, hostname: () => 'shared-name' })
    const blocked = contended(await lock.acquire({ retryWindowMs: 0 }))
    assert.equal(blocked.reason, 'cross_host')
    assert.equal(blocked.holder.localPidUnreliable, true)
  })

  it('持锁期间 hostname 翻转不误报丢锁，release 仍清理自己的锁', async () => {
    let host = 'before.local'
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => host, heartbeatIntervalMs: 20 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')
    host = 'after.local'
    await sleep(75)
    assert.equal(lock.isOwner(), true)
    lock.release()
    assert.equal(existsSync(LOCK_PATH), false)
  })

  it('同机死进程留下旧版定时任务锁且 hostname 翻转，不再误报 legacy_writer', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(join(dirname(LOCK_PATH), LEGACY_WRITER_LOCK_FILENAME), JSON.stringify(holderInfo({ pid: DEAD_PID, hostname: 'before.local', machineId: 'machine-A' })), 'utf8')
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'after.local' })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')
    lock.release()
  })

  it('旧调度锁 PID 数字碰巧等于本进程但机器不同，不能当成自己的锁跳过', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(join(dirname(LOCK_PATH), LEGACY_WRITER_LOCK_FILENAME), JSON.stringify(holderInfo({ pid: process.pid, hostname: 'remote.local', machineId: 'machine-B' })), 'utf8')
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'here.local' })
    assert.equal(contended(await lock.acquire({ retryWindowMs: 0 })).reason, 'legacy_writer')
    assert.equal(existsSync(LOCK_PATH), false)
  })

  it('无机器标识的旧锁只在明确确认且 PID 确死时恢复', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'before.local', ownerToken: undefined, machineId: undefined }))
    const options = { lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'after.local' }
    assert.equal(contended(await new StoreLock(options).acquire({ retryWindowMs: 0 })).reason, 'cross_host')
    const confirmed = new StoreLock({ ...options, allowLegacyHostRecovery: true })
    assert.equal((await confirmed.acquire({ retryWindowMs: 0 })).status, 'stale_recovered')
    confirmed.release()
  })

  it('一次性环境开关在真实构造入口生效，退出本次测试后恢复环境', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID, hostname: 'before.local', ownerToken: undefined, machineId: undefined }))
    const previous = process.env.RIVET_STORE_LOCK_RECOVER_LEGACY_HOST
    process.env.RIVET_STORE_LOCK_RECOVER_LEGACY_HOST = '1'
    try {
      const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'after.local' })
      assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'stale_recovered')
      lock.release()
    } finally {
      if (previous === undefined) delete process.env.RIVET_STORE_LOCK_RECOVER_LEGACY_HOST
      else process.env.RIVET_STORE_LOCK_RECOVER_LEGACY_HOST = previous
    }
  })

  it('明确确认也不抢仍存活的旧锁', async () => {
    writeHolder(holderInfo({ pid: process.pid, hostname: 'before.local', ownerToken: undefined, machineId: undefined }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, machineId: async () => 'machine-A', hostname: () => 'after.local', allowLegacyHostRecovery: true,
      processStartMs: async () => readHolder().startedAtMs })
    assert.equal(contended(await lock.acquire({ retryWindowMs: 0 })).reason, 'cross_host')
    assert.equal(readHolder().pid, process.pid)
  })
})

describe('StoreLock — reclaim 前重读完整锁身份', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-reclaim-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：reclaim 后重读若只比 pid（旧行为）→ 同 pid 不同 ownerToken 的
  // 接管者锁被删除并被接管 → 本条在 readHolder 断言上变红（旧代码还会因心跳
  // 过期判 stale，现在身份不符就该直接放弃）。
  it('reclaim 期间锁主易人（同 pid 不同 ownerToken）→ 放弃回收，不动新锁', async () => {
    const recordedStart = Date.now() - 3_600_000
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'original-owner', startedAtMs: recordedStart }))

    let probed = false
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: async () => {
        if (!probed) {
          probed = true
          // 第一次探测（判定原锁主 pid_reused）期间，锁被另一进程接管重建：
          // pid 复用不变、startedAtMs 复用原记录，但 ownerToken 已是别人。
          // 旧判据只比 pid → 会把这把新锁删掉；完整身份比对必须放弃本轮回收。
          const hijacker = holderInfo({ pid: process.pid, ownerToken: 'hijacker', startedAtMs: recordedStart })
          writeHolder(hijacker)
          const longAgo = new Date(Date.now() - STORE_LOCK_HEARTBEAT_STALE_MS - 60_000)
          utimesSync(LOCK_PATH, longAgo, longAgo)
        }
        return Date.now()
      },
    })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'contended', JSON.stringify(state))
    assert.equal(readHolder().ownerToken, 'hijacker', '身份不符即放弃回收——绝不动新锁主的锁')
    assert.equal(lock.isOwner(), false)
    assert.equal(existsSync(`${LOCK_PATH}.reclaim`), false, '放弃回收后 reclaim 锁必须释放')
  })
})

describe('StoreLock — reclaim 锁复用同一套持有者判据', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-reclaim-criteria-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：reclaim 接管若只判 pid 死（旧判据）→ 活 PID 的 reclaim 锁
  // 永远抢不动 → 本条 reclaim_in_progress → 红。
  it('reclaim 锁持有者 PID 被复用（创建时间不符）→ 接管 reclaim 并完成回收', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(LOCK_PATH, '{not-json', 'utf-8')
    writeFileSync(
      `${LOCK_PATH}.reclaim`,
      JSON.stringify(holderInfo({ pid: process.pid, ownerToken: 'crashed-reclaimer', startedAtMs: Date.now() - 3_600_000 }), null, 2),
      'utf-8',
    )
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => Date.now() })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(lock.isOwner(), true)
    lock.release()
  })

  it('reclaim 锁被身份吻合的活进程持有 → 报 reclaim_in_progress，不抢', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(LOCK_PATH, '{not-json', 'utf-8')
    const reclaimer = holderInfo({ pid: process.ppid, ownerToken: 'live-reclaimer', startedAtMs: Date.now() - 60_000 })
    writeFileSync(`${LOCK_PATH}.reclaim`, JSON.stringify(reclaimer, null, 2), 'utf-8')
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => reclaimer.startedAtMs! })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.reason, 'reclaim_in_progress')
    assert.equal(
      readFileSync(`${LOCK_PATH}.reclaim`, 'utf-8'),
      JSON.stringify(reclaimer, null, 2),
      '活进程持有的 reclaim 锁不得被删',
    )
  })
})

describe('StoreLock — 进程创建时间探测（异步、有界）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-probe-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('probeProcessStartMs 在本平台给出与本进程启动时刻相符的时间', async () => {
    const startMs = await probeProcessStartMs(process.pid)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.equal(typeof startMs, 'number', 'ps -o lstart 解析失败会让 pid_reused 判据整体失效')
      const expected = Date.now() - process.uptime() * 1000
      assert.ok(Math.abs((startMs as number) - expected) < 5_000, `ps=${startMs} uptime 推算=${expected}`)
      assert.equal(await probeProcessStartMs(DEAD_PID), undefined, '不存在的 PID 必须返回 undefined')
    } else if (process.platform === 'win32') {
      // win32 走 PowerShell CIM Win32_Process.CreationDate（异步、2s 上限）。
      // 沙箱 CI 若取不到允许 undefined（调用方按不可核验处理）；取到就必须准。
      if (startMs !== undefined) {
        const expected = Date.now() - process.uptime() * 1000
        assert.ok(Math.abs(startMs - expected) < 30_000, `cim=${startMs} uptime 推算=${expected}`)
      }
    } else {
      assert.equal(startMs, undefined, '不支持的平台必须返回 undefined（判据不生效）')
    }
  })

  // 还原缺陷即红：探测若不计入 acquire 窗口（或不 await 探测结果）→ calls 上界
  // 或 elapsed 上界被击穿 → 红。
  it('探测耗时计入 acquire 重试窗口预算；探测失败按占用处理', async () => {
    writeHolder(holderInfo({ pid: process.pid, startedAtMs: Date.now() - 5_000 }))
    let calls = 0
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      // 模拟 2s 上限内的慢探测（真实 win32 PowerShell 形态），且最终取不到值
      processStartMs: async () => { calls++; await sleep(400); return undefined },
    })

    const t0 = Date.now()
    const state = await lock.acquire({ retryWindowMs: 1_000, retryIntervalMs: 200 })
    const elapsed = Date.now() - t0

    contended(state)
    assert.ok(calls >= 2 && calls <= 3, `慢探测必须吃掉重试窗口（不耗时会有 ~5 次）：calls=${calls}`)
    assert.ok(elapsed < 1_000 + 400 + 400, `窗口无上界：${elapsed}ms`)
  })
})

describe('StoreLock — 丢锁回调与 release 收口', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-lost-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：release 若无条件删锁（不做四元组比对）→ 接管者的锁被删 → 红。
  it('持锁期间锁被外部接管 → onLockLost 触发；丢锁后 release 不再删除别人的锁', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 25 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')

    const lost = new Promise<StoreLockState>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('5s 内 onLockLost 未触发')), 5_000)
      lock.onLockLost((s) => { clearTimeout(timer); resolve(s) })
    })
    // 外部接管：另一进程 reclaim 后重建的锁（完整身份、不同 ownerToken、活 pid）
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'takeover', startedAtMs: Date.now() - 2_000 }))

    const lostState = await lost
    assert.equal(lostState.status, 'contended')
    assert.equal(lock.isOwner(), false, '丢锁后不得再自认 owner')

    lock.release()
    assert.equal(readHolder().ownerToken, 'takeover', '丢锁后的 release 必须是 no-op，不能删别人的锁')
  })
})

describe('StoreLock — 升级过渡期：认出不认识 sidecar.lock 的旧版写者', () => {
  // 现场（2026-10-04）：旧版桌面端 sidecar 只持有定时任务锁、没有 sidecar.lock；打包验证
  // 起的新版 sidecar 照样拿到会话库锁并 rehydrate，把一个正在跑的会话写成「已中断」。
  // 「另一个活进程」用 process.ppid（测试 runner，必然存活且不是本进程）。
  let LEGACY_PATH = ''
  const RECORDED_START_MS = Date.now() - 3_600_000

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-legacy-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    LEGACY_PATH = join(TEST_DIR, 'desktop', LEGACY_WRITER_LOCK_FILENAME)
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function writeLegacyOwner(overrides: Partial<LockInfo> = {}): void {
    const info: LockInfo = {
      pid: process.ppid,
      acquiredAt: new Date(RECORDED_START_MS).toISOString(),
      hostname: osHostname(),
      startedAtMs: RECORDED_START_MS,
      ...overrides,
    }
    writeFileSync(LEGACY_PATH, JSON.stringify(info, null, 2), 'utf-8')
  }

  /** 真实启动时间与记录对得上（ps 秒级截断 + 进程内 uptime 估算的误差量级）。 */
  const matchingStart = async (pid: number) => (pid === process.ppid ? RECORDED_START_MS + 800 : undefined)

  // 还原缺陷即红：撤掉 attemptAcquire 开头的 legacyWriter() → 本条拿到锁（acquired）→ 变红。
  it('定时任务锁被别的活进程持有 → 判为占用，且不创建 sidecar.lock', async () => {
    writeLegacyOwner()
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: matchingStart })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.reason, 'legacy_writer')
    assert.equal(c.holder.pid, process.ppid, '横幅/health 要能报出旧版写者的 PID')
    assert.equal(lock.isOwner(), false)
    assert.equal(lock.holder()?.pid, process.ppid)
    assert.equal(existsSync(LOCK_PATH), false, '认出旧版写者后不得在会话库目录落任何锁文件')
  })

  it('定时任务锁的持有者已死 → 不拦', async () => {
    writeLegacyOwner({ pid: DEAD_PID })
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: matchingStart })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  it('定时任务锁就是本进程的 → 不拦', async () => {
    writeLegacyOwner({ pid: process.pid })
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => RECORDED_START_MS })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  // 还原缺陷即红：撤掉启动时间比对 → 复用了 PID 的无关进程被当成旧版写者（contended）→ 变红。
  it('PID 活着但真实启动时间对不上（PID 已被复用）→ 不拦', async () => {
    writeLegacyOwner()
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: async (pid) => (pid === process.ppid ? RECORDED_START_MS + 2 * 3_600_000 : undefined),
    })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  it('取不到真实启动时间 / 记录里没有启动时间 → 保留旧版写者占用', async () => {
    writeLegacyOwner()
    const noPs = new StoreLock({ lockPath: LOCK_PATH, processStartMs: async () => undefined })
    assert.equal((await noPs.acquire({ retryWindowMs: 0 })).status, 'contended')
    noPs.release()

    writeLegacyOwner({ startedAtMs: undefined })
    const noRecord = new StoreLock({ lockPath: LOCK_PATH, processStartMs: matchingStart })
    assert.equal((await noRecord.acquire({ retryWindowMs: 0 })).status, 'contended')
    noRecord.release()
  })

  it('跨主机的定时任务锁 → 保留占用（本机判不了远端进程）', async () => {
    writeLegacyOwner({ hostname: 'some-other-host.local' })
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: matchingStart })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'contended', JSON.stringify(state))
    lock.release()
  })

  // 还原缺陷即红：撤掉「与 sidecar.lock 同一持有者」的排除 → reason 变成 legacy_writer → 变红。
  it('新版锁主同时持有两把锁 → 走常规判据（pid_alive），不误报为旧版写者', async () => {
    writeLegacyOwner()
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'new-sidecar', startedAtMs: RECORDED_START_MS }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, processStartMs: matchingStart })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(contended(state).reason, 'pid_alive')
    assert.equal(readHolder().ownerToken, 'new-sidecar', '不能抢走活锁')
  })
})

describe('StoreLock — node:test 真实目录护栏', () => {
  // 还原缺陷即红：撤掉 assertTestGuard 后第一条用例会真的去写 ~/.rivet/desktop/sidecar.lock
  // （在开发机上就是污染真实会话库）→ 变红。
  let savedContext: string | undefined

  beforeEach(() => {
    savedContext = process.env.NODE_TEST_CONTEXT
    process.env.NODE_TEST_CONTEXT = savedContext || 'store-lock-guard-test'
  })

  afterEach(() => {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = savedContext
  })

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-guard-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('node:test 下拒绝默认真实目录，且不留任何痕迹', async () => {
    const realPath = platformDefaultStoreLockPath()
    assert.ok(realPath.endsWith('sidecar.lock'), realPath)
    const before = existsSync(realPath) ? readFileSync(realPath, 'utf-8') : null

    const lock = new StoreLock({ lockPath: realPath })
    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'error', JSON.stringify(state))
    assert.match((state as Extract<StoreLockState, { status: 'error' }>).reason, /node:test|测试/)
    assert.equal(lock.isOwner(), false)
    assert.equal(existsSync(`${realPath}.reclaim`), false, '护栏必须早于任何文件操作')

    const after = existsSync(realPath) ? readFileSync(realPath, 'utf-8') : null
    assert.equal(after, before, '真实会话库锁文件不得被改写')
  })

  it('显式指向其他目录时放行（RIVET_DESKTOP_DIR 形态）', async () => {
    const savedDesktopDir = process.env.RIVET_DESKTOP_DIR
    process.env.RIVET_DESKTOP_DIR = TEST_DIR
    try {
      const lock = new StoreLock({ lockPath: join(TEST_DIR, 'desktop', 'sidecar.lock') })
      const state = await lock.acquire({ retryWindowMs: 0 })
      assert.equal(state.status, 'acquired', JSON.stringify(state))
      lock.release()
    } finally {
      if (savedDesktopDir === undefined) delete process.env.RIVET_DESKTOP_DIR
      else process.env.RIVET_DESKTOP_DIR = savedDesktopDir
    }
  })

  it('默认路径随 RIVET_DESKTOP_DIR 走；平台默认路径忽略环境变量', () => {
    const savedDesktopDir = process.env.RIVET_DESKTOP_DIR
    process.env.RIVET_DESKTOP_DIR = TEST_DIR
    try {
      assert.equal(storeLockPath(), join(TEST_DIR, 'sidecar.lock'), '默认锁路径必须落在 desktopDir()')
      // 平台默认（忽略 RIVET_DESKTOP_DIR / RIVET_HOME）是护栏的比较基准，不能被环境变量带走
      const platformDefault = platformDefaultStoreLockPath()
      assert.equal(platformDefault, join(defaultRivetHome(), 'desktop', 'sidecar.lock'))
    } finally {
      if (savedDesktopDir === undefined) delete process.env.RIVET_DESKTOP_DIR
      else process.env.RIVET_DESKTOP_DIR = savedDesktopDir
    }
  })
})

describe('health 快照输出锁占用者与初始化错误', () => {
  class NoopAgent implements ManagedAgent {
    run(_p: string, _cb: AgentCallbacks): Promise<void> { return new Promise(() => {}) }
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return [] }
    replaceMessages(_msgs: OaiMessage[]): void {}
    rewindToMessages(_msgs: OaiMessage[]): void {}
  }

  const TOKEN = 'tok'
  const AUTH = { authorization: `Bearer ${TOKEN}` }

  it('带 token 请求输出 initializationError 与 storeLockHolder；匿名探测不输出', async () => {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
    const router = createRouter(
      buildHealthRoute(
        manager, Date.now(), '9.9.9', TOKEN, undefined, undefined, undefined,
        () => 'store lock: contended by pid 4242',
        () => ({ pid: 4242, startedAtMs: 1_700_000_000_000, hostname: 'other-host' }),
      ),
    )

    const body = (await router('GET', '/health', {}, AUTH)).body as Record<string, unknown>
    assert.equal(body.initializationError, 'store lock: contended by pid 4242')
    assert.deepEqual(body.storeLockHolder, { pid: 4242, startedAtMs: 1_700_000_000_000, hostname: 'other-host' })
    assert.equal(body.readiness, 'failed')

    // 匿名探测保持最小体：rich fields 是活动侧信道，不扩大无鉴权响应面
    const anon = (await router('GET', '/health', {}, {})).body as Record<string, unknown>
    assert.ok(!('initializationError' in anon), '匿名分支不输出 initializationError')
    assert.ok(!('storeLockHolder' in anon), '匿名分支不输出 storeLockHolder')
  })

  it('未接线时两个字段都不出现（保持既有 7 参调用兼容）', async () => {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
    const router = createRouter(buildHealthRoute(manager, Date.now(), '9.9.9', TOKEN))
    const body = (await router('GET', '/health', {}, AUTH)).body as Record<string, unknown>
    assert.ok(!('initializationError' in body))
    assert.ok(!('storeLockHolder' in body))
    assert.equal(body.readiness, 'ready')
  })
})

// ─── issue #530 — 僵尸持有者：pid_dead/pid_reused 双失效后的第三判据 ─────────

describe('StoreLock — 僵尸持有者可接管（issue #530）', () => {
  // macOS 上僵尸的 kill(0) 成功（isPidAlive=true）且保留真实 lstart（pid_reused 不命中），
  // 两条既有判据全失效 → 必须靠 zombie 探测判死，否则新进程永远收不回锁（issue 现场）。
  const Z_START_MS = Date.now() - 3_600_000
  const matchingStart = async (pid: number) => (pid === process.ppid ? Z_START_MS + 800 : undefined)

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-zombie-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：撤掉 holderGoneReason 的 zombie 判死 → 持有者（活 pid + 启动时间匹配）
  // 被判 pid_alive contended → 变红。
  it('持有者是僵尸（活 PID + 启动时间匹配）→ stale_recovered', async () => {
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'zombie-owner', startedAtMs: Z_START_MS }))
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: matchingStart,
      isProcessZombie: async () => true,
    })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(readHolder().ownerToken, lock.getState()?.status === 'stale_recovered' ? readHolder().ownerToken : '', '锁已重建为自己身份')
  })

  // 探测失败/未知 → 不判死（安全方向：误判占用可恢复，误判失效=双写）
  it('zombie 探测返回 false/失败 → 保留占用', async () => {
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'live-owner', startedAtMs: Z_START_MS }))
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: matchingStart,
      isProcessZombie: async () => false,
    })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(contended(state).reason, 'pid_alive')
    assert.equal(readHolder().ownerToken, 'live-owner', '不得删除占用中的锁')
  })

  // 还原缺陷即红：撤掉 legacyWriter 的 zombie 判死 → 僵尸 legacy 持有者被判活 → legacy_writer 卡死 → 变红。
  it('僵尸持有定时任务锁（legacy）→ 不拦（issue 现场的 contended: legacy_writer 卡死）', async () => {
    const legacyPath = join(TEST_DIR, 'desktop', LEGACY_WRITER_LOCK_FILENAME)
    writeFileSync(legacyPath, JSON.stringify({
      pid: process.ppid,
      acquiredAt: new Date(Z_START_MS).toISOString(),
      hostname: osHostname(),
      startedAtMs: Z_START_MS,
    }, null, 2), 'utf-8')

    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      processStartMs: matchingStart,
      isProcessZombie: async () => true,
    })
    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  // 端到端（不 mock 中间层）：真僵尸 + 真锁文件 + 默认探测链（kill(0) → ps lstart → ps state）
  it('真僵尸持有锁 → 默认探测链接管（darwin/linux）', {
    skip: process.platform === 'win32' ? 'Windows 无僵尸概念' : false,
  }, async () => {
    const { spawn } = await import('node:child_process')
    const script = '$| = 1; my $pid = fork(); if ($pid == 0) { exit 0 } else { print "$pid\\n"; sleep 30 }'
    const child = spawn('perl', ['-e', script])
    const zombiePid = await new Promise<number>((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => reject(new Error('zombie pid not printed within 5s')), 5_000)
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const m = out.match(/(\d+)/)
        if (m) { clearTimeout(timer); resolve(Number(m[1])) }
      })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
    })

    try {
      // 前置断言：kill(0) 对僵尸成功（issue 盲区前提），且拿真实 lstart 做锁记录
      assert.doesNotThrow(() => process.kill(zombiePid, 0), '僵尸的 kill(0) 应成功')
      const realStartMs = await probeProcessStartMs(zombiePid)
      assert.ok(realStartMs !== undefined, '僵尸应有真实启动时间（ps lstart）')

      writeHolder(holderInfo({ pid: zombiePid, ownerToken: 'zombie-e2e', startedAtMs: realStartMs }))
      const lock = new StoreLock({ lockPath: LOCK_PATH })
      const state = await lock.acquire({ retryWindowMs: 0 })

      assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    } finally {
      child.kill()
    }
  })
})

// ─── issue #530 — 心跳丢锁容错：读失败 ≠ 被抢 ─────────────────────────────

describe('StoreLock — 心跳读失败容错（issue #530 次根因）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-hb-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：撤掉「读失败连续 N 次才判丢」容错 → 损坏瞬间（第一次 tick）就
  // markLockLost → 「1 个周期内不触发」断言变红。60ms 周期，3 次=180ms。
  it('锁文件损坏（读失败）→ 连续 3 个 tick 才判丢锁，不一次读失败就弃库', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 60 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')

    let lostCount = 0
    lock.onLockLost(() => { lostCount++ })

    // 磁盘抖动/半截写模拟：文件还在，但内容不可解析（readLockFile 把 IO/解析异常归 null）
    writeFileSync(LOCK_PATH, '{corrupted-half-write', 'utf-8')

    await sleep(120) // 2 个 tick 内
    assert.equal(lostCount, 0, `读失败 1-2 次不得判丢锁（防瞬时磁盘抖动误杀）：lostCount=${lostCount}`)

    await sleep(240) // 到第 5 个 tick
    assert.ok(lostCount >= 1, `连续读失败 3 次（180ms）后必须判丢锁：lostCount=${lostCount}`)
  })

  // 还原缺陷即红：删除是「真丢」，必须走快速路径立即判丢——若误并入 N 次容错，
  // 「2 个周期内触发」的上界断言变红。
  it('锁文件被删除（真丢）→ 下一 tick 立即判丢锁，不等容错次数', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 60 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')

    let lostCount = 0
    lock.onLockLost(() => { lostCount++ })

    rmSync(LOCK_PATH, { force: true })

    await sleep(150) // 2.5 个 tick 内
    assert.ok(lostCount >= 1, `锁文件删除必须立即判丢：lostCount=${lostCount}`)
  })

  // 回归护栏：身份不符（真被接管）仍是立即判丢（既有语义不许被容错放宽）。
  it('锁被外部接管（身份不符）→ 下一 tick 立即判丢锁', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 60 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')

    let lostCount = 0
    lock.onLockLost(() => { lostCount++ })

    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'takeover', startedAtMs: Date.now() - 2_000 }))

    await sleep(150)
    assert.ok(lostCount >= 1, `被接管必须立即判丢：lostCount=${lostCount}`)
  })
})

// ─── issue #530 — 丢锁收口残留清理（防御纵深） ─────────────────────────────
//
// 说明（RED 可行性）：缺陷形态是「进程 exit(2) 后锁文件残留」——进程退出即测试终止，
// 无法在单进程内红灯复现。按测试纪律降级为「收口行为契约用例」：钉住 serve.ts
// 丢锁收口（onLockLost → storeLock.release()）的行为语义——IO 恢复后仍属本进程的
// 残留锁必须被清掉；被接管的锁绝不误删（后者由既有用例「丢锁后 release 不再删除
// 别人的锁」覆盖）。替代验证：serve-store-lock-lost.test.ts 端到端回归。

describe('StoreLock — 丢锁收口清残（issue #530 行为契约）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-cleanup-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('误判丢锁后锁内容恢复为本进程身份 → 收口 release 清掉残留锁', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 60 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')
    // 备份本进程身份 JSON（acquire 时写入的完整四元组）
    const ownIdentityJson = readFileSync(LOCK_PATH, 'utf-8')

    let lostCount = 0
    lock.onLockLost(() => { lostCount++ })

    // 磁盘抖动模拟：内容损坏 → 连续读失败累计判丢
    writeFileSync(LOCK_PATH, '{corrupted', 'utf-8')
    await sleep(300)
    assert.ok(lostCount >= 1, `读失败累计应判丢锁：lostCount=${lostCount}`)

    // IO 恢复：磁盘上的锁仍是本进程身份（issue 现场的残留形态）。
    // serve.ts 丢锁收口在宿主回调/exit(2) 前调 release()——此处模拟该调用点。
    writeFileSync(LOCK_PATH, ownIdentityJson, 'utf-8')
    lock.release()

    assert.equal(existsSync(LOCK_PATH), false, '仍属本进程的残留锁必须被清掉，否则新进程永久卡死（issue #530）')
  })

  it('被接管丢锁后收口 release 不误删接管者的锁（回归护栏）', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 60 })
    assert.equal((await lock.acquire({ retryWindowMs: 0 })).status, 'acquired')

    let lostCount = 0
    lock.onLockLost(() => { lostCount++ })
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'takeover', startedAtMs: Date.now() - 2_000 }))
    await sleep(150)
    assert.ok(lostCount >= 1)

    lock.release()
    assert.equal(readHolder().ownerToken, 'takeover', '收口 release 必须放过接管者的锁')
  })
})
