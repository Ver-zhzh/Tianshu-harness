import { parseArgs } from 'node:util'
import { openSync, appendFileSync, readFileSync, mkdirSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../config/manager.js'
import { findModelOwner } from '../config/provider-keys.js'
import { createProviderClient, resolveApiKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { readCallAudit } from '../api/call-audit.js'
import { runtimeObservation, RUNTIME_PROVENANCE, withRuntimeRun } from '../utils/runtime-provenance.js'
import type { OaiMessage } from '../api/oai-types.js'
import { RECOVERY_SCENARIOS, type RecoveryArm } from './recovery-scenes.js'
import { evaluateRecoveryTrial, summarizeRecoveryTrials, type RecoveryTrial } from './recovery-evaluation.js'

const { values } = parseArgs({ options: { run: { type: 'boolean', default: false }, provider: { type: 'string' },
  model: { type: 'string' }, output: { type: 'string' }, summarize: { type: 'string' } } })
if (values.summarize) {
  const rows = readFileSync(resolve(values.summarize), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RecoveryTrial)
  const trusted = rows.flatMap(row => readCallAudit({ sessionId: `recovery-${row.runId}`, limit: 50 }).calls)
  const report = summarizeRecoveryTrials(rows, trusted)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.supportsLocalHypothesis ? 0 : 2
} else if (!values.run) {
  console.log(JSON.stringify({ mode: 'dry-run', scenarios: RECOVERY_SCENARIOS, repeats: 3, pairs: 9, trials: 18,
    maxResponsesPerTrial: 5, maxOutputTokensPerResponse: 2048, runtime: RUNTIME_PROVENANCE,
    evidenceScope: 'synthetic contract-observation replay, not end-to-end CLI',
    baseline: 'recorded pre-Phase-1 contract shapes; candidate uses corrected contract shapes',
    usage: 'node dist/benchmark/recovery-cli.js --run --provider NAME --model ID --output NEW.jsonl' }, null, 2))
} else {
  if (!values.provider || !values.model || !values.output) throw new Error('--run requires --provider, --model and --output')
  if (RUNTIME_PROVENANCE.buildId === 'unknown') throw new Error('Use the bundled runner after npm run build; source execution cannot claim a build identity')
  const config = loadConfig(), provider = config.provider.providers[values.provider]
  if (!provider || provider.auth?.type === 'oauth') throw new Error('Select a configured API provider')
  const spec = findModelOwner(provider, values.model)?.model
  if (!spec) throw new Error('Configured model not found')
  const apiKey = resolveApiKey(provider), output = resolve(values.output), experimentId = randomUUID()
  mkdirSync(dirname(output), { recursive: true })
  const descriptor = openSync(output, 'wx', 0o600)
  try {
    for (let repeat = 0; repeat < 3; repeat++) for (const scenario of RECOVERY_SCENARIOS) {
      for (const arm of (repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) as RecoveryArm[]) {
        const runId = randomUUID(), sessionId = `recovery-${runId}`
        const row = await withRuntimeRun({ runId, sessionId }, async () => {
          const client = createProviderClient({ ...provider, maxRetries: 0 }, resolveCapabilities(provider.name, provider.capabilities, spec.capabilities),
            { apiKey, model: spec.id, maxTokens: 2048, sessionId })
          client.setThinking?.('disabled')
          const result = await evaluateRecoveryTrial(scenario, arm, async input => {
            const messages: OaiMessage[] = [{ role: 'system', content: '你在一个受控工具环境中完成任务。每次仅返回一个 JSON 动作对象，不输出解释，只能使用任务列出的动作。所有参数都放在 JSON 顶层，不得嵌套到 values。无参数查询格式为 {"action":"inspect_log"}（其他查询动作同理）；修改格式为 {"action":"apply_edit","version":"已观察的版本"}。report 结束任务，必须有已观察的证据：失败调查格式为 {"action":"report","status":"failed","cause":"有证据的退出原因"}；修改完成格式为 {"action":"report","status":"changed"}；读数报告格式为 {"action":"report","values":[数值1,数值2]}。values 仅用于最后一种数值数组，不能放 status 或 cause。' },
              { role: 'user', content: JSON.stringify({ task: input.task, allowed: input.allowed, observation: input.initial }) }]
            for (const step of input.steps) messages.push({ role: 'assistant', content: step.response }, { role: 'user', content: JSON.stringify(step.observation) })
            let text = '', failure: Error | undefined
            await client.stream({ model: spec.id, max_tokens: 2048, messages }, {
              onTextDelta: delta => { text += delta }, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { failure = error },
            }, AbortSignal.timeout(90_000))
            if (failure) throw failure
            const identity = runtimeObservation()
            return { text, requestId: identity.requestId, attemptId: identity.attemptId }
          })
          return { protocolVersion: 'flat-actions-v2', experimentId, runId, scenario, repeat, arm, provider: values.provider!, model: spec.id, runtime: RUNTIME_PROVENANCE,
            mode: 'live-model' as const, review: 'unreviewed' as const,
            attempts: readCallAudit({ sessionId, limit: 50 }).calls.map(({ requestId, attemptId, operationId, responseModel, status, usageKnown, usage }) =>
              ({ requestId, attemptId, operationId, responseModel, status, usageKnown, usage })), ...result }
        })
        appendFileSync(descriptor, JSON.stringify(row) + '\n')
        console.log(`${scenario} ${repeat + 1}/3 ${arm}: ${row.outcome.passed ? 'passed' : 'failed'}, responses=${row.steps.length}`)
        if (row.error) throw new Error('Provider attempt failed; partial results retained, no automatic retry')
      }
    }
  } finally { closeSync(descriptor) }
}
