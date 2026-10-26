/**
 * switchAgentRuntime — 模型切换查找/错误路径测试。
 *
 * 仅覆盖 createAgentRuntime 之前可确定性断言的分支（未找到模型 / 缺少 API key），
 * 成功路径会重建完整 AgentLoop（重型依赖），由真终端手验覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderForModel, switchAgentRuntime } from '../bootstrap.js'
import type { BootstrapContext } from '../bootstrap.js'
import { resolveInitialReasoningEffort } from '../bootstrap.js'
import { resolveCapabilities } from '../api/provider.js'
import { isCurrentModelTarget } from '../bootstrap/model-resolution.js'
import { providerSchema } from '../config/schema.js'

function activeCtx() {
  const provider = providerSchema.parse({ name: 'fixture', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'current' }, { id: 'other' }] })
  let aborted = 0, rebuilt = 0, status = 0, audited = 0
  const frozen = { generation: 'original' }
  const client = { generation: 'original' }
  const agent = {
    config: { client, promptEngine: {
      getModel: () => 'current',
      exportFrozenSnapshot: () => { rebuilt++; throw new Error('replacement boundary reached') },
    } },
    abort: () => { aborted++ },
  }
  const ctx = {
    config: { provider: { providers: { fixture: provider } } }, provider, apiKey: 'fixture-only', agent,
    setStatusLine: () => { status++ }, onAgentRuntimeChanged: () => { rebuilt++ },
    persist: { updateMetadata: () => { audited++ }, appendModelSwitch: () => { audited++ } },
    refs: { promptEngine: frozen },
  } as unknown as BootstrapContext
  return { ctx, provider, agent, frozen, client, counts: () => ({ aborted, rebuilt, status, audited }) }
}

test('selecting the same resolved target preserves the active run, agent, client and cache generation', () => {
  const f = activeCtx()
  const res = switchAgentRuntime(f.ctx, 'current', 'fixture')
  assert.equal(res.ok, true)
  assert.equal(res.changed, false)
  assert.equal(f.ctx.agent, f.agent)
  assert.equal(f.ctx.agent.config.client, f.client)
  assert.equal(f.ctx.refs.promptEngine, f.frozen)
  assert.deepEqual(f.counts(), { aborted: 0, rebuilt: 0, status: 0, audited: 0 })
})

test('invalid selections do not abort an active run', () => {
  const f = activeCtx()
  assert.equal(switchAgentRuntime(f.ctx, 'missing').ok, false)
  assert.deepEqual(f.counts(), { aborted: 0, rebuilt: 0, status: 0, audited: 0 })
})

test('a genuinely different model reaches replacement only after interrupting the old run', () => {
  const f = activeCtx()
  assert.throws(() => switchAgentRuntime(f.ctx, 'other', 'fixture'), /replacement boundary reached/)
  assert.equal(f.counts().aborted, 1)
  assert.equal(f.counts().rebuilt, 1)
})

test('target identity includes account, endpoint, wire options and exact model id', () => {
  const f = activeCtx()
  const resolved = resolveProviderForModel(f.ctx, 'current', 'fixture')!
  assert.ok(!('error' in resolved))
  assert.equal(isCurrentModelTarget(f.ctx, 'current', resolved), true)
  for (const target of [
    { ...resolved, apiKey: 'different-fixture-account' },
    { ...resolved, providerName: 'different-provider' },
    { ...resolved, provider: { ...resolved.provider, baseUrl: 'http://127.0.0.1:2/v1' } },
    { ...resolved, provider: { ...resolved.provider, protocol: 'anthropic' as const } },
    { ...resolved, provider: { ...resolved.provider, temperature: 0.5 } },
    { ...resolved, provider: { ...resolved.provider, models: [{ ...resolved.provider.models[0]!, contextWindow: 99999 }] } },
    { ...resolved, modelId: 'other' },
  ]) assert.equal(isCurrentModelTarget(f.ctx, 'current', target), false)
  assert.equal(isCurrentModelTarget(f.ctx, 'deepseek-flash', { ...resolved, modelId: 'deepseek-v4-flash' }), false)
})

test('canonical provider registry key can differ from its display name', () => {
  const f = activeCtx()
  f.ctx.config.provider.providers = { canonical: f.provider }
  assert.equal(switchAgentRuntime(f.ctx, 'current', 'canonical').changed, false)
  assert.equal(f.counts().aborted, 0)
})

test('a multi-key pool preserves the active slot, while an explicit different slot is a real switch', () => {
  const f = activeCtx()
  const models = f.provider.models
  const first = { id: 'first', apiKey: 'fixture-only', models }
  const second = { id: 'second', apiKey: 'fixture-only', models }
  f.provider.keys = [first, second]
  f.ctx.provider = { ...f.provider, keys: [second] }
  assert.equal(switchAgentRuntime(f.ctx, 'current', 'fixture').changed, false)
  assert.equal(f.counts().aborted, 0)
  assert.throws(() => switchAgentRuntime(f.ctx, 'fixture:first:current'), /replacement boundary reached/)
  assert.equal(f.counts().aborted, 1)
})

test('the registered /model consumer preserves a running UI and does not abort on repeated selection', async t => {
  const { registerTuiSlashCommands } = await import('../tui/slash-commands.js')
  const { makeApp } = await import('../tui/engine/__tests__/_harness.js')
  const f = activeCtx()
  Object.assign(f.agent, { getReasoningEffort: () => undefined })
  const { app } = makeApp({ modelName: 'current' })
  t.after(() => app.dispose())
  registerTuiSlashCommands(app, f.ctx)
  app.setStreamingState(true)
  assert.equal(await app.tryDispatchSlash('/model current'), true)
  assert.deepEqual(f.counts(), { aborted: 0, rebuilt: 0, status: 0, audited: 0 })
  assert.equal((app as unknown as { state: { isStreaming: boolean } }).state.isStreaming, true)
  assert.match(app.getScrollbackContent(), /当前模型保持不变/)
})

function makeCtx(providers: Record<string, unknown>, currentName = 'p1'): BootstrapContext {
  return {
    config: { provider: { providers } },
    provider: { name: currentName },
  } as unknown as BootstrapContext
}

test('显式 provider 约束只解析该 provider 下的同名模型', () => {
  delete process.env.__RIVET_TEST_WRONG_PROVIDER_KEY__
  const ctx = makeCtx({
    first: { name: 'first', apiKeyEnv: '__RIVET_TEST_WRONG_PROVIDER_KEY__', models: [{ id: 'shared-model' }] },
    second: { name: 'second', apiKey: 'second-key', models: [{ id: 'shared-model' }] },
  })

  const resolved = resolveProviderForModel(ctx, 'shared-model', 'second')
  assert.ok(resolved && !('error' in resolved))
  assert.equal(resolved.providerName, 'second')
  assert.equal(resolved.apiKey, 'second-key')
})

test('未显式指定 provider 时保持按配置顺序解析的旧语义', () => {
  delete process.env.__RIVET_TEST_FIRST_PROVIDER_KEY__
  const ctx = makeCtx({
    first: { name: 'first', apiKeyEnv: '__RIVET_TEST_FIRST_PROVIDER_KEY__', models: [{ id: 'shared-model' }] },
    second: { name: 'second', apiKey: 'second-key', models: [{ id: 'shared-model' }] },
  })

  const resolved = resolveProviderForModel(ctx, 'shared-model')
  assert.ok(resolved && 'error' in resolved)
  assert.match(resolved.error, /first/)
})

test('未知模型返回 not found，不重建 agent', () => {
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'm1', alias: 'mm' }] },
  })
  const res = switchAgentRuntime(ctx, 'does-not-exist')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /not found/i)
})

test('找到模型但缺少 API key → 返回 API key 错误（非 oauth）', () => {
  // 切换目标在另一个 provider 上，无 apiKey / apiKeyEnv 未设
  delete process.env.__RIVET_TEST_MISSING_KEY__
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur', alias: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY__', models: [{ id: 'target', alias: 't' }] },
  })
  const res = switchAgentRuntime(ctx, 'target')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /API key/i)
})

test('模型存在但缺 key：报 API key 而非 not found（未找到分支不误报）', () => {
  // 判据是「找到了模型、只是 key 缺失」。config 的 model.alias 字段 2026-09 起
  // 废弃（不落盘、不作为模型引用），故这里按 id 引用——按 alias 引用不再解析
  // 是预期的 fail-closed 行为，不再断言。
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY2__', models: [{ id: 'real-id' }] },
  })
  const res = switchAgentRuntime(ctx, 'real-id')
  assert.equal(res.ok, false)
  assert.doesNotMatch(res.error ?? '', /not found/i)
  assert.match(res.error ?? '', /API key/i)
})

test('resolveInitialReasoningEffort preserves undefined when no effort configured', () => {
  const caps = resolveCapabilities('deepseek')
  assert.equal(resolveInitialReasoningEffort(undefined, caps), undefined)
})

test('resolveInitialReasoningEffort normalizes DeepSeek aliases (medium -> high, off -> off)', () => {
  const caps = resolveCapabilities('deepseek')
  assert.equal(resolveInitialReasoningEffort('medium', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'off')
  assert.equal(resolveInitialReasoningEffort('low', caps), 'low')
  assert.equal(resolveInitialReasoningEffort('high', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'max')
})

test('resolveInitialReasoningEffort normalizes Grok unsupported off -> low and preserves max', () => {
  const caps = resolveCapabilities('grok')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'low')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'max')
})

test('resolveInitialReasoningEffort normalizes StepFun max -> high and off -> low', () => {
  const caps = resolveCapabilities('stepfun')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'low')
})
