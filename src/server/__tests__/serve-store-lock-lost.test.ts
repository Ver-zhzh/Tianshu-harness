/**
 * P0-1b 接线回归：运行期丢锁（sidecar.lock 被接管/删除）后的单写者收口。
 *
 * 病灶：丢锁前 serve.ts 没给 StoreLock 传 onLockLost——锁被别的进程接管后，
 * 本进程仍以写者身份继续跑：ownsSessionStore 恒 true（路由照单全收）、
 * readiness 恒 ready（桌面壳无归因）、persistence 照常落盘（双写）。
 *
 * 修复（本文件钉的三条契约）：
 *   1. CLI 入口（serveCommand）：丢锁 → 立即非零退出（exit 2），跳过一切会向
 *      会话库回写的优雅收尾（flushAllAsync / 退出面包屑）。
 *   2. 程序化入口（runServe）：丢锁 → 撤销写资格（写请求 503 data-dir-lock-lost、
 *      readiness failed）、停调度、回调宿主的 onLockLost，绝不擅自 process.exit；
 *      之后的信号驱动正常退出（SIGTERM → close 链）不受影响（exit 0）。
 *   3. 丢锁后的 release 是 no-op（不删别人的锁）；丢锁路径对会话库零写入。
 *
 * 与 serve-store-lock.test.ts 同范式：真 spawn 子进程、真锁文件、真 HTTP。
 * 丢锁用「删除锁文件」模拟（外部接管/强行回收的可观察效果相同：心跳 tick
 * 重读时发现锁不再属于自己）。心跳间隔 10s → 检测上界约 10s，预算给足。
 *
 * 还原缺陷即红（接线缺失时的失败形态）：
 *   - serve.ts 不传 onLockLost → 用例 1 等不到退出（子进程一直 ready）→ 红
 *   - 丢锁后 initializationError 不置 data-dir-lock-lost → 用例 2 health 断言红
 *   - 丢锁后 route guard 不翻 ownsSessionStore → 用例 2 的 POST /sessions 非 503 → 红
 *   - CLI 丢锁走优雅收尾 → 会话库出现写入 / 面包屑落盘 → 用例 1 红
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readLockFile } from '../cron-lock.js'

const SERVE_TS = new URL('../serve.ts', import.meta.url)
const TOKEN = 'store-lock-lost-token'

type HealthBody = Record<string, unknown>

interface ServeHandle {
  child: ChildProcess
  port: number
  stdout: string[]
  stderr: string[]
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `serve-lock-lost-${label}-`))
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(join(root, 'desktop'), { recursive: true })
  writeFileSync(join(root, 'home', 'config.json'), '{}')
  return root
}

/** 起一个真 serve 子进程；driver 源码由用例给（CLI 入口 / 程序化入口两种形态）。 */
function spawnDriver(root: string, label: string, port: number, driverSource: string): ServeHandle {
  const driverPath = join(root, `driver-${label}.mjs`)
  writeFileSync(driverPath, driverSource, 'utf8')
  const child = spawn(process.execPath, ['--import', 'tsx', driverPath], {
    env: {
      ...process.env,
      RIVET_HOME: join(root, 'home'),
      RIVET_DESKTOP_DIR: join(root, 'desktop'),
      RIVET_SERVER_TOKEN: TOKEN,
      TEST_PORT: String(port),
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? 'serve-store-lock-lost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout?.on('data', (d) => stdout.push(String(d)))
  child.stderr?.on('data', (d) => stderr.push(String(d)))
  return { child, port, stdout, stderr }
}

/** CLI 入口驱动：复刻生产 serveCommand。 */
const CLI_DRIVER = `
const { serveCommand } = await import(${JSON.stringify(SERVE_TS.href)})
await serveCommand(['--port', String(process.env.TEST_PORT), '--host', '127.0.0.1'])
`

/** 程序化入口驱动：runServe + onLockLost 回调（宿主不退出），SIGTERM 走优雅收尾。 */
const PROGRAMMATIC_DRIVER = `
const { runServe } = await import(${JSON.stringify(SERVE_TS.href)})
const server = await runServe({
  port: Number(process.env.TEST_PORT),
  host: '127.0.0.1',
  onLockLost: () => {
    console.log('LOCK_LOST_CB')
    setTimeout(() => {
      console.log('SCHEDULER_RUNNING=' + String(server.scheduler?.isRunning() ?? 'none'))
    }, 300)
  },
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
console.log('READY')
`

async function readHealth(port: number): Promise<HealthBody> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(res.status, 200, `GET /health 应 200，实际 ${res.status}`)
  return (await res.json()) as HealthBody
}

async function waitForHealth(
  handle: ServeHandle,
  pred: (body: HealthBody) => boolean,
  timeoutMs: number,
  label: string,
): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs
  let last: HealthBody | undefined
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`${label}：子进程提前退出 code=${handle.child.exitCode}；stderr=${handle.stderr.join('').slice(-600)}`)
    }
    try {
      last = await readHealth(handle.port)
      if (pred(last)) return last
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${label}：${timeoutMs}ms 内未满足。最后 health=${JSON.stringify(last)}；stderr=${handle.stderr.join('').slice(-600)}`)
}

/** 等子进程 stdout 出现标记（丢锁检测上界 = 心跳间隔 10s + 余量）。 */
async function waitForStdout(handle: ServeHandle, marker: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (handle.stdout.join('').includes(marker)) return
    if (handle.child.exitCode !== null) {
      throw new Error(`${label}：子进程提前退出 code=${handle.child.exitCode}；stderr=${handle.stderr.join('').slice(-600)}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${label}：${timeoutMs}ms 内未等到 stdout 标记 ${marker}；stdout=${handle.stdout.join('').slice(-400)}；stderr=${handle.stderr.join('').slice(-600)}`)
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 内子进程未退出`)), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === null ? -1 : code)
    })
  })
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(p))
    })
  })
}

function sessionsListing(root: string): string[] {
  const dir = join(root, 'desktop', 'sessions')
  return existsSync(dir) ? readdirSync(dir) : []
}

test('CLI 入口丢锁 → 立即非零退出（exit 2），跳过会话库收尾写入', { timeout: 120_000 }, async () => {
  const root = makeRoot('cli')
  const lockPath = join(root, 'desktop', 'sidecar.lock')
  const handle = spawnDriver(root, 'cli', await freePort(), CLI_DRIVER)
  try {
    await waitForHealth(handle, (b) => b.readiness === 'ready', 90_000, '实例未就绪')
    assert.equal(readLockFile(lockPath)?.pid, handle.child.pid, '锁文件应归子进程自身')

    const sessionsBefore = sessionsListing(root)
    // 模拟外部接管/强行回收：锁文件消失。持锁进程的心跳 tick 重读时发现丢锁。
    rmSync(lockPath, { recursive: true, force: true })

    const code = await waitForExit(handle.child, 40_000)
    assert.equal(code, 2, `CLI 丢锁必须立即非零退出（exit 2），实际 ${code}；stderr=${handle.stderr.join('').slice(-400)}`)
    assert.ok(
      handle.stderr.join('').includes('data-dir-lock-lost'),
      `退出路径必须留可归因日志；stderr=${handle.stderr.join('').slice(-400)}`,
    )
    assert.equal(
      existsSync(join(root, 'desktop', 'sidecar-exit.json')),
      false,
      '丢锁退出不得写退出面包屑——会话库已不属于本进程',
    )
    assert.deepEqual(sessionsListing(root), sessionsBefore, '丢锁路径对会话库必须零写入（跳过 flushAllAsync）')
  } finally {
    if (handle.child.exitCode === null && !handle.child.killed) handle.child.kill('SIGKILL')
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('程序化入口丢锁 → 撤销写资格+停调度+回调宿主，不擅自退出；信号退出不受影响', { timeout: 120_000 }, async () => {
  const root = makeRoot('prog')
  const lockPath = join(root, 'desktop', 'sidecar.lock')
  const handle = spawnDriver(root, 'prog', await freePort(), PROGRAMMATIC_DRIVER)
  try {
    await waitForHealth(handle, (b) => b.readiness === 'ready', 90_000, '实例未就绪')
    assert.equal(readLockFile(lockPath)?.pid, handle.child.pid)

    rmSync(lockPath, { recursive: true, force: true })

    // 宿主回调必须被调（且不擅自 process.exit）；调度器随后停下
    await waitForStdout(handle, 'LOCK_LOST_CB', 30_000, 'onLockLost 回调')
    await waitForStdout(handle, 'SCHEDULER_RUNNING=false', 10_000, '调度器停止')
    assert.equal(handle.child.exitCode, null, '程序化入口丢锁后不得擅自退出（交宿主处置）')

    // readiness 翻 failed 且可归因——桌面壳 failed_readiness_reason 据此区分「丢锁」
    const health = await readHealth(handle.port)
    assert.equal(health.readiness, 'failed', `丢锁后不得再自报 ready：${JSON.stringify(health)}`)
    assert.equal(health.initializationError, 'data-dir-lock-lost', JSON.stringify(health))

    // 写请求立即 503；只读诊断保持可达
    const rejected = await fetch(`http://127.0.0.1:${handle.port}/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'must be rejected after lock loss' }),
    })
    assert.equal(rejected.status, 503, '丢锁后写请求必须立即 503')
    assert.equal((await rejected.json() as { error: string }).error, 'data-dir-lock-lost')
    const readable = await fetch(`http://127.0.0.1:${handle.port}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(readable.status, 200, '只读诊断路由不受闸门影响')

    // 信号驱动的正常退出不受影响：优雅链照常跑完（flushAllAsync 被闸门兜成 no-op），exit 0
    handle.child.kill('SIGTERM')
    const code = await waitForExit(handle.child, 30_000)
    assert.equal(code, 0, `丢锁后的正常退出必须仍是 exit 0，实际 ${code}；stderr=${handle.stderr.join('').slice(-400)}`)
  } finally {
    if (handle.child.exitCode === null && !handle.child.killed) handle.child.kill('SIGKILL')
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})
