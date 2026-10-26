import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolExecutionController, type ToolExecutionDeps } from '../tool-execution.js'
import { createTurnBudget } from '../turn-budget.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { runPreparedToolBatch } from '../prepared-tool-batch.js'
import { BASH_TOOL } from '../../tools/bash.js'
import { writeFileSync } from 'node:fs'
import { createFileRepairStore } from '../file-repair-store.js'
import { createTraceStore } from '../trace-store.js'
import { isLiteralReadShell } from '../../tools/shell-read-safety.js'
import { withRuntimeRun } from '../../utils/runtime-provenance.js'
import { beginCallAudit } from '../../api/call-audit.js'
import { getSessionDir } from '../session-persist.js'

function fixture(concurrency = 4) {
  const cwd = mkdtempSync(join(tmpdir(), 'prepared-dispatch-'))
  const timeline: string[] = [], results: any[] = [], ui: string[] = []
  let active = 0, maximum = 0
  const deps = {
    cwd, config: { approvalMode: 'manual', readConcurrency: concurrency, sessionId: 'prepared', contextWindow: 200_000,
      promptEngine: { getModel: () => 'test', markGitDirty() {} },
      toolRegistry: {
        resolveName: (name: string) => name,
        get: (name: string) => ({ definition: { input_schema: {} }, isConcurrencySafe: () => name === 'grep', timeoutMs: () => 5000 }),
        needsApproval: (_: string, params: any) => !!params.input.approve,
        execute: async (_: string, params: any) => {
          assert.ok(Object.isFrozen(params.input)); params.abortSignal.throwIfAborted()
          const id = params.toolUseId
          active++; maximum = Math.max(maximum, active); timeline.push('start:' + id)
          try { await new Promise<void>((resolve, reject) => {
            const done = () => { params.abortSignal.removeEventListener('abort', abort); resolve() }
            const timer = setTimeout(done, params.input.delay ?? 5)
            const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
            params.abortSignal.addEventListener('abort', abort, { once: true })
          }) } finally { active--; timeline.push('end:' + id) }
          return { content: String(params.input.command ?? id) }
        },
      },
    },
    harness: { executeTool: async ({ execute }: any) => { const r = await execute(); return { content: r.content, isError: !!r.isError, retried: false } } },
    prewarm: { get: () => null, invalidate() {} },
    evidence: { getState: () => ({ filesModified: new Set() }), getGateState: () => ({ editsSinceLastTest: 0 }), trackFileRead() {}, trackFileModified() {}, trackVerification() {} },
    repairHintTracker: { recordSuccess() {}, recordFailure() {} }, repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
    runtimeHooks: { runPostTool: async () => {} }, contextInjection: { setCerebellarHint() {}, clearCerebellarHint() {} },
    trajectory: { getEntries: () => [] }, getPredictionAccumulator: () => createPredictionAccumulator(), setPredictionAccumulator() {},
    getVigorState: () => ({}), setVigorState() {}, getDoomLoopLevel: () => 'none', getSessionTurnCount: () => 1,
    getSessionId: () => 'prepared', addToolResults: (items: any[]) => results.push(...items), recordToolHistory() {}, buildRuntimeSnapshot: () => ({}),
    requestThetaCheck() {}, getAutoReasoning: () => false, getReasoningEffort: () => undefined, setClientReasoningEffort() {}, getSensorium: () => null, getReliabilityDecision: () => null,
    getTurnBudget: () => createTurnBudget(0),
  } as unknown as ToolExecutionDeps
  const controller = new ToolExecutionController(deps)
  const ac = new AbortController()
  const run = (toolUses: any[], onApprovalRequired: any = async () => true) => controller.executeBatch({ toolUses, callbacks: { onApprovalRequired, onToolResult: (id: string, _: string, _content: string, error?: boolean) => { if (error !== undefined) ui.push(id) } } as any, turn: 1, abortSignal: ac.signal, checkpointCreatedThisTurn: false, traceStore: createTraceStore(200), importGraph: null, lastConflictCheckCount: 0, latestRisk: { level: 'none', reasons: [], suggestedAction: '' } })
  return { deps, timeline, results, ui, run, ac, maximum: () => maximum, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}

test('terminal tool trace carries its real primary request attempt and run identity', async () => {
  const f = fixture(1)
  try {
    const execute = f.deps.config.toolRegistry.execute.bind(f.deps.config.toolRegistry)
    f.deps.config.toolRegistry.execute = async (name, params) => {
      beginCallAudit({ sessionId: 'prepared', requestId: 'later-primary', attemptId: 'later-attempt', purpose: 'main_execution' }).finish({ status: 'complete' })
      return execute(name, params)
    }
    await withRuntimeRun({ runId: 'observed-run', sessionId: 'prepared' }, async () => {
      beginCallAudit({ sessionId: 'prepared', requestId: 'primary-request', attemptId: 'primary-attempt', purpose: 'main_execution' }).finish({ status: 'complete' })
      beginCallAudit({ sessionId: 'prepared', requestId: 'probe-request', attemptId: 'probe-attempt', purpose: 'provider_probe' }).finish({ status: 'complete' })
      await f.run([{ id: 'observed', name: 'grep', input: {} }])
    })
    const trace = readFileSync(join(getSessionDir(f.deps.cwd), 'prepared', 'tool-result-trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const terminal = trace.find(event => event.id === 'observed' && event.source === 'pipeline')
    assert.equal(terminal.runId, 'observed-run')
    assert.equal(terminal.requestId, 'primary-request')
    assert.equal(terminal.attemptId, 'primary-attempt')
    assert.equal(terminal.runtime.buildId, 'unknown')
    assert.equal(terminal.dispatched, true)
  } finally { f.dispose() }
})

test('later approval and queued siblings do not consume execution timeout', async () => {
  const f = fixture(2)
  try {
    const get = f.deps.config.toolRegistry.get
    f.deps.config.toolRegistry.get = ((name: string) => ({ ...get(name), timeoutMs: () => 25 })) as typeof get
    const result = await f.run([
      { id: 'first', name: 'grep', input: {} },
      { id: 'approval', name: 'grep', input: { approve: true } },
    ], async () => { await new Promise(resolve => setTimeout(resolve, 80)); return true })
    assert.ok(f.results.every(r => !r.is_error), JSON.stringify(f.results))
    assert.deepEqual(new Set(f.timeline.filter(s => s.startsWith('start:'))), new Set(['start:first', 'start:approval']))
    assert.ok(result.traceStore.events.filter(e => e.terminal).every(e => e.dispatched))
  } finally { f.dispose() }
})

test('outer watchdog excludes approval and queue time but still bounds machine work', async t => {
  const originalTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalTimeout(callback, ms === 120_000 ? 30 : ms, ...args)) as typeof setTimeout)
  const f = fixture(1)
  try {
    await f.run([
      { id: 'slow', name: 'grep', input: { delay: 80 } },
      { id: 'queued', name: 'grep', input: { approve: true } },
    ], async () => { await new Promise(resolve => setTimeout(resolve, 80)); return true })
    assert.ok(f.results.every(r => !r.is_error), JSON.stringify(f.results))
    assert.ok(f.timeline.indexOf('end:slow') < f.timeline.indexOf('start:queued'))
  } finally { f.dispose() }
})

test('cancellation settles an unresponsive approval once and never dispatches a late approval', async () => {
  const f = fixture(2)
  let approve!: (value: boolean) => void, reached!: () => void
  const atApproval = new Promise<void>(resolve => { reached = resolve })
  try {
    const pending = f.run([
      { id: 'queued', name: 'grep', input: {} },
      { id: 'awaiting', name: 'grep', input: { approve: true } },
    ], () => { reached(); return new Promise<boolean>(resolve => { approve = resolve }) })
    await atApproval
    f.ac.abort()
    let timer: ReturnType<typeof setTimeout>
    try {
      const result = await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cancelled approval did not settle')), 500) })])
      assert.equal(result.traceStore.events.filter(e => e.terminal).length, 2)
      assert.ok(result.traceStore.events.filter(e => e.terminal).every(e => !e.dispatched && e.status === 'blocked'))
      assert.equal(f.ui.length, 2)
      assert.ok(f.results.every(r => r.is_error && /工具主体未执行/.test(r.content)), JSON.stringify(f.results))
    } finally { clearTimeout(timer!) }
    approve(true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.timeline.length, 0)
    assert.equal(f.ui.length, 2, 'late approval cannot produce a second terminal')
  } finally { approve?.(false); f.dispose() }
})

test('execution timeout aborts a dispatched operation and retains uncertainty', async () => {
  const f = fixture(1)
  try {
    const get = f.deps.config.toolRegistry.get
    f.deps.config.toolRegistry.get = ((name: string) => ({ ...get(name), timeoutMs: () => 25 })) as typeof get
    const result = await f.run([{ id: 'running', name: 'grep', input: { delay: 100 } }])
    assert.ok(f.results[0].is_error)
    assert.match(f.results[0].content, /timed out/)
    assert.match(f.results[0].content, /尚未确认/)
    assert.ok(!f.results[0].content.includes('工具主体未执行'))
    const terminal = result.traceStore.events.find(e => e.terminal)!
    assert.equal(terminal.dispatched, true)
    assert.equal(terminal.status, 'failed')
    assert.deepEqual(f.timeline, ['start:running', 'end:running'])
    assert.equal(f.ac.signal.aborted, false)
  } finally { f.dispose() }
})

for (const phase of ['preparation', 'postprocessing'] as const) test(`outer watchdog still ends hung ${phase} with one terminal`, async t => {
  const originalTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalTimeout(callback, ms === 120_000 ? 30 : ms, ...args)) as typeof setTimeout)
  const f = fixture(1)
  let release!: () => void
  const stalled = new Promise<void>(resolve => { release = resolve })
  try {
    let latePreHook = false
    if (phase === 'preparation') {
      f.deps.config.externalHookRuntime = { barrier: () => stalled } as any
      f.deps.config.hooks = { firePreToolUse: () => { latePreHook = true; return {} } } as any
    } else f.deps.harness.executeTool = async ({ execute }: any) => { const r = await execute(); await stalled; return r }
    const result = await f.run([{ id: phase, name: 'grep', input: {} }])
    assert.ok(f.results[0].is_error)
    assert.match(f.results[0].content, /timed out/)
    if (phase === 'preparation') assert.match(f.results[0].content, /工具主体未执行/)
    assert.equal(result.traceStore.events.filter(e => e.terminal).length, 1)
    assert.equal(result.traceStore.events.find(e => e.terminal)?.dispatched, phase !== 'preparation')
    assert.equal(f.ui.length, 1)
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(latePreHook, false, 'a late preparation barrier cannot resume a timed-out invocation')
    assert.equal(f.ui.length, 1, 'late completion cannot produce another terminal')
  } finally { f.dispose() }
})

for (const cap of [1, 2, 4]) test(`real dispatcher caps reads at ${cap}, retains source order and all sibling events`, async () => {
  const f = fixture(cap)
  try {
    const calls = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, name: i % 2 ? 'bash' : 'grep', input: { command: `cat f${i}`, delay: i === 0 ? 25 : 5 } }))
    const result = await f.run(calls)
    assert.equal(f.maximum(), cap)
    assert.deepEqual(f.results.map(r => r.tool_use_id), calls.map(c => c.id))
    assert.equal(result.traceStore.events.filter(e => e.terminal === true).length, 7)
    assert.equal(result.traceStore.toolFingerprints.length, 7)
    assert.equal(result.traceStore.events.filter(e => e.kind === 'tool').length, 7, 'terminal audit must reuse each invocation instead of double-counting it')
    assert.equal(new Set(f.ui).size, 7); assert.equal(f.ui.length, 7)
    if (cap > 1) assert.notEqual(f.ui[0], 'r0', 'UI follows completion order')
  } finally { f.dispose() }
})

test('final approval input and hook edits create write barriers inside an initially read-only segment', async () => {
  const f = fixture()
  try {
    f.deps.config.hooks = { firePreToolUse: ({ input }: any) => input.hook ? { input: { ...input, command: 'printf hook > h.txt' } } : {}, firePostToolUse: () => ({}) } as any
    const calls = [
      { id: 'read-a', name: 'bash', input: { command: 'cat a', delay: 20 } },
      { id: 'write', name: 'bash', input: { command: 'cat b', approve: true } },
      { id: 'read-b', name: 'grep', input: {} },
      { id: 'hook-write', name: 'bash', input: { command: 'cat h', hook: true } },
      { id: 'read-c', name: 'bash', input: { command: 'cat c' } },
    ]
    let approvals = 0
    await f.run(calls, async (_id: string, _name: string, input: any) => { approvals++; return { approved: true, editedInput: input.approve ? { ...input, command: 'printf approved > b.txt' } : input } })
    assert.ok(approvals >= 1)
    for (const [before, after] of [['read-a', 'write'], ['write', 'read-b'], ['read-b', 'hook-write'], ['hook-write', 'read-c']]) assert.ok(f.timeline.indexOf('end:' + before) < f.timeline.indexOf('start:' + after), JSON.stringify(f.timeline))
    assert.ok(f.results.some(r => r.content.includes('printf approved')))
    assert.ok(f.results.some(r => r.content.includes('printf hook')))
  } finally { f.dispose() }
})

test('preflight rejection and cancellation each retain one terminal without starting queued calls', async () => {
  const f = fixture(2)
  try {
    f.deps.config.hooks = { firePreToolUse: ({ input }: any) => input.block ? { block: true, reason: 'fixture block' } : {}, firePostToolUse: () => ({}) } as any
    const pending = f.run(Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: 'grep', input: { delay: 50, block: i === 0 } })))
    setTimeout(() => f.ac.abort(), 15)
    const result = await pending
    assert.ok(f.maximum() <= 2)
    assert.equal(result.traceStore.events.filter(e => e.terminal === true).length, 6)
    assert.equal(f.ui.length, 6); assert.equal(new Set(f.ui).size, 6)
    assert.ok(f.timeline.filter(e => e.startsWith('start:')).length < 6)
    assert.ok(!f.timeline.includes('start:c0'))
    assert.ok(f.results.every(r => r.is_error))
  } finally { f.dispose() }
})

test('literal shell eligibility refuses executable extensions, expansion, output, git, tests and unknown flags', () => {
  for (const command of ['cat a | head -n 20', "rg --no-config -n 'it(' a.ts", "sed -n '10,20p' a.ts", 'rtk proxy wc -l a']) assert.equal(isLiteralReadShell(command), true, command)
  for (const command of ['awk 1 a', "python -c 'print(1)'", 'sort --compress-program=evil a', 'sort -o out a', 'rg --pre evil a', "sed -n '1e evil' a", 'cat $(touch a)', 'cat a > out', 'cat a &', 'cat *.ts', 'tail -f a', 'git status', 'npm test', 'cat --unknown a', 'cat a || cat b']) assert.equal(isLiteralReadShell(command), false, command)
})

test('an exceptional consumer cannot leave prepared siblings waiting or start their commands', async () => {
  let starts = 0
  await assert.rejects(runPreparedToolBatch([0, 1, 2].map(index => gate => gate('grep', {}, async () => { starts++; if (index === 0) throw new Error('consumer failure'); return { content: 'unexpected' } })), () => true, 1), /consumer failure/)
  assert.equal(starts, 1)
})

test('the dispatcher executes literal read pipelines through the real bash process tool', async () => {
  const f = fixture(2)
  try {
    writeFileSync(join(f.deps.cwd, 'a.txt'), 'native-read-a\n')
    writeFileSync(join(f.deps.cwd, 'b.txt'), 'native-read-b\n')
    f.deps.config.toolRegistry.execute = async (_name, params) => {
      const result = await BASH_TOOL.execute(params)
      assert.equal(result.exitCode, 0, result.content)
      return result
    }
    const result = await f.run(['a', 'b'].map(id => ({ id, name: 'bash', input: { command: `cat ${id}.txt | head -n 1` } })))
    assert.equal(f.results.length, 2)
    assert.match(f.results[0].content, /native-read-a/); assert.match(f.results[1].content, /native-read-b/)
    assert.ok(result.traceStore.events.filter(e => e.terminal === true).every(e => e.dispatched === true && e.status === 'passed'))
  } finally { f.dispose() }
})

test('a recovery event activated after preparation still blocks the queued opaque writer at dispatch', async () => {
  const f = fixture(2)
  try {
    const execute = f.deps.config.toolRegistry.execute.bind(f.deps.config.toolRegistry)
    f.deps.config.toolRegistry.execute = async (name, params) => {
      if (params.toolUseId === 'trigger') {
        const store = createFileRepairStore(f.deps.cwd, 'prepared')
        for (const toolCallId of ['damage', 'repair-failed']) store.record([{ sessionId: 'prepared', toolCallId, file: 'a.json', before: { version: 'v', parse: 'valid' }, after: { version: 'bad', parse: 'invalid' }, attemptedParse: 'invalid', attempted: true, restoration: 'conflict' }])
      }
      return execute(name, params)
    }
    await f.run([{ id: 'trigger', name: 'grep', input: {} }, { id: 'writer', name: 'bash', input: { command: 'cat a.json', approve: true } }], async () => ({ approved: true, editedInput: { command: 'python -c "print(1)"' } }))
    assert.ok(f.timeline.includes('start:trigger'))
    assert.ok(!f.timeline.includes('start:writer'))
    assert.equal(f.results[1].is_error, true); assert.match(f.results[1].content, /受控恢复态/)
  } finally { f.dispose() }
})
