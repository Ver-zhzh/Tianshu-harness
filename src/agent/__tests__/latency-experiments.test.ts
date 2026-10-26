import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latencyExperimentEnabled, latencyExperimentEffort, supportsLatencyReasoning } from '../latency-experiments.js'
import { resolveCapabilities } from '../../api/provider.js'
import { providerSchema } from '../../config/schema.js'
import { combineMemoryBlocks } from '../cross-session-memory-config.js'
import { ReasoningEffortController } from '../reasoning-effort-controller.js'

test('latency experiments default off and preserve effort floors and complex requests', t => {
  const old = process.env.RIVET_LATENCY_REASONING_EXPERIMENT
  t.after(() => { if (old === undefined) delete process.env.RIVET_LATENCY_REASONING_EXPERIMENT; else process.env.RIVET_LATENCY_REASONING_EXPERIMENT = old })
  delete process.env.RIVET_LATENCY_REASONING_EXPERIMENT
  assert.equal(latencyExperimentEnabled('reasoning'), false)
  assert.equal(latencyExperimentEffort('查看 package.json', 'high'), 'high')
  process.env.RIVET_LATENCY_REASONING_EXPERIMENT = '1'
  assert.equal(latencyExperimentEffort('查看 package.json', 'high'), 'medium')
  assert.equal(latencyExperimentEffort('查看 package.json', 'high', 'high'), 'high')
  assert.equal(latencyExperimentEffort('查看并发安全漏洞并排查根因', 'high'), 'high')
  assert.equal(latencyExperimentEffort('查看架构', 'max'), 'max')
  assert.equal(latencyExperimentEffort('读取 package.json，不要修改文件。', 'high'), 'medium')
  assert.equal(latencyExperimentEffort('查看 package.json 然后删除文件', 'high'), 'high')
  assert.equal(latencyExperimentEffort('read package.json then run a migration', 'high'), 'high')
})

test('prompt experiment removes duplicate memory ids only and leaves defaults byte-identical', t => {
  const old = process.env.RIVET_LATENCY_PROMPT_EXPERIMENT
  t.after(() => { if (old === undefined) delete process.env.RIVET_LATENCY_PROMPT_EXPERIMENT; else process.env.RIVET_LATENCY_PROMPT_EXPERIMENT = old })
  const stable = '<cross-session-memory><m id="same">Retained memory</m></cross-session-memory>'
  const adaptive = '<cross-session-memory source="adaptive">\n- [same] topic | duplicate\n- [other] topic | unique\n</cross-session-memory>'
  delete process.env.RIVET_LATENCY_PROMPT_EXPERIMENT
  assert.equal(combineMemoryBlocks(stable, adaptive), `${stable}\n${adaptive}`)
  process.env.RIVET_LATENCY_PROMPT_EXPERIMENT = '1'
  const result = combineMemoryBlocks(stable, adaptive)!
  assert.match(result, /Retained memory/); assert.match(result, /unique/); assert.doesNotMatch(result, /duplicate/)
})

test('perception consumes the experimental adjustment after the provider floor, while explicit effort wins', () => {
  const wire: string[] = []
  let adjustments = 0
  const controller = new ReasoningEffortController({
    getReasoningFloor: () => 'high', getConfigReasoningEffort: () => 'high', setConfigReasoningEffort: () => {},
    setClientReasoningEffort: effort => wire.push(effort), isEffortBanditEnabled: () => false,
    p3: {} as never, hasTaskContract: () => true, getPredictionAccumulator: () => ({} as never),
    getTurnCount: () => 1, getMaxTurns: () => 10, getFilesModifiedCount: () => 0, setCurrentEffortShadow: () => {},
    adjustAutomaticEffort: effort => { adjustments++; assert.equal(effort, 'high'); return 'medium' },
  })
  controller.set('low')
  controller.set('max', 'user')
  assert.deepEqual(wire, ['medium', 'max'])
  assert.equal(adjustments, 1)
})

test('wire-equivalent medium is excluded from reasoning comparisons', () => {
  const deepseek = providerSchema.parse({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [] })
  assert.equal(supportsLatencyReasoning(deepseek, resolveCapabilities('deepseek')), false)
  const supported = providerSchema.parse({ name: 'custom', protocol: 'openai-responses', baseUrl: 'https://fixture.invalid', models: [] })
  assert.equal(supportsLatencyReasoning(supported, resolveCapabilities('custom')), true)
  const unknown = providerSchema.parse({ name: 'custom', baseUrl: 'https://fixture.invalid', models: [] })
  assert.equal(supportsLatencyReasoning(unknown, resolveCapabilities('custom')), false)
})
