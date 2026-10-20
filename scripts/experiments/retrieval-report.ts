import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const args = process.argv.slice(2), opt = (k: string) => args[args.indexOf(k) + 1]
if (!args.includes('--input') || !args.includes('--output')) throw new Error('Use --input evidence-directory --output new-analysis.json')
const root = resolve(opt('--input')!), output = resolve(opt('--output')!)
if (existsSync(output)) throw new Error('Analysis must have a fresh path; never overwrite evidence')
const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')), manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const results = summary.results.map((r: any) => {
  const trace = readFileSync(join(root, r.phase, r.id + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const responses = trace.filter((row: any) => row.kind === 'response'), dispatches = trace.filter((row: any) => row.kind === 'dispatch')
  const measured = responses.map((row: any) => row.usage).filter((u: any) => u?.observation?.status === 'complete')
  const reasoningMeasured = measured.filter((u: any) => u.observation.fields.reasoning_tokens && Number.isSafeInteger(u.reasoning_tokens) && u.reasoning_tokens >= 0 && u.reasoning_tokens <= u.output_tokens)
  const knownReasoning = reasoningMeasured.reduce((n: number, u: any) => n + u.reasoning_tokens, 0)
  const modelLoopMs = dispatches.length && responses.length ? Date.parse(responses.at(-1).at) - Date.parse(dispatches[0].at) : null
  const byTool: Record<string, { calls: number; bytes: number; repeatedBytesLowerBound: number }> = {}
  for (const m of r.metrics) { const stats = byTool[m.tool] ??= { calls: 0, bytes: 0, repeatedBytesLowerBound: 0 }; stats.calls++; stats.bytes += m.bytes; stats.repeatedBytesLowerBound += m.duplicateVisibleBytes }
  const cases = r.grade.parsed?.results ?? []
  return { id: r.id, task: r.task, arm: r.arm, phase: r.phase, status: r.status, requests: r.requests, budget: r.budget, adapterFaults: r.adapterFaults,
    grade: r.grade.passed === true, cases: Object.fromEntries(cases.map((c: any) => [c.id, c.verdict])), recordedTotalElapsedMs: r.elapsedMs, modelLoopMs,
    knownReasoningTokens: knownReasoning, reasoningBreakdownComplete: reasoningMeasured.length === responses.length,
    nonReasoningCompletionIfFullyMeasured: reasoningMeasured.length === responses.length ? r.budget.spent - knownReasoning : null,
    latencyEligibleForSuccessComparison: r.status === 'final' && r.grade.passed === true,
    firstMeasuredInput: r.inputObservations[0] ?? null, lastMeasuredInput: r.inputObservations.at(-1) ?? null,
    peakMeasuredInput: r.inputObservations.length ? Math.max(...r.inputObservations) : null,
    sumOfObservedInputs: r.inputObservations.reduce((a: number, b: number) => a + b, 0), byTool,
    finalReportToReview: join(root, r.phase, r.id + '.jsonl'), claimReview: 'pending-human-review; correctness scores do not certify every natural-language assertion' }
})
const analysis = { protocol: summary.protocol.version, source: root, sourcesMatchedAtRunEnd: summary.finalSourcesMatch,
  registeredPilotCount: manifest.protocol.order.length, observedPilotCount: results.filter((r: any) => r.phase === 'ablation').length,
  capacity: existsSync(join(root, 'capacity-decision.json')) ? JSON.parse(readFileSync(join(root, 'capacity-decision.json'), 'utf8')) : null,
  analysisRevision: 'post-run trace-derived model interval and explicit reasoning breakdown; no extra model calls or grading changes',
  limitations: ['UTF-8 bytes are not tokens', 'exact version-bound repeated output is a lower bound, not all semantic redundancy', 'sum of inputs is repeated request volume, not context occupancy or monetary cost', 'recorded total elapsed includes qualification, grading and archiving; modelLoopMs excludes them', 'reasoning is a subset of completion, never added to it', 'provider cache and concurrency can affect latency; wall time alone is not a causal effect', 'capacity is not a calibration treatment', 'controlled macOS loop, no full AgentLoop or Windows acceptance', 'pilot size does not establish non-inferiority or significance'], results }
writeFileSync(output, JSON.stringify(analysis, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ output, registeredPilotCount: analysis.registeredPilotCount, observedPilotCount: analysis.observedPilotCount, capacity: analysis.capacity, trials: results.map((r: any) => ({ id: r.id, status: r.status, passed: r.grade, tools: r.byTool })) }))
