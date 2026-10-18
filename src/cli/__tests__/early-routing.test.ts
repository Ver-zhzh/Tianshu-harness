/**
 * cli/early-routing 单测 —— P0-2 快速路径的行为契约。
 *
 * 用注入的 handler/io 验证路由顺序、参数切片与退出码语义，不加载真实子命令
 * （config/serve/session-persist 等），所以测试保持毫秒级、无副作用。
 */
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyEarlyCliEnv, routeEarlyCli, type EarlyCliHandlers } from '../early-routing.js'

interface Calls {
  config: string[][]
  provider: string[][]
  serve: string[][]
  browser: string[][]
  logs: string[][]
  web: string[][]
  exits: number[]
  stdout: string[]
  stderr: string[]
}

function makeFixture(overrides: Partial<EarlyCliHandlers> = {}): {
  handlers: Partial<EarlyCliHandlers>
  io: { stdout: (t: string) => void; stderr: (t: string) => void; exit: (c: number) => void }
  calls: Calls
} {
  const calls: Calls = { config: [], provider: [], serve: [], browser: [], logs: [], web: [], exits: [], stdout: [], stderr: [] }
  const handlers: Partial<EarlyCliHandlers> = {
    config: args => { calls.config.push(args) },
    provider: args => { calls.provider.push(args) },
    serve: args => { calls.serve.push(args) },
    sessions: () => 'SESSION-LIST',
    browser: async args => { calls.browser.push(args); return 0 },
    logs: async args => { calls.logs.push(args); return { output: 'LOG-OUT', exitCode: 0 } },
    web: async args => { calls.web.push(args); return 0 },
    ...overrides,
  }
  return {
    handlers,
    io: {
      stdout: t => { calls.stdout.push(t) },
      stderr: t => { calls.stderr.push(t) },
      exit: c => { calls.exits.push(c) },
    },
    calls,
  }
}

describe('routeEarlyCli', () => {
  test('storage routes before --list and forwards the maintenance plan without loading an agent', async () => {
    const calls: string[][] = []
    const fixture = makeFixture({ storage: async args => { calls.push(args); return { output: 'STORAGE', exitCode: 0 } } })
    assert.equal(await routeEarlyCli(['storage', 'compact', '--apply', '/reviewed/plan.json', '--list'], { handlers: fixture.handlers, io: fixture.io }), true)
    assert.deepEqual(calls, [['compact', '--apply', '/reviewed/plan.json', '--list']])
    assert.deepEqual(fixture.calls.stdout, ['STORAGE\n'])
  })
  test('config/provider/serve 命中并经 args.slice(1) 转发', async () => {
    const { handlers, io, calls } = makeFixture()
    assert.equal(await routeEarlyCli(['config', 'show'], { handlers, io }), true)
    assert.equal(await routeEarlyCli(['provider', 'list'], { handlers, io }), true)
    assert.equal(await routeEarlyCli(['serve', '--port', '1'], { handlers, io }), true)
    assert.deepEqual(calls.config, [['show']])
    assert.deepEqual(calls.provider, [['list']])
    assert.deepEqual(calls.serve, [['--port', '1']])
  })

  test('sessions 与 --list 都打印会话列表并补换行', async () => {
    const a = makeFixture()
    assert.equal(await routeEarlyCli(['sessions'], { handlers: a.handlers, io: a.io }), true)
    assert.deepEqual(a.calls.stdout, ['SESSION-LIST\n'])
    const b = makeFixture()
    // --list 可出现在任意位置（与 main.ts 原实现 args.includes('--list') 一致）
    assert.equal(await routeEarlyCli(['--model', 'x', '--list'], { handlers: b.handlers, io: b.io }), true)
    assert.deepEqual(b.calls.stdout, ['SESSION-LIST\n'])
  })

  test('browser/web 退出码非 0 时经 io.exit 透传；0 不退出', async () => {
    const ok = makeFixture()
    await routeEarlyCli(['browser', 'status'], { handlers: ok.handlers, io: ok.io })
    await routeEarlyCli(['web', 'status'], { handlers: ok.handlers, io: ok.io })
    assert.deepEqual(ok.calls.exits, [])

    const bad = makeFixture({ browser: async () => 3, web: async () => 4 })
    await routeEarlyCli(['browser', 'install'], { handlers: bad.handlers, io: bad.io })
    assert.deepEqual(bad.calls.exits, [3])
    await routeEarlyCli(['web', 'fetch', 'x'], { handlers: bad.handlers, io: bad.io })
    assert.deepEqual(bad.calls.exits, [3, 4])
  })

  test('logs：成功走 stdout，失败走 stderr + exit(code)', async () => {
    const ok = makeFixture()
    await routeEarlyCli(['logs', '--json'], { handlers: ok.handlers, io: ok.io })
    assert.deepEqual(ok.calls.logs, [['--json']])
    assert.deepEqual(ok.calls.stdout, ['LOG-OUT\n'])
    assert.deepEqual(ok.calls.exits, [])

    const bad = makeFixture({ logs: async () => ({ output: 'ERR', exitCode: 2 }) })
    await routeEarlyCli(['logs'], { handlers: bad.handlers, io: bad.io })
    assert.deepEqual(bad.calls.stderr, ['ERR\n'])
    assert.deepEqual(bad.calls.exits, [2])
  })

  test('路由顺序：config 优先于 --list；未命中不调用任何 handler 且返回 false', async () => {
    const mixed = makeFixture()
    assert.equal(await routeEarlyCli(['config', '--list'], { handlers: mixed.handlers, io: mixed.io }), true)
    assert.deepEqual(mixed.calls.config, [['--list']])
    assert.deepEqual(mixed.calls.stdout, [])

    const none = makeFixture()
    assert.equal(await routeEarlyCli(['-p', 'hi'], { handlers: none.handlers, io: none.io }), false)
    assert.equal(await routeEarlyCli([], { handlers: none.handlers, io: none.io }), false)
    assert.deepEqual(
      [none.calls.config, none.calls.provider, none.calls.serve, none.calls.browser, none.calls.logs, none.calls.web],
      [[], [], [], [], [], []],
    )
  })
})

describe('applyEarlyCliEnv', () => {
  const originalProfile = process.env.RIVET_PROFILE
  afterEach(() => {
    if (originalProfile === undefined) delete process.env.RIVET_PROFILE
    else process.env.RIVET_PROFILE = originalProfile
  })

  test('合法 --profile 写入 RIVET_PROFILE；缺值/负值不写', async () => {
    delete process.env.RIVET_PROFILE
    await applyEarlyCliEnv(['--profile', 'lean'])
    assert.equal(process.env.RIVET_PROFILE, 'lean')

    delete process.env.RIVET_PROFILE
    await applyEarlyCliEnv(['--profile', '--trust'])
    assert.equal(process.env.RIVET_PROFILE, undefined)

    delete process.env.RIVET_PROFILE
    await applyEarlyCliEnv(['--profile'])
    assert.equal(process.env.RIVET_PROFILE, undefined)
  })

  test('--trust / --untrust 调用注入的 hooks（不写真实用户配置）', async () => {
    const trusted: string[] = []
    const untrusted: string[] = []
    await applyEarlyCliEnv(['--trust'], {
      trustProject: cwd => { trusted.push(cwd) },
      untrustProject: cwd => { untrusted.push(cwd) },
    })
    assert.deepEqual(trusted, [process.cwd()])
    assert.equal(untrusted.length, 0)

    await applyEarlyCliEnv(['--untrust'], {
      trustProject: cwd => { trusted.push(cwd) },
      untrustProject: cwd => { untrusted.push(cwd) },
    })
    assert.deepEqual(untrusted, [process.cwd()])
  })
})
