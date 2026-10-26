import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'

/**
 * 收编公开仓 PR #37：路由 GET/PUT 必须返回「哪一份配置实例 + 每一个悬空来源」，
 * 让设置页在保存后仍能提示不可用绑定，而不是把它当保存失败吞掉。
 */
test('routing GET and PUT identify the active config and every dangling routing source', async () => {
  const home = mkdtempSync(join(tmpdir(), 'routing-binding-diagnostics-'))
  const previous = { home: process.env.RIVET_HOME, config: process.env.RIVET_CONFIG_PATH }
  process.env.RIVET_HOME = home
  process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
  try {
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify({ provider: { providers: { custom: {
      name: 'custom', baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'ROUTING_TEST_MISSING_KEY',
      models: [{ id: 'active', contextWindow: 128000, maxTokens: 1000 }],
    } } } }))
    const router = createRouter(buildConfigRoutes('routing-test'))
    const auth = { authorization: 'Bearer routing-test' }
    const workers = {
      profiles: { cheap: { provider: 'custom', keyId: 'selected', model: 'removed' } },
      routing: { planning: 'cheap', code_edit: 'deleted-route', risky_refactor: { provider: 'custom', model: 'removed' } },
    }
    const response = await router('PUT', '/config/routing', { workers }, auth)
    assert.equal(response.status, 200, 'unavailable targets remain editable without account fallback')
    const body = response.body as any
    assert.equal(body.diagnostics.instance.configPath, process.env.RIVET_CONFIG_PATH)
    assert.equal(body.diagnostics.instance.home, home)
    assert.equal(body.diagnostics.instance.pid, process.pid)
    assert.equal(typeof body.diagnostics.instance.version, 'string')
    const warnings = body.diagnostics.warnings as any[]
    assert.ok(warnings.some(w => w.path === 'workers.profiles.cheap' && w.reason === 'model_deleted' && w.target.keyId === 'selected'))
    assert.ok(warnings.some(w => w.path === 'workers.routing.planning' && w.target.model === 'removed'))
    assert.ok(warnings.some(w => w.path === 'workers.routing.code_edit' && w.reason === 'route_deleted' && w.route === 'deleted-route'))
    assert.ok(warnings.some(w => w.path === 'workers.routing.risky_refactor' && w.reason === 'model_deleted'))
    const get = await router('GET', '/config/routing', undefined, auth)
    assert.deepEqual((get.body as any).diagnostics, body.diagnostics)
    assert.equal((get.body as any).workers.profiles.cheap.model, 'removed')
    assert.equal((await router('GET', '/config/routing', undefined, {})).status, 401)
    assert.equal(JSON.stringify(body.diagnostics).includes('apiKeyEnv'), false)
    assert.equal(JSON.stringify(body.diagnostics).includes('https://gateway.example'), false)
  } finally {
    if (previous.home === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = previous.home
    if (previous.config === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous.config
    rmSync(home, { recursive: true, force: true })
  }
})
