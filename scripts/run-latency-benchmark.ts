import { parseArgs } from 'node:util'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadTaskSuite } from '../src/benchmark/task-suite.js'
import { createRivetCliBenchmarkExecutor } from '../src/benchmark/executor.js'
import { reasoningPairEligibility, type LatencyObservation } from '../src/benchmark/latency-comparison.js'

const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  experiment: { type: 'string', default: 'reasoning' }, run: { type: 'boolean', default: false },
  output: { type: 'string' }, 'agent-entry': { type: 'string', default: 'dist/main.js' },
} })
if (!['reasoning', 'prompt'].includes(values.experiment!)) throw new Error('experiment must be reasoning or prompt')
const suite = loadTaskSuite(resolve('benchmark/tasks/latency-readonly.json'))
if (!values.run) {
  console.log(JSON.stringify({ experiment: values.experiment, tasks: suite.tasks.length, repeats: 3, arms: 2, executions: 120,
    quality: 'requires independent per-task review; process exit is not a quality verdict', tasksByKind: { simple: 10, routine: 5, complex: 5 } }, null, 2))
} else {
  if (!values.workspace || !values.provider || !values.model || !values.output) throw new Error('--run requires --workspace, --provider, --model and --output')
  if (resolve(values.workspace) === process.cwd()) throw new Error('Use a separate benchmark checkout, not the shared development workspace')
  const output = resolve(values.output), runId = randomUUID()
  mkdirSync(dirname(output), { recursive: true })
  for (let repeat = 0; repeat < 3; repeat++) for (const task of suite.tasks) {
    const pair: Partial<Record<'baseline' | 'candidate', LatencyObservation[]>> = {}
    // Alternate order so warming and provider load do not always favour one arm.
    for (const arm of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const root = join(dirname(output), `sessions-${runId}`, `${task.id}-${repeat}-${arm}`)
      const enabled = arm === 'candidate' ? '1' : '0'
      const executor = createRivetCliBenchmarkExecutor({ cwd: resolve(values.workspace), entryPoint: resolve(values['agent-entry']!),
        provider: values.provider, model: values.model, sessionDataRoot: root, allowWriteTools: false,
        env: { ...process.env, RIVET_LATENCY_REASONING_EXPERIMENT: values.experiment === 'reasoning' ? enabled : '0',
          RIVET_LATENCY_PROMPT_EXPERIMENT: values.experiment === 'prompt' ? enabled : '0' } })
      const result = await executor.execute(task)
      let observations: LatencyObservation[] = []
      if (result.session?.sessionId) {
        try {
          observations = readFileSync(join(root, task.id, result.session.sessionId, 'cache-log.jsonl'), 'utf8').trim().split('\n')
            .map(line => JSON.parse(line)).filter(row => row.event === undefined).map(row => ({
              ttftMs: row.ttftMs, firstTextMs: row.firstTextMs, runFirstTextMs: row.runFirstTextMs, preRequestMs: row.preRequestMs, requestDurationMs: row.requestDurationMs,
              input: row.input, cacheRead: row.cacheRead, model: row.model, provider: row.provider,
              effort: row.wire?.options?.reasoning_effort ?? row.wire?.options?.reasoning?.effort ?? row.wire?.options?.output_config?.effort,
              generationReason: row.continuity?.generationReason, cacheGenerationId: row.continuity?.cacheGenerationId,
            }))
        } catch { /* failed runs retain unknown observations */ }
      }
      appendFileSync(output, JSON.stringify({ runId, taskId: task.id, tags: task.tags, repeat, arm, experiment: values.experiment,
        provider: values.provider, model: values.model, result, observations, quality: 'unreviewed' }) + '\n')
      console.log(`${task.id} repeat=${repeat + 1} ${arm}: ${result.status}`)
      pair[arm as 'baseline' | 'candidate'] = observations
    }
    if (values.experiment === 'reasoning' && task.tags.includes('simple')
      && reasoningPairEligibility(pair.baseline ?? [], pair.candidate ?? []) !== 'eligible') {
      throw new Error('Reasoning experiment has no verified wire contrast; both runs are retained. Choose a provider with a distinct medium level; existing capability mappings were preserved.')
    }
  }
}
