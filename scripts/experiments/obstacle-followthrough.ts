#!/usr/bin/env tsx
/** Live DeepSeek model, production prompt renderer, controlled tools. Not a full AgentLoop benchmark. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { OBSTACLE_CASES, OBSTACLE_TOOLS, ObstacleWorld } from './obstacle-fixtures.js'
import type { AdvisoryEntry } from '../../src/agent/advisory-bus.js'

const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback
const phase = option('--phase', 'A')
if (!/^(A|B\d*)$/.test(phase)) throw new Error('phase must be A, B, or a numbered B revision')
const output = resolve(option('--output', '.rivet/research/2026-10-19-deepseek1017-ab'))
const repetitions = Number(option('--repetitions', '1'))
if (![1, 2, 3].includes(repetitions)) throw new Error('repetitions must be 1..3')
const maxSteps = 12
const maxTrialOutputTokens = 24_000
const model = 'deepseek-flash'
const parameters = { model, thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192, temperature: 1, top_p: 1, stream: false }
const domains = ['taiyi', 'yaoguang'] as const
const signal = AbortSignal.timeout(30 * 60_000)

// Resolve only the configured official provider through the normal credential resolver.
// Do not loadConfig(): that entry may persist migrations. Never serialize this config or key.
const { userConfigPath } = await import('../../src/config/paths.js')
let provider: any = { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' }
if (!process.env.DEEPSEEK_API_KEY && existsSync(userConfigPath())) {
  const config = JSON.parse(readFileSync(userConfigPath(), 'utf8'))
  provider = config.provider?.providers?.deepseek ?? provider
}
const endpoint = new URL(provider.baseUrl ?? 'https://api.deepseek.com')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('This experiment requires the official DeepSeek endpoint')
const { resolveApiKey } = await import('../../src/api/factory.js')
let credential: string
try { credential = resolveApiKey({ ...provider, name: 'deepseek' }) } catch { throw new Error('Official DeepSeek credential unavailable through the configured resolver') }
const api = endpoint.origin + endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
const preflight = await fetch(api + '/models', { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
if (!preflight.ok) throw new Error(`Official model preflight failed: HTTP ${preflight.status}`)
const catalog = await preflight.json() as any
if (!catalog.data?.some((v: any) => v.id === model)) throw new Error('Official model catalog does not expose the selected model')

// Runtime imports happen only after session/test roots have been detached from real data.
const isolation = join(tmpdir(), 'tianshu-obstacle-experiment-' + process.pid)
process.env.RIVET_HOME = isolation
process.env.RIVET_SESSION_DIR = join(isolation, 'sessions')
process.env.RIVET_TRUST_PROJECT = '0'
const { PromptEngine } = await import('../../src/prompt/engine.js')
const { STAR_DOMAINS } = await import('../../src/agent/star-domain-data.js')
const { createErrorDiagnosisHook } = await import('../../src/agent/hooks/error-diagnosis-hook.js')
mkdirSync(output, { recursive: true })
const phaseDir = join(output, phase)
if (existsSync(phaseDir)) throw new Error('Phase directory already exists; use a new output directory rather than overwrite evidence')
mkdirSync(phaseDir)
const append = (file: string, value: unknown) => appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 })
const sources = ['src/prompt/static.ts', 'src/prompt/volatile.ts', 'src/prompt/engine.ts', 'src/agent/star-domain-data.ts', 'src/agent/hooks/error-diagnosis-hook.ts', 'scripts/experiments/obstacle-fixtures.ts']
const sourceHashes = Object.fromEntries(sources.map(p => [p, hash(readFileSync(resolve(p), 'utf8'))]))
const protocol = { version: 3, model, parameters, domains, repetitions, maxSteps, maxTrialOutputTokens, fixtureHash: hash(OBSTACLE_CASES), toolsHash: hash(OBSTACLE_TOOLS), seedPolicy: 'same one failed tool call, no seeded assistant explanation; no user correction after failure', toolMode: 'controlled synchronous fixture with enumerated actions, no actual shell execution', promptMode: 'production PromptEngine with minimal isolated context; domain volatileBlock, not worker-only suffix', scoring: 'objective facts from fixture; manual unsupported-attribution/early-stop/boundary review; adapter and transport failures separate' }
if (phase.startsWith('B')) {
  const original = JSON.parse(readFileSync(join(output, 'A', 'manifest.json'), 'utf8'))
  if (hash(original.protocol) !== hash(protocol)) throw new Error('A/B protocol changed; refuse comparison')
  for (const p of ['src/prompt/volatile.ts', 'src/prompt/engine.ts', 'scripts/experiments/obstacle-fixtures.ts']) if (sourceHashes[p] !== original.sourceHashes[p]) throw new Error(`Uncontrolled source changed: ${p}`)
}
writeFileSync(join(phaseDir, 'manifest.json'), JSON.stringify({ phase, startedAt: new Date().toISOString(), protocol, sourceHashes }, null, 2), { mode: 0o600, flag: 'wx' })
const results: any[] = []

for (let repetition = 0; repetition < repetitions; repetition++) for (const domain of domains) for (const fixture of OBSTACLE_CASES) {
  signal.throwIfAborted()
  const id = `${domain}-${fixture.id}-${repetition + 1}`
  const trace = join(phaseDir, id + '.jsonl')
  const world = new ObstacleWorld(fixture)
  const d = STAR_DOMAINS[domain]
  const engine = new PromptEngine({ model, maxTokens: 8192, staticCtx: { tools: OBSTACLE_TOOLS, modelFamily: 'deepseek' }, volatileCtx: { cwd: '/workspace/fixture', activeDomain: { name: d.name, motto: d.motto, volatileBlock: d.volatileBlock } } })
  const messages: any[] = [{ role: 'user', content: fixture.goal, origin: 'human' }, { role: 'assistant', content: null, reasoning_content: '', tool_calls: [{ id: 'seed-failure', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: fixture.initialCommand }) } }] }, { role: 'tool', tool_call_id: 'seed-failure', content: fixture.initialResult }]
  if (fixture.failureClass) {
    const notices: any[] = []
    const hook = createErrorDiagnosisHook({ advisoryBus: { submit: (e: AdvisoryEntry) => notices.push(e) } })
    await hook.run({ snapshot: { turn: 0 } } as any, { name: 'bash', isError: true, success: false, target: fixture.initialCommand, failureClass: fixture.failureClass, input: { command: fixture.initialCommand } } as any)
    for (const notice of notices) messages.push({ role: 'user', origin: 'hook', content: `<system-reminder>${notice.content}</system-reminder>` })
  }
  const built = engine.buildOaiRequest(messages, undefined, 1_000_000)
  const wire: any[] = structuredClone(built.messages)
  const requestBase = { ...parameters, tools: built.tools }
  append(trace, { kind: 'initial', id, messages: wire, tools: built.tools, promptHash: hash(wire), fixture: fixture.id })
  let status = 'step-budget', outputTokens = 0, final = '', calls = 0
  const responseModels = new Set<string>(), fingerprints = new Set<string>()
  const started = Date.now()
  for (let step = 0; step < maxSteps; step++) {
    signal.throwIfAborted()
    const body = { ...requestBase, messages: wire }
    const requestAt = new Date().toISOString()
    let response: Response
    try {
      response = await fetch(api + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
    } catch (error) { status = signal.aborted ? 'experiment-cancelled' : 'transport-error'; append(trace, { kind: status, step, errorName: error instanceof Error ? error.name : 'unknown' }); break }
    if (!response.ok) {
      const error = await response.json().catch(() => null) as any
      const detail = String(error?.error?.message ?? '').replaceAll(credential, '[redacted]').replace(/\bsk-[\w-]+/g, '[redacted]').slice(0, 700)
      append(trace, { kind: 'http-error', step, httpStatus: response.status, detail })
      throw new Error(`Experiment transport rejected the request (HTTP ${response.status}); inspect the redacted trace before retrying`)
    }
    let data: any
    try { data = await response.json() } catch { status = 'invalid-response'; break }
    const choice = data.choices?.[0], message = choice?.message
    if (!message || message.role !== 'assistant') { status = 'invalid-response'; break }
    responseModels.add(data.model ?? 'absent'); fingerprints.add(data.system_fingerprint ?? 'absent')
    outputTokens += data.usage?.completion_tokens ?? 0
    const { reasoning_content: reasoning, ...visible } = message
    append(trace, { kind: 'response', step, requestAt, responseId: data.id, responseModel: data.model, fingerprint: data.system_fingerprint ?? null, finishReason: choice.finish_reason, usage: data.usage, assistant: visible, reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0, reasoningHash: reasoning ? hash(reasoning) : null })
    // Preserve provider-required thinking in memory for continuation, never persist it as experiment prose.
    wire.push(message)
    final = message.content ?? ''
    if (choice.finish_reason === 'length') { status = 'output-truncated'; break }
    if (!message.tool_calls?.length) { status = choice.finish_reason === 'stop' ? 'final' : 'unexpected-finish'; break }
    for (const call of message.tool_calls) {
      let input: Record<string, unknown>
      try { input = JSON.parse(call.function.arguments) } catch { status = 'invalid-tool-arguments'; break }
      const result = world.execute(call.function.name, input); calls++
      wire.push({ role: 'tool', tool_call_id: call.id, content: result })
      append(trace, { kind: 'tool', step, callId: call.id, ...world.events.at(-1), facts: [...world.facts] })
    }
    if (status === 'invalid-tool-arguments') break
    if (outputTokens >= maxTrialOutputTokens) { status = 'token-budget'; break }
  }
  const result = { id, domain, fixture: fixture.id, repetition: repetition + 1, status, ...world.outcome(), calls, outputTokens, elapsedMs: Date.now() - started, responseModels: [...responseModels], fingerprints: [...fingerprints], final }
  results.push(result)
  append(join(phaseDir, 'results.jsonl'), result)
  console.log(JSON.stringify({ phase, id, status, objectiveObserved: result.objectiveObserved, adapterBlocked: result.adapterBlocked, calls, outputTokens }))
}
writeFileSync(join(phaseDir, 'summary.json'), JSON.stringify({ phase, completedAt: new Date().toISOString(), protocolHash: hash(protocol), trials: results.length, results }, null, 2), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ phase, trials: results.length, objectiveObserved: results.filter(r => r.objectiveObserved).length, completed: results.filter(r => r.status === 'final').length }))
