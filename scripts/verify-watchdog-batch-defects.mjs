import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
// Mutations are loaded in memory; concurrent worktree edits are never rewritten.
const root = resolve(import.meta.dirname, '..')
const require = createRequire(root + '/package.json')
const { transformSync } = require('esbuild')
const cases = [
  ['watchdog controller reset', 'src/agent/loop.ts', 'this.abortController = new AbortController()\n    return true', 'return true', 'watchdog-rescue.test.ts', 'completed batch continues'],
  ['user abort priority', 'src/agent/loop.ts', 'this._pendingAbort || !this._watchdogAborted', '!this._watchdogAborted', 'watchdog-rescue.test.ts', 'user Esc during drain'],
  ['Esc preservation during endTurn rescue', 'src/agent/loop.ts', ' || this._pendingAbort', '', 'watchdog-rescue.test.ts', 'pending Esc wins', 'this._pendingAbort || !this._watchdogAborted', '!this._watchdogAborted'],
  ['prewarm lookup key', 'src/agent/coordinator.ts', 'batchPrewarmByOrder.get(order.parentTurnId)', 'batchPrewarmByOrder.get(order.id)', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['stigmergy lookup key', 'src/agent/coordinator.ts', 'batchStigmergyByOrder.get(order.parentTurnId)', 'batchStigmergyByOrder.get(order.id)', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['old prewarm side table', 'src/agent/coordinator.ts', /batchPrewarmByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchPrewarmByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['old stigmergy side table', 'src/agent/coordinator.ts', /batchStigmergyByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchStigmergyByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['prewarm cross-batch cleanup', 'src/agent/coordinator.ts', /batchPrewarmByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchPrewarmByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', 'settling one batch'],
  ['stigmergy cross-batch cleanup', 'src/agent/coordinator.ts', /batchStigmergyByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchStigmergyByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', 'settling one batch'],
  ['blocked-order cleanup', 'src/agent/coordinator.ts', 'for (const o of orders) this.releaseDispatch(o)', '', 'batch-side-table-isolation.test.ts', 'dependency-blocked'],

  ['cancel controllers keyed by logical ID', 'src/agent/coordinator.ts', /orderControllers\.(get|set|delete)\((order|o)\.parentTurnId/g, 'orderControllers.$1($2.id', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['live snapshots keyed by logical ID', 'src/agent/coordinator.ts', /liveMessages\.(get|set|delete)\(order\.parentTurnId/g, 'liveMessages.$1(order.id', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['activity upstream lookup keyed by logical ID', 'src/agent/coordinator.ts', 'activityUpstream.get(order.parentTurnId)', 'activityUpstream.get(order.id)', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['nested upstream lookup keyed by logical ID', 'src/agent/coordinator.ts', 'nestedUpstream.get(order.parentTurnId)', 'nestedUpstream.get(order.id)', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['steer drain keyed by logical ID', 'src/agent/coordinator.ts', 'steerQueues.get(order.parentTurnId)', 'steerQueues.get(order.id)', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['heartbeat keyed by logical ID', 'src/agent/coordinator.ts', 'liveness.tick(order.parentTurnId)', 'liveness.tick(order.id)', 'batch-side-table-isolation.test.ts', 'exact dispatch kill'],
  ['dispatch nonces keyed by logical ID', 'src/agent/coordinator.ts', /dispatchNonces\.(get|set|delete)\(order\.parentTurnId/g, 'dispatchNonces.$1(order.id', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['policy cancels wrong dispatch', 'src/agent/coordinator.ts', 'orderControllers.get(o.parentTurnId)?.abort()', 'orderControllers.get(o.id)?.abort()', 'batch-side-table-isolation.test.ts', 'policy cancel-rest'],
  ['resume state keyed by logical ID', 'src/agent/coordinator.ts', /(resumeSources|resumeMessages|resumeBaselines|resumeCheckpoints)\.(get|set|delete|has)\(order\.parentTurnId/g, '$1.$2(order.id', 'batch-side-table-isolation.test.ts', 'resume state and checkpoints'],
  ['file reservations keyed by logical ID', 'src/agent/coordinator.ts', /inflightFiles\.(get|set|delete)\(order\.parentTurnId/g, 'inflightFiles.$1(order.id', 'batch-side-table-isolation.test.ts', 'cross-batch writers', 'inflightId === order.parentTurnId', 'inflightId === order.id'],
  ['disk read strips dispatch identity', 'src/agent/worker-result-store.ts', 'result[key] = metadata[key]', 'void metadata[key]', 'batch-side-table-isolation.test.ts', 'dispatch controls'],
  ['session round archive omitted', 'src/agent/worker-session-persist.ts', /    if \(dispatchNonce && !writeAtomic\(workerSessionRoundPath[^\n]+\n/, '', 'src/server/__tests__/worker-log-route.test.ts', 'dispatch-selected log'],
  ['attempt controls unresolved', 'src/agent/coordinator.ts', /    for \(const \[dispatchId, attemptId\] of this.dispatchAttempts\) \{\n[^\n]+\n    \}\n/, '', 'batch-side-table-isolation.test.ts', 'reused dispatch rejects'],
  ['late nested callback routes into new attempt', 'src/agent/coordinator.ts', 'workerConfig.onNestedDelegation = (activity) => {\n      if (this.orderControllers.get(order.parentTurnId) !== orderController) return', 'workerConfig.onNestedDelegation = (activity) => {', 'batch-side-table-isolation.test.ts', 'reused dispatch rejects'],
  ['late steer callback drains new attempt', 'src/agent/coordinator.ts', '      if (this.orderControllers.get(order.parentTurnId) !== orderController) return null\n', '', 'batch-side-table-isolation.test.ts', 'reused dispatch rejects'],
  ['historical log selects current live dispatch', 'src/server/session-manager.ts', 'opts?.attemptId ?? opts?.dispatchId ?? workerId', 'opts?.dispatchId ?? workerId', 'src/server/__tests__/worker-log-route.test.ts', 'historical attempt'],
  ['TUI collapses distinct attempts', 'src/tools/worker-identity.ts', 'worker.attemptId ?? worker.dispatchId', 'worker.dispatchId', 'src/tui/__tests__/fleet-registry.test.ts', 'reused dispatch ID keeps'],
  ['TUI mixes distinct transcripts', 'src/tools/worker-identity.ts', 'worker.attemptId ?? worker.dispatchId', 'worker.dispatchId', 'src/tui/__tests__/worker-mirror.test.ts', 'reused dispatch ID preserves'],
  ['stale sweep keeps an old attempt alive', 'src/server/session-manager.ts', 'attemptId ?? dispatchId ?? workerId', 'dispatchId ?? workerId', 'src/server/__tests__/delegation-stale-sweep.test.ts', 'stale sweep and live delegation query'],
  ['live query mistakes a reused dispatch for the old attempt', 'src/server/session-delegation-state.ts', 'event.data.attemptId ?? event.data.dispatchId ?? id', 'event.data.dispatchId ?? id', 'src/server/__tests__/delegation-stale-sweep.test.ts', 'stale sweep and live delegation query'],
  ['worker detail mixes archived attempts', 'src/tui/worker-detail.ts', " && (!liveView.attemptId || r.attemptId === liveView.attemptId)", '', 'src/tui/__tests__/worker-detail.test.ts', 'worker detail selects historical'],
  ['dependency-blocked terminal loses dispatch identity', 'src/agent/coordinator.ts', 'return stampWorkerResultIdentity(result, { dispatchId: order.parentTurnId, attemptId: this.dispatchAttempts.get(order.parentTurnId) })', 'return result as IdentifiedWorkerResult', 'batch-side-table-isolation.test.ts', 'dependency-blocked'],
  ['early refusal loses dispatch identity', 'src/agent/coordinator.ts', 'return stampWorkerResultIdentity(result, { dispatchId: order.parentTurnId, attemptId: this.dispatchAttempts.get(order.parentTurnId) })', 'return result as IdentifiedWorkerResult', 'batch-side-table-isolation.test.ts', 'cross-batch writers'],
  ['pending policy cancellation loses dispatch identity', 'src/agent/coordinator.ts', 'this.identifyDispatchResult(cancelled, buildPolicyCancelledResult(cancelled, policyLabel))', 'buildPolicyCancelledResult(cancelled, policyLabel)', 'batch-side-table-isolation.test.ts', 'policy cancel-rest'],
]
if (process.env.REVIT_PR_DEFECT !== undefined) {
  const [, file, good, bad, , , good2, bad2] = cases[Number(process.env.REVIT_PR_DEFECT)]
  registerHooks({ load(url, ctx, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== root + '/' + file) return next(url, ctx)
    const source = readFileSync(new URL(url), 'utf8')
    const mutated = source.replace(good, bad)
    if (source === mutated) throw new Error('mutation anchor missing')
    const final = good2 ? mutated.replace(good2, bad2) : mutated
    return { shortCircuit: true, format: 'module', source: transformSync(final, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  let checked = 0
  const from = Number(process.argv[2] ?? 0)
  if (!Number.isInteger(from) || from < 0 || from >= cases.length) throw new Error('Invalid mutation start index')
  for (const [i, [name, file, good, bad, test, pattern, good2, bad2]] of cases.entries()) {
    if (i < from) continue
    const source = readFileSync(root + '/' + file, 'utf8')
    const mutated = source.replace(good, bad)
    if (source === mutated || (good2 && mutated === mutated.replace(good2, bad2))) throw new Error(name + ': mutation anchor missing')
    const result = spawnSync('rtk', ['node', '--import', 'tsx', '--import', import.meta.filename, '--test', '--test-timeout=15000', '--test-name-pattern=' + pattern, test.startsWith('src/') ? test : 'src/agent/__tests__/' + test], {
      cwd: root, env: { ...process.env, REVIT_PR_DEFECT: String(i) }, encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    const out = result.stdout + result.stderr
    assert.ok(result.status !== 0 && out.includes('AssertionError') && !out.includes('mutation anchor missing'), name + ' not assertion RED:\n' + out.slice(-3000))
    checked++
    console.log('ASSERTION RED: ' + name)
  }
  console.log(`${checked} restored defects caught (${cases.length} available); checkout untouched`)
}
