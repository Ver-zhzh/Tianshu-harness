import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDeepseekV4FlashRetirement } from '../preset-model-retirement.js'
import { loadConfig } from '../manager.js'
import { writeProviderKeysFile } from '../provider-keys-store.js'
import { findModelInKey } from '../provider-keys.js'

/**
 * 收编公开仓 PR #37：Spark 通道（deepseek-spark）的旧模型引用迁移。
 *
 * 现场：官方 Spark 的 key 池已登记 deepseek-flash，历史 worker 路由仍写
 * deepseek-v4-flash → 主会话正常，子代理在请求前报 model_deleted。
 * 判据：迁移只按 provider 名精确匹配引用，且不跨通道借用 key 与元数据。
 */
const old = 'deepseek-v4-flash'
const current = 'deepseek-flash'
const model = (id: string) => ({ id, contextWindow: 500_000, maxTokens: 32_000 })
function fixture(baseUrl = 'https://api.deepseek.com/v1') {
  return {
    provider: { providers: { 'deepseek-spark': { name: 'deepseek-spark', baseUrl, models: [model(old)], keys: [
      { id: 'first', models: [model('deepseek-v4-pro')] }, { id: 'selected', models: [model(current)] },
    ] } } },
    workers: {
      profiles: { cheap: { provider: 'deepseek-spark', keyId: 'selected', model: old } },
      routing: { planning: 'cheap', risky_refactor: { provider: 'deepseek-spark', keyId: 'selected', model: old } },
    },
    agent: { review: { profiles: { verifier: { provider: 'deepseek-spark', keyId: 'selected', model: old } } },
      council: { seats: [{ authority: 'yaoguang', provider: 'deepseek-spark', keyId: 'selected', model: old }] } },
  }
}

test('official Spark retirement repairs named profiles and direct targets without switching key slots', () => {
  const raw = fixture()
  assert.equal(migrateDeepseekV4FlashRetirement(raw), true)
  assert.equal(raw.workers.profiles.cheap.model, current)
  assert.equal(raw.workers.profiles.cheap.keyId, 'selected')
  assert.equal(raw.workers.routing.planning, 'cheap')
  assert.equal(raw.workers.routing.risky_refactor.model, current)
  assert.equal(raw.agent.review.profiles.verifier.model, current)
  assert.equal(raw.agent.council.seats[0]!.model, current)
  assert.deepEqual(raw.provider.providers['deepseek-spark'].keys[0]!.models, [model('deepseek-v4-pro')])
  assert.equal(migrateDeepseekV4FlashRetirement(raw), false)
})

test('pinned retirement adds the replacement only to the referenced key when needed', () => {
  const raw = fixture()
  raw.provider.providers['deepseek-spark'].keys[1]!.models = [model('other')]
  assert.equal(migrateDeepseekV4FlashRetirement(raw), true)
  assert.equal(raw.provider.providers['deepseek-spark'].keys[0]!.models.some(m => m.id === current), false)
  assert.equal(raw.provider.providers['deepseek-spark'].keys[1]!.models.some(m => m.id === current), true)
})

test('a gateway using the Spark registration keeps its own model IDs and references', () => {
  const raw = fixture('https://gateway.example/v1')
  const before = structuredClone(raw)
  assert.equal(migrateDeepseekV4FlashRetirement(raw), false)
  assert.deepEqual(raw, before)
})

test('a gateway under the standard DeepSeek name does not prevent official Spark migration', () => {
  const raw = fixture() as Record<string, any>
  raw.provider.providers.deepseek = { baseUrl: 'https://gateway.example/v1', models: [model(old)] }
  assert.equal(migrateDeepseekV4FlashRetirement(raw), true)
  assert.equal(raw.workers.profiles.cheap.model, current)
  assert.equal(raw.provider.providers.deepseek.models[0].id, old)
})

test('loadConfig repairs the real external-key-pool mismatch, persists it and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-worker-retirement-'))
  const previous = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  try {
    const raw = fixture()
    const provider = raw.provider.providers['deepseek-spark']
    writeProviderKeysFile({ version: 1, providers: { 'deepseek-spark': provider.keys } }, dir)
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(raw))
    const cfg = loadConfig()
    const target = cfg.workers.profiles.cheap!
    assert.ok('provider' in target)
    assert.equal(target.model, current)
    assert.ok(findModelInKey(cfg.provider.providers[target.provider]!, target.keyId!, target.model))
    const persisted = JSON.parse(readFileSync(process.env.RIVET_CONFIG_PATH, 'utf8'))
    assert.equal(persisted.workers.profiles.cheap.model, current)
    const first = readFileSync(process.env.RIVET_CONFIG_PATH, 'utf8')
    const reloaded = loadConfig().workers.profiles.cheap!
    assert.ok('provider' in reloaded)
    assert.equal(reloaded.model, current)
    assert.equal(readFileSync(process.env.RIVET_CONFIG_PATH, 'utf8'), first)
  } finally {
    if (previous === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration does not revive a deliberately removed replacement for an unchanged weak reference', () => {
  const raw = fixture()
  raw.workers.profiles.cheap.model = current
  raw.workers.routing = { planning: 'cheap' } as typeof raw.workers.routing
  raw.agent.review.profiles.verifier.model = current
  raw.agent.council.seats[0]!.model = current
  raw.provider.providers['deepseek-spark'].models = [model('deepseek-v4-pro')]
  raw.provider.providers['deepseek-spark'].keys[1]!.models = [model('other')]
  assert.equal(migrateDeepseekV4FlashRetirement(raw), false)
  assert.equal(raw.provider.providers['deepseek-spark'].keys[1]!.models.some(m => m.id === current), false)
})

test('loadConfig uses the selected external key, not the top-level historical snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-selected-key-'))
  const previous = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  try {
    const raw = fixture()
    const provider = raw.provider.providers['deepseek-spark']
    const keys = structuredClone(provider.keys)
    keys[1]!.models = [model('other')]
    writeProviderKeysFile({ version: 1, providers: { 'deepseek-spark': keys } }, dir)
    delete (provider as { keys?: unknown }).keys
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(raw))
    const cfg = loadConfig()
    assert.ok(findModelInKey(cfg.provider.providers['deepseek-spark']!, 'selected', current))
    assert.equal(findModelInKey(cfg.provider.providers['deepseek-spark']!, 'first', current), undefined)
    const persisted = JSON.parse(readFileSync(process.env.RIVET_CONFIG_PATH, 'utf8'))
    assert.equal(persisted.provider.providers['deepseek-spark'].keys, undefined, 'external pools must not leak into config.json')
    assert.equal(persisted.workers.profiles.cheap.model, current)
  } finally {
    if (previous === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
