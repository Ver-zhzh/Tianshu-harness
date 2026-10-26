import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveInitialDomainName,
  resolveInitialEffortDisplay,
  resolveInitialModelName,
} from '../initial-status.js'

const MODELS = [
  { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 128000 },
  { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 64000 },
]

// ── 初始模型名 ──────────────────────────────────────────────────

test('模型名：无配置无运行时 → provider 首模型 alias（原行为）', () => {
  const r = resolveInitialModelName({ models: MODELS })
  assert.equal(r.modelName, 'v4-pro')
  assert.equal(r.currentModel?.id, 'deepseek-v4-pro')
})

test('模型名：defaultModel 配置命中 → 显示其 alias', () => {
  const r = resolveInitialModelName({
    models: MODELS,
    defaultModelRef: 'deepseek:deepseek-v4-flash',
  })
  assert.equal(r.modelName, 'v4-flash')
  assert.equal(r.currentModel?.id, 'deepseek-v4-flash')
})

test('模型名：运行时模型优先于配置默认（resume/--model 场景）', () => {
  const r = resolveInitialModelName({
    models: MODELS,
    runtimeModelId: 'deepseek-v4-pro',
    defaultModelRef: 'deepseek:deepseek-v4-flash',
  })
  assert.equal(r.modelName, 'v4-pro')
})

test('模型名：运行时模型命中 alias 而非 id → 显示 alias', () => {
  const r = resolveInitialModelName({ models: MODELS, runtimeModelId: 'v4-flash' })
  assert.equal(r.modelName, 'v4-flash')
})

test('模型名：运行时模型不在 provider 列表 → 显示原始 modelId', () => {
  const r = resolveInitialModelName({ models: MODELS, runtimeModelId: 'x-unknown-model' })
  assert.equal(r.modelName, 'x-unknown-model')
  // currentModel 回退 provider 首模型（contextWindow 等 UI 元数据不悬空）
  assert.equal(r.currentModel?.id, 'deepseek-v4-pro')
})

test('模型名：defaultModel 非 "provider:modelId" 格式 → 忽略', () => {
  const r = resolveInitialModelName({ models: MODELS, defaultModelRef: 'malformed' })
  assert.equal(r.modelName, 'v4-pro')
})

test('模型名：provider 列表为空 → unknown', () => {
  const r = resolveInitialModelName({ models: [] })
  assert.equal(r.modelName, 'unknown')
})

// ── 初始星域名 ──────────────────────────────────────────────────

test('星域：agent 已钉定 → 用 agent 的（defaultDomain 不同也以 agent 为准）', () => {
  const r = resolveInitialDomainName({
    agentDomainName: '太一',
    defaultDomain: 'qiming',
    resolve: () => ({ name: '启明' }),
  })
  assert.equal(r, '太一')
})

test('星域：未钉定 + defaultDomain=taiyi → 解析出「太一」', () => {
  const r = resolveInitialDomainName({
    defaultDomain: 'taiyi',
    resolve: (id) => (id === 'taiyi' ? { name: '太一' } : undefined),
  })
  assert.equal(r, '太一')
})

test('星域：未钉定 + defaultDomain=auto → undefined（保持重路由语义）', () => {
  const r = resolveInitialDomainName({ defaultDomain: 'auto', resolve: () => ({ name: '启明' }) })
  assert.equal(r, undefined)
})

test('星域：未钉定 + 无 defaultDomain → undefined', () => {
  const r = resolveInitialDomainName({ resolve: () => undefined })
  assert.equal(r, undefined)
})

test('星域：defaultDomain 指向不存在的域 → undefined', () => {
  const r = resolveInitialDomainName({ defaultDomain: 'ghost', resolve: () => undefined })
  assert.equal(r, undefined)
})

test('effort：当前生效值优先于显式配置和模型 floor', () => {
  assert.equal(resolveInitialEffortDisplay({ current: 'max', configured: 'high', floor: 'low' }), 'max')
  assert.equal(resolveInitialEffortDisplay({ configured: 'high', floor: 'low' }), 'high')
})

test('effort：current/configured 都未赋值时回退模型初始 floor', () => {
  assert.equal(resolveInitialEffortDisplay({ floor: 'high' }), 'high')
})

test('effort：floor 同样经过 normalize，全部缺失时保持 undefined', () => {
  const normalized = resolveInitialEffortDisplay({ floor: 'medium', normalize: effort => effort === 'medium' ? 'high' : effort })
  assert.equal(normalized, 'high')
  assert.equal(resolveInitialEffortDisplay({}), undefined)
})
