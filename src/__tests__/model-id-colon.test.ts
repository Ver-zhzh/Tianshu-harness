/**
 * issue #313：模型 id 自带冒号（网关清单形如 `cn:glm-5.3-flash`）时，与
 * `provider[:keyId]:model` 分隔约定冲突——/model 切换报 "not found in any provider"、
 * 设为默认把 `cn` 当 keyId、headless `--model` 静默回退。三条入口共用 resolveModelRef。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelRef, parseModelRef } from '../config/provider-keys.js'
import { assertDefaultModelRef } from '../config/contract-models.js'
import { resolveProviderForModel } from '../bootstrap.js'
import { classifyModelSpecMiss } from '../server/serve.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { Config, ProviderConfig } from '../config/schema.js'

const COLON_MODELS = [{ id: 'cn:glm-5.3-flash' }, { id: 'cn:deepseek-v4.1-flash' }]
const providers = {
  workbuddy: {
    name: 'workbuddy', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k-wb', models: COLON_MODELS,
    keys: [{ id: 'default', models: COLON_MODELS }, { id: 'second', models: [{ id: 'plain-model' }] }],
  },
  deepseek: { name: 'deepseek', apiKey: 'k-ds', models: [{ id: 'ds-v4' }] },
} as unknown as Record<string, ProviderConfig>

const ctx = {
  provider: providers.deepseek, apiKey: 'k-ds', auth: undefined,
  config: { provider: { providers }, agent: {} },
} as unknown as BootstrapContext

test('resolveModelRef：首段不是已配置 provider → 整串是模型 id', () => {
  assert.deepEqual(resolveModelRef(providers, 'cn:glm-5.3-flash'), { modelRef: 'cn:glm-5.3-flash' })
})

test('resolveModelRef：provider 前缀 + 自带冒号的 id（中间段非 key id）', () => {
  assert.deepEqual(resolveModelRef(providers, 'workbuddy:cn:glm-5.3-flash'), { provider: 'workbuddy', modelRef: 'cn:glm-5.3-flash' })
})

test('resolveModelRef：既有形态不变——两段式 / 三段式钉 key / 裸 id', () => {
  assert.deepEqual(resolveModelRef(providers, 'deepseek:ds-v4'), { provider: 'deepseek', modelRef: 'ds-v4' })
  assert.deepEqual(resolveModelRef(providers, 'workbuddy:second:plain-model'), parseModelRef('workbuddy:second:plain-model'))
  assert.deepEqual(resolveModelRef(providers, 'ds-v4'), { modelRef: 'ds-v4' })
})

test('resolveModelRef：targetProvider 与首段冲突时首段属于模型 id', () => {
  assert.deepEqual(resolveModelRef(providers, 'deepseek:x', 'workbuddy'), { modelRef: 'deepseek:x' })
  assert.deepEqual(resolveModelRef(providers, 'workbuddy:cn:glm-5.3-flash', 'workbuddy'), { provider: 'workbuddy', modelRef: 'cn:glm-5.3-flash' })
})

test('assertDefaultModelRef：workbuddy:cn:glm-5.3-flash 不再被当成 keyId=cn（根因 2）', () => {
  assert.doesNotThrow(() => assertDefaultModelRef(providers, 'workbuddy:cn:glm-5.3-flash'))
  // 真 keyId 仍按三段式校验
  assert.doesNotThrow(() => assertDefaultModelRef(providers, 'workbuddy:second:plain-model'))
  assert.throws(() => assertDefaultModelRef(providers, 'workbuddy:second:cn:glm-5.3-flash'), /not found on key "second"/)
  assert.throws(() => assertDefaultModelRef(providers, 'workbuddy:cn:nope'), /Model "cn:nope" not found/)
})

test('resolveProviderForModel：面板传裸 id + targetProvider（根因 1）', () => {
  const r = resolveProviderForModel(ctx, 'cn:glm-5.3-flash', 'workbuddy')
  assert.ok(r && !('error' in r), JSON.stringify(r))
  if (!r || 'error' in r) return
  assert.equal(r.providerName, 'workbuddy')
  assert.equal(r.modelId, 'cn:glm-5.3-flash')
})

test('resolveProviderForModel：裸 id 无 targetProvider、provider 前缀形态也都命中', () => {
  for (const id of ['cn:deepseek-v4.1-flash', 'workbuddy:cn:deepseek-v4.1-flash']) {
    const r = resolveProviderForModel(ctx, id)
    assert.ok(r && !('error' in r), id)
    if (r && !('error' in r)) assert.equal(r.modelId, 'cn:deepseek-v4.1-flash')
  }
  const ds = resolveProviderForModel(ctx, 'deepseek:ds-v4')
  assert.ok(ds && !('error' in ds) && ds.modelId === 'ds-v4')
})

test('serve.classifyModelSpecMiss：带冒号 id 存在时不误判 unknown-model', () => {
  const config = { provider: { providers } } as unknown as Config
  assert.equal(classifyModelSpecMiss(config, 'cn:glm-5.3-flash'), 'key-missing')
  assert.equal(classifyModelSpecMiss(config, 'cn:ghost'), 'unknown-model')
})
