/**
 * Issue #392 回归：同一 Provider 下配置多个 API Key 时，余额查询必须能按
 * keyId 分别查询各自账户，且不带 keyId 的旧调用保持向后兼容。
 *
 * 为什么用「拦截 globalThis.fetch」而不是 mock queryDeepSeekBalance 模块：
 * 本 runner 不启用 --experimental-test-module-mocks，且 —— 更重要的是 ——
 * 这样做让整条真实链路（路由 → resolveCredentialKey 三槽解析 → queryDeepSeekBalance
 * 的 URL 构造与 Authorization 头）都被覆盖。断言的是「哪把 key 被带上网络」，
 * 不是「哪个函数的 mock 被调用」。baseUrl 保持 api.deepseek.com 以过
 * isDeepSeekProvider 端点闸门，真实网络出口被替换为按 Authorization 记账的桩。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'

interface RouterResult { status: number; body: unknown }
type Router = (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<RouterResult>

/** 每把账户 key 对应一个可区分的余额，便于断言「结果不串号」。 */
const BALANCE_BY_KEY: Record<string, string> = {
  'sk-account-A': '111.11',
  'sk-account-B': '222.22',
}

const realFetch = globalThis.fetch
let seenRequests: Array<{ url: string; authorization: string | undefined }> = []

/** 按 Authorization 记账的 fetch 桩：未知 key 返回 401（照实暴露串号/空 key）。 */
function installFetchStub(): void {
  seenRequests = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    const authorization = new Headers(init?.headers as any).get('authorization') ?? undefined
    seenRequests.push({ url, authorization })
    const key = authorization?.replace(/^Bearer\s+/i, '')
    const total = key ? BALANCE_BY_KEY[key] : undefined
    if (!total) {
      return new Response(JSON.stringify({ error: 'invalid key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

function writeConfig(home: string, providers: Record<string, unknown>, defaultName: string): void {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ provider: { default: defaultName, providers } }, null, 2) + '\n',
  )
  // keys 池的权威源是 provider-keys.json——每个用例重建 config.json 时必须同时
  // 清掉 keys 文件，否则上一用例落下的池会跨用例存活。
  rmSync(join(home, 'provider-keys.json'), { force: true })
}

describe('GET /config/balance 多 key（issue #392）', () => {
  const prevHome = process.env.RIVET_HOME
  const prevConfigPath = process.env.RIVET_CONFIG_PATH
  let home = ''
  let router: Router

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-balance-multikey-'))
    process.env.RIVET_HOME = home
    process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
    installFetchStub()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    rmSync(home, { recursive: true, force: true })
  })

  /** DeepSeek 官方端点 + 两把不同账户的 key（内联于 keys 池）。 */
  function writeMultiKeyConfig(): void {
    writeConfig(home, {
      deepseek: {
        name: 'deepseek',
        baseUrl: DEEPSEEK_BASE,
        protocol: 'openai',
        keys: [
          { id: 'default', label: '主号', apiKey: 'sk-account-A', models: [] },
          { id: 'k2', label: '备用号', apiKey: 'sk-account-B', models: [] },
        ],
        models: [],
      },
    }, 'deepseek')
    router = createRouter(buildConfigRoutes(TOKEN)) as Router
  }

  it('按 keyId 查到该 Key 对应账户的余额（不串号）', async () => {
    writeMultiKeyConfig()

    const a = await router('GET', '/config/balance?keyId=default', {}, AUTH)
    assert.equal(a.status, 200, JSON.stringify(a.body))
    const aBody = a.body as { balance: { balances: Array<{ totalBalance: string }> }; keyId?: string }
    assert.equal(aBody.balance.balances[0]!.totalBalance, '111.11', 'default key 必须查到 A 账户')
    assert.equal(aBody.keyId, 'default')

    const b = await router('GET', '/config/balance?keyId=k2', {}, AUTH)
    assert.equal(b.status, 200, JSON.stringify(b.body))
    const bBody = b.body as { balance: { balances: Array<{ totalBalance: string }> }; keyId?: string; label?: string }
    assert.equal(bBody.balance.balances[0]!.totalBalance, '222.22', 'k2 必须查到 B 账户，而不是 A')
    assert.equal(bBody.keyId, 'k2')
    assert.equal(bBody.label, '备用号')

    // 每次请求都打到真实端点路径，且各自带上自己的 key。
    assert.deepEqual(
      seenRequests.map(r => r.authorization),
      ['Bearer sk-account-A', 'Bearer sk-account-B'],
    )
    assert.ok(seenRequests.every(r => r.url === 'https://api.deepseek.com/user/balance'), JSON.stringify(seenRequests))
  })

  it('不带 keyId 保持向后兼容——查默认 Provider 的默认 Key', async () => {
    writeMultiKeyConfig()

    const res = await router('GET', '/config/balance', {}, AUTH)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const body = res.body as { balance: { balances: Array<{ totalBalance: string }> }; keyId?: string }
    assert.equal(body.balance.balances[0]!.totalBalance, '111.11', '无 keyId → 默认 key（主号）')
    assert.deepEqual(seenRequests.map(r => r.authorization), ['Bearer sk-account-A'])
  })

  it('未知 keyId 明确报错，绝不静默回落到默认 key（多账号下取错比取不到更糟）', async () => {
    writeMultiKeyConfig()

    const res = await router('GET', '/config/balance?keyId=does-not-exist', {}, AUTH)
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal(seenRequests.length, 0, '未知 keyId 不得发出任何余额请求')
  })

  it('未迁移（无 keys 池）的 legacy 顶层凭据仍可查询', async () => {
    writeConfig(home, {
      deepseek: {
        name: 'deepseek',
        baseUrl: DEEPSEEK_BASE,
        protocol: 'openai',
        apiKey: 'sk-account-A',
        models: [],
      },
    }, 'deepseek')
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const res = await router('GET', '/config/balance', {}, AUTH)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const body = res.body as { balance: { balances: Array<{ totalBalance: string }> } | null }
    assert.equal(body.balance?.balances[0]?.totalBalance, '111.11', 'legacy 顶层凭据链必须继续工作')
  })
})
