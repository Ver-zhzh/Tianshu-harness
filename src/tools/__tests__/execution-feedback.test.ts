import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Direct invocation must be isolated before any runtime import, too.
const root = mkdtempSync(join(tmpdir(), 'rivet-execution-feedback-'))
const previous = { home: process.env.RIVET_HOME, sessions: process.env.RIVET_SESSION_DIR, rtk: process.env.RIVET_RTK }
process.env.RIVET_HOME = join(root, 'home')
process.env.RIVET_SESSION_DIR = join(root, 'sessions')
process.env.RIVET_RTK = '0'
mkdirSync(process.env.RIVET_HOME, { recursive: true })
writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
const { BASH_TOOL } = await import('../bash.js')
const { JOB_TOOL } = await import('../job-tool.js')
const { executeToolUse } = await import('../../agent/tool-pipeline.js')
const { EvidenceTracker } = await import('../../agent/evidence.js')
const { createTurnBudget } = await import('../../agent/turn-budget.js')
const { observeRun } = await import('../../agent/stall-observer.js')
const { TYPECHECK_TIMEOUT_HINT } = await import('../../lsp/typecheck-cache.js')

after(() => {
  for (const [key, value] of Object.entries({ RIVET_HOME: previous.home, RIVET_SESSION_DIR: previous.sessions, RIVET_RTK: previous.rtk })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test('real missing command preserves the evidence without exonerating code or prescribing installation', async () => {
  const missing = '__rivet_feedback_missing_command_20261019__'
  const result = await BASH_TOOL.execute({ input: { command: missing, run_in_background: false }, cwd: root, toolUseId: 'feedback-missing' })
  assert.equal(result.isError, true)
  assert.ok([1, 127, 9009].includes(result.exitCode!))
  assert.match(result.content, /尚未确认根因/)
  assert.match(result.content, /PATH/)
  assert.match(result.content, new RegExp(missing))
  assert.doesNotMatch(result.content, /非代码缺陷|不是代码缺陷/)
  assert.ok(result.rawPath)
  const raw = readFileSync(result.rawPath!, 'utf8')
  assert.match(raw, new RegExp(missing))
  assert.equal(result.displayOutput, raw)
})

test('outer success does not acquire a synthetic failure classification from its output', async () => {
  writeFileSync(join(root, 'mixed.cjs'), 'console.error("nested probe: command not found"); process.exit(0)')
  const result = await BASH_TOOL.execute({ input: { command: 'node mixed.cjs', run_in_background: false }, cwd: root, toolUseId: 'feedback-mixed' })
  assert.equal(result.exitCode, 0)
  assert.equal(result.isError, false)
  assert.equal(result.errorKind, undefined)
  assert.match(result.content, /nested probe: command not found/)
})

test('exit 126 does not fabricate a permission-denied root cause', async () => {
  writeFileSync(join(root, 'exit126.cjs'), 'console.error("fixture: incompatible executable format"); process.exit(126)')
  const result = await BASH_TOOL.execute({ input: { command: 'node exit126.cjs', run_in_background: false }, cwd: root, toolUseId: 'feedback-executable' })
  assert.equal(result.exitCode, 126)
  assert.equal(result.isError, true)
  assert.match(result.content, /incompatible executable format/)
  assert.doesNotMatch(result.content, /permission denied|brew install|winget install/)
})

test('typecheck timeout checks the original execution before recommending another run', () => {
  assert.match(TYPECHECK_TIMEOUT_HINT, /确认原执行已结束/)
  assert.match(TYPECHECK_TIMEOUT_HINT, /完整/)
  assert.doesNotMatch(TYPECHECK_TIMEOUT_HINT, /不会产出任何结果/)
})

test('background start recommends waiting for exit, without a generic success-looking output pattern', async () => {
  const jobs = { spawn: () => ({ id: 'feedback-job', status: 'running' }), recordVerificationMeta() {} }
  const result = await BASH_TOOL.execute({ input: { command: 'echo pending', run_in_background: true }, cwd: root, toolUseId: 'feedback-bg', jobs: jobs as never })
  assert.equal(result.isError, false)
  assert.match(result.content, /job\(action="await", id="feedback-job"\)/)
  assert.doesNotMatch(result.content, /pattern="Ready\|listening\|compiled"/)
  assert.match(result.content, /不代表.*测试通过/)
})

test('job output pattern and wait timeout cannot turn a running task into completed work', async () => {
  for (const result of [
    { matched: true, timedOut: false, status: 'running' },
    { matched: false, timedOut: true, status: 'running' },
    { matched: true, timedOut: false, status: 'exited', exitCode: 1 },
  ]) {
    const jobs = { await: async () => ({ ...result, job: { id: 'feedback-job', command: 'test', startedAt: Date.now(), status: result.status, exitCode: result.exitCode }, tail: 'compiled' }) }
    const response = await JOB_TOOL.execute({ input: { action: 'await', id: 'feedback-job', pattern: 'compiled' }, cwd: root, toolUseId: 'feedback-await', jobs: jobs as never })
    if (result.status === 'running') {
      assert.match(response.content, /仍在运行/)
      assert.match(response.content, /不代表.*测试通过/)
    } else {
      assert.match(response.content, /任务已退出 \(exit 1\)/)
      assert.doesNotMatch(response.content, /✓/)
      assert.match(response.uiContent!, /exited \(1\)/)
    }
  }
})

test('actual pipeline timeout reports unknown completion and no invented plan recovery', async () => {
  let executionSignal: AbortSignal | undefined
  const toolRegistry = {
    execute: async (_name: string, params: { abortSignal: AbortSignal }) => {
      executionSignal = params.abortSignal
      return new Promise<never>(() => {})
    },
    get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false, timeoutMs: () => 20 }),
    resolveName: (name: string) => name,
    needsApproval: () => false,
  }
  const deps = {
    config: { toolRegistry, hooks: null, lspEnabled: false, promptEngine: { markGitDirty() {}, getModel: () => 'test-model' } },
    cwd: root,
    harness: { executeTool: async ({ execute }: { execute: () => Promise<unknown> }) => execute() },
    prewarm: { get: () => null, invalidate() {} },
    evidence: new EvidenceTracker(),
    traceStore: { events: [], toolFingerprints: [] },
    repairHintTracker: { recordSuccess() {}, recordFailure() {} },
    repairPipeline: { run: (input: unknown) => ({ output: input, telemetry: [] }) },
    importGraph: null,
    lastConflictCheckCount: 0,
    trajectory: { getEntries: () => [] },
    getDoomLoopLevel: () => 'none',
    latestRisk: { level: 'none', reasons: [], suggestedAction: '' },
    sessionTurnCount: 1,
    sessionId: 'feedback-timeout',
    recordToolHistory() {},
    turnBudget: createTurnBudget(0),
  } as unknown as import('../../agent/tool-pipeline.js').ToolPipelineDeps
  const response = await observeRun('feedback-timeout', () => executeToolUse(
    { id: 'feedback-timeout', name: 'read_file', input: { file_path: join(root, 'probe.txt') } }, deps,
    { onToolResult() {}, onApprovalRequired: async () => true } as never, 1, false,
  ))
  assert.equal(executionSignal?.aborted, true)
  assert.ok(response.toolResult.type === 'tool_result')
  assert.equal(response.toolResult.is_error, true)
  assert.match(String(response.toolResult.content), /timed out/)
  assert.match(String(response.toolResult.content), /尚未确认/)
  assert.doesNotMatch(String(response.toolResult.content), /worker 写入已落盘|executePlanWaves|fromWave/)
})
