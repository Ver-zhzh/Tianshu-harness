import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import {
  createInitialSessionRunSummary,
  isLivenessEvent,
  reduceSessionRunState,
} from '../src/shared/session-state-reducer.ts'
import { interpretSessionEvent } from '../src/chat/turn-events.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function load(relative: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const cache = new Map<string, { exports: any }>()
  function visit(filename: string): any {
    if (cache.has(filename)) return cache.get(filename)!.exports
    const module = { exports: {} as any }
    cache.set(filename, module)
    const code = transformSync(readFileSync(filename, 'utf8'), {
      loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'cjs',
      target: 'node18',
      jsx: 'automatic',
    }).code
    vm.runInNewContext(
      code,
      {
        module,
        exports: module.exports,
        require(id: string) {
          if (id in mocks) return mocks[id]
          if (!id.startsWith('.')) return require(id)
          const stem = resolve(dirname(filename), id.replace(/\.js$/, '.ts'))
          return visit(existsSync(stem) ? stem : stem.replace(/\.ts$/, '.tsx'))
        },
        process,
        Buffer,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch,
        AbortController,
        AbortSignal,
        TextDecoder,
        TextEncoder,
        ...globals,
      },
      { filename },
    )
    return module.exports
  }
  return visit(resolve(root, relative))
}

test('readDaemonLease enforces strict 127.0.0.1 loopback and hex token validation (P0-3 defense)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-lease-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  const { readDaemonLease, writeDaemonLease } = load('src/sidecar/launcher.ts')

  try {
    writeDaemonLease(leaseFile, {
      pid: 12345,
      port: 43210,
      token: 'abcdef0123456789abcdef0123456789',
      baseUrl: 'http://127.0.0.1:43210',
      desktopDir: '/tmp/ws',
      updatedAt: 1000,
    })
    const valid = readDaemonLease(leaseFile)
    assert.equal(valid?.pid, 12345)
    assert.equal(valid?.port, 43210)
    assert.equal(readDaemonLease(leaseFile, 43210)?.port, 43210)
    assert.equal(readDaemonLease(leaseFile, 55555), undefined)

    // 非环回地址必须被拒（防御恶意租约劫持）
    writeFileSync(
      leaseFile,
      JSON.stringify({
        pid: 12345,
        port: 43210,
        token: 'abcdef0123456789abcdef0123456789',
        baseUrl: 'http://192.168.1.99:43210',
      }),
    )
    assert.equal(readDaemonLease(leaseFile), undefined)

    // 非法 token 必须被拒
    writeFileSync(
      leaseFile,
      JSON.stringify({
        pid: 12345,
        port: 43210,
        token: 'short',
        baseUrl: 'http://127.0.0.1:43210',
      }),
    )
    assert.equal(readDaemonLease(leaseFile), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('launchSidecar writes lease, survives normal dispose (Reload Window), and reattaches without respawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-daemon-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  let spawnCount = 0
  let killCount = 0
  const children: any[] = []

  const { launchSidecar } = load(
    'src/sidecar/launcher.ts',
    {
      'node:child_process': {
        spawn: (cli: string) => {
          if (/taskkill(?:\.exe)?$/i.test(cli)) {
            killCount++
            const killer = new EventEmitter()
            queueMicrotask(() => {
              for (const c of children) {
                c.exitCode = 0
                c.emit('exit', 0)
              }
              killer.emit('close', 0)
            })
            return killer
          }
          spawnCount++
          const child: any = new EventEmitter()
          Object.assign(child, {
            pid: 54321 + spawnCount,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            exitCode: null,
            signalCode: null,
            unref() {},
            kill: () => {
              killCount++
              queueMicrotask(() => {
                child.exitCode = 0
                child.emit('exit', 0)
              })
              return true
            },
          })
          children.push(child)
          return child
        },
      },
    },
    {
      fetch: async () => ({
        ok: true,
        json: async () => ({ ok: true, readiness: 'ready' }),
      }),
    },
  )

  try {
    // 1. 首次启动：拉起子进程并落盘租约
    const h1 = await launchSidecar({
      cwd: root,
      cliPath: 'rivet',
      port: 39100,
      desktopDir: dir,
      leaseFile,
      keepAliveOnDispose: true,
    })
    assert.equal(h1.reused, false)
    assert.equal(spawnCount, 1)
    assert.equal(existsSync(leaseFile), true)

    // 2. 模拟 Reload Window（普通 dispose，不传 forceKill）：进程存活、租约保留
    await h1.dispose()
    assert.equal(killCount, 0)
    assert.equal(existsSync(leaseFile), true)

    // 3. 重载后新窗口启动：直接复用已存活的守护进程，零新进程 spawn
    const logs: string[] = []
    const h2 = await launchSidecar({
      cwd: root,
      cliPath: 'rivet',
      port: 39100,
      desktopDir: dir,
      leaseFile,
      keepAliveOnDispose: true,
      onLog: (line: string) => logs.push(line),
    })
    assert.equal(h2.reused, true)
    assert.equal(h2.port, 39100)
    assert.equal(h2.token, h1.token)
    assert.equal(spawnCount, 1)
    assert.ok(logs.some((l) => l.includes('reattached to existing sidecar daemon')))

    // 4. 模拟用户手动执行「重启内核 sidecar」（forceKill: true）：清除租约并回收进程
    await h2.dispose({ forceKill: true })
    assert.equal(existsSync(leaseFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('launchSidecar cleans up stale lease and spawns fresh sidecar when health probe fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-stale-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeFileSync(
    leaseFile,
    JSON.stringify({
      pid: 99999,
      port: 39101,
      token: 'abcdef0123456789abcdef0123456789',
      baseUrl: 'http://127.0.0.1:39101',
      desktopDir: dir,
      updatedAt: 1000,
    }),
  )
  let spawnCount = 0
  let fetchCalls = 0
  const { launchSidecar } = load(
    'src/sidecar/launcher.ts',
    {
      'node:child_process': {
        spawn: () => {
          spawnCount++
          const child: any = new EventEmitter()
          Object.assign(child, {
            pid: 60001,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            exitCode: null,
            signalCode: null,
            kill: () => {
              queueMicrotask(() => {
                child.exitCode = 0
                child.emit('exit', 0)
              })
              return true
            },
          })
          return child
        },
      },
      'node:os': { platform: () => 'linux' },
    },
    {
      fetch: async () => {
        fetchCalls++
        // 第 1 次为探测旧租约 → 拒绝连接；第 2 次为新进程探活 → 成功
        if (fetchCalls === 1) throw new Error('ECONNREFUSED')
        return { ok: true, json: async () => ({ ok: true, readiness: 'ready' }) }
      },
    },
  )

  try {
    const handle = await launchSidecar({
      cwd: root,
      cliPath: 'rivet',
      port: 39102,
      desktopDir: dir,
      leaseFile,
    })
    assert.equal(handle.reused, false)
    assert.equal(spawnCount, 1)
    await handle.dispose({ forceKill: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shared session-state-reducer tracks liveness and run state across surfaces', () => {
  let state = createInitialSessionRunSummary()
  assert.equal(state.status, 'idle')

  const phaseEv = { seq: 1, ts: 1, type: 'phase', data: { phase: 'thinking' } }
  assert.equal(isLivenessEvent(phaseEv), true)
  state = reduceSessionRunState(state, phaseEv)
  assert.equal(state.status, 'running')
  assert.equal(state.phase, 'thinking')
  assert.equal(state.lastSeq, 1)

  const approvalEv = { seq: 2, ts: 2, type: 'approval_required', data: { requestId: 'r1' } }
  state = reduceSessionRunState(state, approvalEv)
  assert.equal(state.pendingApprovals, 1)

  const resolvedEv = { seq: 3, ts: 3, type: 'approval_resolved', data: { requestId: 'r1' } }
  state = reduceSessionRunState(state, resolvedEv)
  assert.equal(state.pendingApprovals, 0)

  const doneEv = { seq: 4, ts: 4, type: 'done', data: { status: 'completed' } }
  state = reduceSessionRunState(state, doneEv)
  assert.equal(state.status, 'idle')
  assert.equal(state.phase, '')
  assert.equal(state.lastSeq, 4)

  // 新增活性事件（watchdog_recovery / retry / hook_result / plan_draft）同时在 turn-events 映射为 activity
  for (const kind of ['watchdog_recovery', 'retry', 'hook_result', 'plan_draft'] as const) {
    const ev = { seq: 5, ts: 5, type: kind, data: {} }
    assert.equal(isLivenessEvent(ev), true)
    assert.deepEqual(interpretSessionEvent(ev), { kind: 'activity', phase: kind })
  }
})
