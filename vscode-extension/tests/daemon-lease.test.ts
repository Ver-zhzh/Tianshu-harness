import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function processWithAlive(alive: Set<number>, kills: number[]) {
  return {
    ...process,
    kill(pid: number, signal?: unknown) {
      if (signal === 0) {
        if (alive.has(pid)) return true
        const error = new Error('ESRCH') as Error & { code: string }
        error.code = 'ESRCH'
        throw error
      }
      kills.push(pid)
      alive.delete(pid)
      return true
    },
  }
}

const healthy = (instanceId = 'daemon-1', pid = 4242) => ({ ok: true, json: async () => ({ instanceId, pid, readiness: 'ready' }) })

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
      instanceId: 'daemon-test',
      updatedAt: 1000,
    })
    const valid = readDaemonLease(leaseFile)
    assert.equal(valid?.instanceId, 'daemon-test')
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
  const alive = new Set<number>()
  const kills: number[] = []
  const spawnOptions: any[] = []
  let spawnCount = 0

  const { launchSidecar } = load(
    'src/sidecar/launcher.ts',
    {
      'node:child_process': {
        spawn: (_cli: string, _args: string[], options: any) => {
          spawnCount++
          spawnOptions.push(options)
          const child: any = new EventEmitter()
          const pid = 54321 + spawnCount
          alive.add(pid)
          Object.assign(child, {
            pid,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            exitCode: null,
            signalCode: null,
            unref() {},
            kill: () => {
              kills.push(pid)
              alive.delete(pid)
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
      process: processWithAlive(alive, kills),
      fetch: async () => healthy('daemon-1', 54322),
    },
  )

  try {
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
    assert.notEqual(spawnOptions[0].stdio[1], 'pipe', '守护模式必须写持久日志文件而不是易失管道')

    await h1.dispose()
    assert.equal(kills.length, 0)
    assert.equal(existsSync(leaseFile), true)

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

    await h2.dispose({ forceKill: true })
    assert.deepEqual(kills, [54322], 'forceKill 必须真正回收原实例，而不只是删除租约')
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
        return healthy()
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

function writeLeaseFixture(leaseFile: string, pid = 4242, instanceId = 'daemon-1') {
  writeFileSync(leaseFile, JSON.stringify({
    pid,
    port: 39110,
    token: 'abcdef0123456789abcdef0123456789',
    baseUrl: 'http://127.0.0.1:39110',
    instanceId,
    updatedAt: 1000,
  }))
}

test('匿名 200 缺少 instanceId 时不得复用旧租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-anonymous-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  let spawnCount = 0
  let fetchCalls = 0
  const { launchSidecar, readDaemonLease } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: () => {
      spawnCount++
      const child: any = new EventEmitter()
      Object.assign(child, { pid: 60001, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true })
      return child
    } },
  }, {
    fetch: async () => {
      fetchCalls++
      if (fetchCalls === 1) return { ok: true, json: async () => ({ ok: true }) }
      return healthy('daemon-new', 60001)
    },
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    assert.equal(handle.reused, false)
    assert.equal(spawnCount, 1)
    assert.equal(readDaemonLease(leaseFile)?.instanceId, 'daemon-new')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('复用句柄在 daemon 退出时触发 onExit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-reused-exit-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let instanceId = 'daemon-1'
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    process: processWithAlive(alive, kills),
    fetch: async () => healthy(instanceId),
    setInterval: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer },
    clearInterval: (id: number) => { timers.delete(id) },
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    let exited = 0
    handle.onExit(() => { exited++ })
    assert.equal(handle.reused, true)
    instanceId = 'daemon-2'
    for (const fn of timers.values()) fn()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, 1, 'PID 被复用时也必须按 instanceId 变化识别旧 daemon 已退出')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('forceKill 前实例不一致时不得终止数字 PID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-pid-reuse-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  let instanceId = 'daemon-1'
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    process: processWithAlive(alive, kills),
    fetch: async () => healthy(instanceId),
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    instanceId = 'daemon-2'
    await handle.dispose({ forceKill: true })
    assert.deepEqual(kills, [])
    assert.equal(existsSync(leaseFile), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('forceKill 等待原实例退出后才完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-kill-wait-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  const fakeProcess = {
    ...process,
    kill(pid: number, signal?: unknown) {
      if (signal === 0) {
        if (alive.has(pid)) return true
        const error = new Error('ESRCH') as Error & { code: string }
        error.code = 'ESRCH'
        throw error
      }
      kills.push(pid)
      return true
    },
  }
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    process: fakeProcess,
    fetch: async () => healthy(),
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    let settled = false
    const disposal = handle.dispose({ forceKill: true }).then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, '进程仍存活时 dispose 不得提前返回')
    alive.clear()
    await disposal
    assert.equal(settled, true)
    assert.deepEqual(kills, [4242])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('调用方中止租约探针时保留有效租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-probe-abort-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const controller = new AbortController()
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    fetch: async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
  })
  try {
    await assert.rejects(launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, signal: controller.signal }), /aborted/)
    assert.equal(existsSync(leaseFile), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('关闭 keepAlive 时回收旧实例再启动新实例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-disable-keepalive-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  let spawnCount = 0
  let spawnStdio: any
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: (_cli: string, _args: string[], options: any) => {
      spawnCount++
      spawnStdio = options.stdio
      const child: any = new EventEmitter()
      Object.assign(child, { pid: 60001, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true })
      return child
    } },
    'node:os': { platform: () => 'linux' },
  }, {
    process: processWithAlive(alive, kills),
    fetch: async () => healthy(),
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: false })
    assert.equal(handle.reused, false)
    assert.equal(spawnCount, 1)
    assert.deepEqual(kills, [4242])
    assert.equal(spawnStdio[1], 'pipe', '关闭 keepAlive 时仍使用普通 OutputChannel 日志管道')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attach 前实例已替换时拒绝接管旧租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-attach-mismatch-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  let spawnCount = 0
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: () => { spawnCount++; throw new Error('unexpected spawn') } },
  }, { fetch: async () => healthy('daemon-2') })
  try {
    await assert.rejects(launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true }), /实例|instance/)
    assert.equal(spawnCount, 0)
    assert.equal(existsSync(leaseFile), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('健康实例相同但 PID 不匹配时拒绝接管和强杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-pid-mismatch-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  let spawnCount = 0
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: () => { spawnCount++; throw new Error('unexpected spawn') } },
  }, { fetch: async () => healthy('daemon-1', 999) })
  try {
    await assert.rejects(launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true }), /PID|pid/)
    assert.equal(spawnCount, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readyz 初始化中的 503 可复用，401 带实例字段也不可接管', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-readyz-status-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  let spawnCount = 0
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: () => {
      spawnCount++
      const child: any = new EventEmitter()
      Object.assign(child, { pid: 60001, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true })
      return child
    } },
  }, {
    fetch: (() => {
      let calls = 0
      return async () => {
        calls++
        if (calls === 1) return { ok: false, status: 503, json: async () => ({ instanceId: 'daemon-1', pid: 4242, readiness: 'initializing' }) }
        if (calls === 2) return { ok: false, status: 401, json: async () => ({ instanceId: 'daemon-1', pid: 4242, readiness: 'ready' }) }
        return healthy('daemon-1', 60001)
      }
    })(),
  })
  try {
    const initializing = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    assert.equal(initializing.reused, true)
    const unauthorized = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    assert.equal(unauthorized.reused, false)
    assert.equal(spawnCount, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('退出通知不得删除新实例刚写入的租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-exit-lease-race-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let instanceId = 'daemon-1'
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    fetch: async () => healthy(instanceId),
    setInterval: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer },
    clearInterval: (id: number) => { timers.delete(id) },
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    handle.onExit(() => {})
    writeLeaseFixture(leaseFile, 4242, 'daemon-2')
    instanceId = 'daemon-3'
    for (const fn of timers.values()) fn()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(existsSync(leaseFile), true, '新实例的租约不能被旧实例的退出回调删除')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('并发 dispose 共享同一次退出等待', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-concurrent-dispose-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  const fakeProcess = {
    ...process,
    kill(pid: number, signal?: unknown) {
      if (signal === 0) {
        if (alive.has(pid)) return true
        const error = new Error('ESRCH') as Error & { code: string }
        error.code = 'ESRCH'
        throw error
      }
      kills.push(pid)
      return true
    },
  }
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    process: fakeProcess,
    fetch: async () => healthy(),
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    let secondSettled = false
    const first = handle.dispose({ forceKill: true })
    const second = handle.dispose({ forceKill: true }).then(() => { secondSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(secondSettled, false, '第二个调用也必须等待第一次销毁完成')
    alive.clear()
    await Promise.all([first, second])
    assert.deepEqual(kills, [4242])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('destroy 失败后允许用同一句柄重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-destroy-retry-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const alive = new Set([4242])
  const kills: number[] = []
  let attempts = 0
  const fakeProcess = {
    ...process,
    kill(pid: number, signal?: unknown) {
      if (signal === 0) {
        if (alive.has(pid)) return true
        const error = new Error('ESRCH') as Error & { code: string }
        error.code = 'ESRCH'
        throw error
      }
      attempts++
      if (attempts === 1) throw new Error('kill failed')
      kills.push(pid)
      alive.delete(pid)
      return true
    },
  }
  const { launchSidecar } = load('src/sidecar/launcher.ts', {}, {
    process: fakeProcess,
    fetch: async () => healthy(),
  })
  try {
    const handle = await launchSidecar({ cwd: root, cliPath: 'rivet', port: 39110, leaseFile, keepAliveOnDispose: true })
    await assert.rejects(handle.dispose({ forceKill: true }), /sidecar 进程回收失败/)
    await handle.dispose({ forceKill: true })
    assert.equal(attempts, 2)
    assert.deepEqual(kills, [4242])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('removeDaemonLease 在校验后发布新租约也不会误删新实例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-delete-race-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const actualFs = await import('node:fs')
  const original = actualFs.readFileSync(leaseFile, 'utf8')
  const replacement = original.replace('daemon-1', 'daemon-2')
  let published = false
  const mockedFs = {
    ...actualFs,
    renameSync(from: string, to: string) {
      actualFs.renameSync(from, to)
      if (from === leaseFile && !published) {
        published = true
        actualFs.writeFileSync(leaseFile, replacement)
      }
    },
    readFileSync() { return original },
  }
  const { removeDaemonLease } = load('src/sidecar/launcher.ts', { 'node:fs': mockedFs })
  try {
    removeDaemonLease(leaseFile, 4242, 'daemon-1')
    assert.equal(actualFs.readFileSync(leaseFile, 'utf8'), replacement)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('removeDaemonLease 恢复前出现新租约时不覆盖新文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-restore-race-'))
  const leaseFile = join(dir, 'ide-daemon-lease.json')
  writeLeaseFixture(leaseFile)
  const actualFs = await import('node:fs')
  const original = actualFs.readFileSync(leaseFile, 'utf8')
  const replacement = original.replace('daemon-1', 'daemon-2')
  const mockedFs = {
    ...actualFs,
    readFileSync() { return original },
    linkSync() {
      actualFs.writeFileSync(leaseFile, replacement)
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    },
  }
  const { removeDaemonLease } = load('src/sidecar/launcher.ts', { 'node:fs': mockedFs })
  try {
    removeDaemonLease(leaseFile, 999, 'daemon-1')
    assert.equal(actualFs.readFileSync(leaseFile, 'utf8'), replacement)
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

  state = reduceSessionRunState(state, { seq: 5, ts: 5, type: 'phase', data: { phase: 'compacting' } })
  assert.equal(state.status, 'running')
  state = reduceSessionRunState(state, { seq: 6, ts: 6, type: 'phase', data: { phase: 'idle' } })
  assert.equal(state.status, 'idle', 'phase idle 是回落信号，不能锁死为 running')
  assert.equal(state.phase, '')
  assert.equal(isLivenessEvent({ seq: 6, ts: 6, type: 'phase', data: { phase: 'idle' } }), false)

  for (const kind of ['watchdog_recovery', 'retry', 'hook_result', 'plan_draft', 'job'] as const) {
    const ev = { seq: 7, ts: 7, type: kind, data: {} }
    assert.equal(isLivenessEvent(ev), true)
    assert.deepEqual(interpretSessionEvent(ev), { kind: 'activity', phase: kind })
  }
})

test('Windows npm shim 保留 Node GC 与堆上限参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-node-shim-'))
  const node = join(dir, 'node.exe')
  const entry = join(dir, 'node_modules', 'tianshu-tui', 'dist', 'main.js')
  const shim = join(dir, 'tianshu.cmd')
  try {
    writeFileSync(node, '')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '')
    writeFileSync(shim, [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"',
      'SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --expose-gc --max-old-space-size=4096 "%dp0%\\node_modules\\tianshu-tui\\dist\\main.js" %*',
    ].join('\n'))
    const fakeProcess = { ...process, platform: 'win32' as NodeJS.Platform, env: { ...process.env, PATH: '' } }
    const { resolveCliCommand } = load('src/sidecar/cli-command.ts', {}, { process: fakeProcess })
    const resolved = resolveCliCommand(shim, ['serve'], dir)
    assert.equal(resolved.command, node)
    assert.deepEqual([...resolved.args], ['--expose-gc', '--max-old-space-size=4096', entry, 'serve'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
