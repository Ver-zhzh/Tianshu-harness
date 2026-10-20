#!/usr/bin/env tsx
/** Calibration-only ablation; no production prompt or error-feedback treatment. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { providerSchema } from '../../src/config/schema.js'
import { PROVIDER_PRESETS } from '../../src/config/provider-presets.js'
import { userConfigPath } from '../../src/config/paths.js'
import { resolveModelBinding } from '../../src/model/model-binding.js'
import { productionProfile, productionClient, qualifyTransport, experimentRequest, streamAttempt, assistantMessage } from './experiment-stream.js'
import { CompletionLedger } from './experiment-protocol.js'
import { sha } from './recovery-long-world.js'
import { RetrievalSearch } from './retrieval-search.js'
import { retrievalTask, retrievalGrade, ReadonlyAliasWorld } from './retrieval-tasks.js'
import { retrievalRequest, retrievalOrder, capacityQualified, CURRENT_CALIBRATION, RETRIEVAL_CALIBRATION, RETRIEVAL_TASKS, type RetrievalArm, type RetrievalTask } from './retrieval-policy.js'

const args = process.argv.slice(2), opt = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1]! : fallback
const live = args.includes('--live'), output = resolve(opt('--output', '.rivet/research/2026-10-20-retrieval-v1'))
const order = retrievalOrder(Number(opt('--repetitions', '1'))), model = opt('--model', 'deepseek-flash')
if (existsSync(output)) throw new Error('Use a fresh evidence directory')
let rawProvider: unknown = PROVIDER_PRESETS.deepseek.provider
if (existsSync(userConfigPath())) rawProvider = JSON.parse(readFileSync(userConfigPath(), 'utf8')).provider?.providers?.deepseek ?? rawProvider
const provider = providerSchema.parse(rawProvider), endpoint = new URL(provider.baseUrl)
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Official HTTPS DeepSeek endpoint required')
const profile = productionProfile(provider, model), binding = live ? resolveModelBinding({ deepseek: provider }, { provider: 'deepseek', model }) : undefined
if (live && !binding?.apiKey) throw new Error('Configured credential unavailable')
const credential = binding?.apiKey, isolated = mkdtempSync(join(tmpdir(), 'rivet-retrieval-run-'))
process.env.RIVET_HOME = isolated; process.env.RIVET_SESSION_DIR = join(isolated, 'sessions'); process.env.RIVET_TRUST_PROJECT = '0'; process.env.RIVET_RTK = '0'
delete process.env.RIVET_DEBUG_RAW_SSE
writeFileSync(join(isolated, 'config.json'), '{}')
process.once('exit', () => rmSync(isolated, { recursive: true, force: true }))
const controlled = ['src/prompt/static.ts', 'src/prompt/engine.ts', 'src/prompt/volatile.ts', 'src/prompt/domain-task-boundary.ts', 'src/agent/star-domain-data.ts',
  'src/tools/grep.ts', 'src/tools/grep-ripgrep.ts', 'src/tools/bounded-scan.ts', 'src/tools/read-file.ts', 'src/tools/read-section.ts', 'src/tools/edit.ts', 'src/tools/write-file.ts',
  'src/api/factory.ts', 'src/api/openai-client.ts', 'src/api/request-invariant.ts', 'src/api/tool-call-name.ts', 'src/context/request-budget.ts',
  ...readdirSync('scripts/experiments').filter(p => /^(retrieval-|experiment-|recovery-long|scoped-hook).*\.ts$/.test(p)).map(p => 'scripts/experiments/' + p)]
const hashes = () => Object.fromEntries(controlled.map(p => [p, sha(readFileSync(p))])), frozen = hashes()
const guard = () => { if (sha(hashes()) !== sha(frozen)) throw new Error('Controlled sources changed; stop this registered run') }
const protocol = { version: 'retrieval-calibration-v4-scoped-projection', profile, requestLimit: profile.maxTokens, trialCompletionLimit: 2 * profile.maxTokens, maxRequests: 60, trialMinutes: 25, concurrency: 2,
  arms: { A: CURRENT_CALIBRATION, B: '', C: '\n\n' + RETRIEVAL_CALIBRATION }, tasks: RETRIEVAL_TASKS, order, capacityRuns: 2, retries: 0, feedback: 'neutral tool observations only; no acknowledgement',
  primary: ['independent behaviour obligations', 'scoped attribution and unsupported claims require human review'], secondary: ['time conditional on correctness', 'per-tool visible UTF-8 bytes', 'version-bound repeated output', 'measured request input and completion'],
  scope: 'controlled PromptEngine loop, not full AgentLoop; macOS only; no production changes', stop: 'two neutral natural finals, measured usage and no adapter faults; otherwise no ablation' }
mkdirSync(output, { recursive: true })
for (const p of controlled) { const target = join(output, 'frozen-source', p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(p)) }
const save = (p: string, row: unknown) => writeFileSync(join(output, p), JSON.stringify(row, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
save('manifest.json', { at: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), protocol, frozen })
const clean = (s: string) => (credential ? s.replaceAll(credential, '[redacted]') : s).replace(/\bsk-[\w-]{8,}/g, '[redacted]')
const append = (p: string, row: unknown) => appendFileSync(join(output, p), clean(JSON.stringify({ at: new Date().toISOString(), ...row as object })) + '\n', { mode: 0o600 })
const qualification: any[] = [], results: any[] = [], abort = new AbortController()
process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort())
try {
  const transport = await qualifyTransport(provider, model); save('transport-qualification.json', transport)
  if (!transport.passed) throw new Error('Offline transport qualification failed; no billable sends')
  for (const task of RETRIEVAL_TASKS) for (const fixed of task === 'readonly-alias' ? [false] : [false, true]) {
    const { world } = retrievalTask(task, fixed), search = new RetrievalSearch(world)
    try {
      await search.initialize(); const environment = await world.preflight(), grep = await search.qualify(), checks = await world.checks()
      const grade = world instanceof ReadonlyAliasWorld ? world.gradeReport(JSON.stringify({ actualMs: 250, zeroDisables: false, implementationFiles: ['src/client.mjs', 'src/config.mjs'], environmentBlocked: false })) : await world.grade()
      qualification.push({ task, fixed, environment, grep, checks, grade })
      if (!environment.passed || !grep.passed || !checks.complete || checks.passed !== (fixed || task === 'readonly-alias') || grade.passed !== (fixed || task === 'readonly-alias')) throw new Error('Task/environment qualification failed: ' + task)
      console.log(JSON.stringify({ qualification: task, fixed, passed: true }))
    } finally { world.close() }
  }
  save('qualification.json', qualification); guard()
  if (live) {
    const [{ PromptEngine }, { STAR_DOMAINS }] = await Promise.all([import('../../src/prompt/engine.js'), import('../../src/agent/star-domain-data.js')])
    async function trial(id: string, task: RetrievalTask, arm: RetrievalArm, phase: 'capacity' | 'ablation') {
      guard()
      const { world, goal } = retrievalTask(task), search = new RetrievalSearch(world), ledger = new CompletionLedger(profile.maxTokens)
      const directory = join(phase, id), trace = directory + '.jsonl'; mkdirSync(join(output, phase), { recursive: true })
      const timerAbort = new AbortController(), timer = setTimeout(() => timerAbort.abort(), protocol.trialMinutes * 60_000), signal = AbortSignal.any([abort.signal, timerAbort.signal])
      let status = 'request-limit', final = '', requests = 0, adapterFaults = 0
      const started = Date.now(), inputObservations: number[] = []
      try {
        await search.initialize(); const environment = await world.preflight(), grep = await search.qualify()
        append(trace, { kind: 'preflight', environment, grep })
        if (!environment.passed || !grep.passed) { adapterFaults++; throw new Error('Declared environment failed; no model request') }
        world.events.length = 0; search.resetMetrics()
        const { client, policy } = productionClient(provider, credential!, model, 'retrieval-' + randomUUID())
        if (client.getExecutionPolicy?.().singleAttempt !== true) throw new Error('singleAttempt not consumed')
        const domain = STAR_DOMAINS.qisha
        const engine = new PromptEngine({ model, maxTokens: profile.maxTokens, staticCtx: { tools: search.definitions(), modelFamily: 'deepseek' }, volatileCtx: { cwd: world.root, activeDomain: { name: domain.name, motto: domain.motto, volatileBlock: domain.volatileBlock } } })
        const built = retrievalRequest(engine.buildOaiRequest([{ role: 'user', origin: 'human', content: goal }], undefined, profile.contextWindow), arm), wire = structuredClone(built.messages)
        append(trace, { kind: 'initial', id, task, arm, phase, messages: wire, tools: built.tools, initialHashes: world.initialHashes, normalizedPromptHash: sha(JSON.stringify(wire).replaceAll(world.root, '<workspace>')) })
        for (let step = 0; step < protocol.maxRequests; step++) {
          signal.throwIfAborted(); guard()
          if (ledger.uncertain) { status = 'usage-uncertain'; break }
          if (ledger.trialLimit - ledger.spent < ledger.requestLimit) { status = 'insufficient-completion-budget'; break }
          append(trace, { kind: 'dispatch', step, requestHash: sha(wire), ledger: ledger.snapshot() }); requests++
          let lastProgress = 0
          const r = await streamAttempt(client, experimentRequest(built, wire, model, profile.maxTokens), ledger, signal, policy, event => { if (Date.now() - lastProgress > 30_000) { lastProgress = Date.now(); append(trace, { kind: 'progress', step, event }) } })
          const assistant = assistantMessage(r.blocks), { reasoning_content: reasoning, ...visible } = assistant
          append(trace, { kind: 'response', step, status: r.status, reason: r.reason, usage: r.usage, reasoningChars: reasoning.length, assistant: visible, errorName: r.errorName, errorMessage: r.errorMessage?.slice(0, 2000), elapsedMs: r.elapsedMs, ledger: ledger.snapshot() })
          if (r.usage?.observation?.status === 'complete' && r.usage.input_tokens !== undefined) inputObservations.push(r.usage.input_tokens)
          if (!['tools', 'final'].includes(r.status)) { status = r.status; break }
          wire.push(assistant)
          if (r.status === 'final') { final = assistant.content; status = 'final'; break }
          for (const call of assistant.tool_calls ?? []) {
            signal.throwIfAborted()
            const input = JSON.parse(call.function.arguments), result = await search.execute(call.function.name, input, signal)
            wire.push({ role: 'tool', tool_call_id: call.id, content: result.content })
            append(trace, { kind: 'tool', step, callId: call.id, ...world.events.at(-1), metric: search.metrics.at(-1) })
            if (result.observation?.origin === 'harness' || result.observation?.code === 'execution_unresolved') { adapterFaults++; status = 'experiment-inconclusive'; break }
          }
          if (status === 'experiment-inconclusive') break
        }
      } catch (error) {
        status = signal.aborted ? 'deadline-or-cancelled' : error instanceof Error && error.name === 'ContextBudgetExceededError' ? 'context-insufficient' : 'experiment-inconclusive'
        append(trace, { kind: status, message: String(error).slice(0, 1000) })
      } finally { clearTimeout(timer) }
      try {
        let grade: any
        try { grade = await retrievalGrade(world, final) } catch (e) { grade = { passed: false, verdict: 'inconclusive', error: String(e).slice(0, 1000) } }
        for (const p of world.files()) { const target = join(output, directory + '-artifact', p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, clean(world.artifact(p)), { mode: 0o600 }) }
        const result = { id, task, arm, phase, status, requests, budget: ledger.snapshot(), adapterFaults, elapsedMs: Date.now() - started, inputObservations, metrics: search.metrics, grade, final }
        results.push(result); append(phase + '/results.jsonl', result)
        console.log(JSON.stringify({ id, task, arm, phase, status, budget: ledger.snapshot(), passed: grade.passed, cases: grade.parsed?.results.filter((r: any) => r.passed).length }))
        return result
      } finally { world.close() }
    }
    const capacity = await Promise.all([trial('capacity-1', 'scoped-hook', 'A', 'capacity'), trial('capacity-2', 'scoped-hook', 'A', 'capacity')])
    const qualified = capacityQualified(capacity); save('capacity-decision.json', { qualified, ids: capacity.map(r => r.id), rule: protocol.stop })
    if (qualified && !args.includes('--capacity-only')) {
      let cursor = 0
      const workers = await Promise.allSettled(Array.from({ length: 2 }, async () => { while (!abort.signal.aborted && cursor < order.length) { const i = cursor++, r = order[i]!; await trial(`${i + 1}-${r.task}-${r.arm}-${r.repetition}`, r.task, r.arm, 'ablation') } }))
      for (const worker of workers) if (worker.status === 'rejected') throw worker.reason
    }
  }
} finally {
  if (!existsSync(join(output, 'qualification.json'))) save('qualification.json', qualification)
  save('summary.json', { at: new Date().toISOString(), protocol, finalSourcesMatch: sha(hashes()) === sha(frozen), results })
  rmSync(isolated, { recursive: true, force: true })
}
