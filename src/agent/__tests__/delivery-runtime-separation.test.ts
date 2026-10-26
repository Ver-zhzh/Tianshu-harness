import { after, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { WRITE_FILE_TOOL } from '../../tools/write-file.js'
import { RUN_TESTS_TOOL } from '../../tools/run-tests.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { StreamClient } from '../../api/stream-client.js'

const sessionDir = mkdtempSync(join(tmpdir(), 'delivery-runtime-sessions-'))
const prior = process.env.RIVET_SESSION_DIR
process.env.RIVET_SESSION_DIR = sessionDir
after(() => { if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(sessionDir, { recursive: true, force: true }) })

for (const evidence of ['unverified', 'failed', 'stale'] as const) it(`real AgentLoop writes, commits and finishes without quality continuation (${evidence})`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-runtime-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n'); git('add', '--', 'a.ts'); git('commit', '-qm', 'base')
    if (evidence === 'failed') {
      mkdirSync(join(cwd, '.rivet'), { recursive: true })
      writeFileSync(join(cwd, '.gitignore'), '.rivet/\n')
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      writeFileSync(join(cwd, 'a.test.mjs'), "import {test} from 'node:test'; import {appendFileSync} from 'node:fs'; test('known failure',()=>{appendFileSync('.rivet/test-runs.txt','run\\n');throw Error('known failure')});\n")
      git('add', '--', '.gitignore', 'package.json', 'a.test.mjs'); git('commit', '-qm', 'test fixture')
    }
    const ledger = createTaskLedger({ taskId: 'runtime-save' })
    const ownership = createOwnershipLedger({ taskLedger: ledger, baseline: createWorktreeBaseline({ branch: 'main', head: git('rev-parse', 'HEAD'), complete: true, preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }) })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }), repoRoot: cwd })
    const registry = new ToolRegistry(); registry.register(WRITE_FILE_TOOL); registry.register(READ_FILE_TOOL)
    registry.register(createDeliverTaskTool(() => ({ taskLedger: ledger, ownership, gate, sessionId: `runtime-${evidence}` })))
    let qualityCalls = 0, requests = 0, impactQueries = 0
    for (const name of ['run_tests', 'review_changes']) registry.register(evidence === 'failed' && name === 'run_tests'
      ? { ...RUN_TESTS_TOOL, execute: async params => {
        qualityCalls++
        const nested = process.env.NODE_TEST_CONTEXT
        delete process.env.NODE_TEST_CONTEXT
        try { return await RUN_TESTS_TOOL.execute(params) }
        finally { if (nested !== undefined) process.env.NODE_TEST_CONTEXT = nested }
      } }
      : { definition: { name, description: name, input_schema: { type: 'object', properties: {} } }, execute: async () => { qualityCalls++; throw new Error('quality work was not requested') }, requiresApproval: () => false, isConcurrencySafe: () => false, isEnabled: () => true })
    const finalRequest = evidence === 'failed' ? 5 : 4
    const client: StreamClient = { stream: async (_request, cb) => {
      requests++
      const block = requests === 1 ? { type: 'tool_use' as const, id: 'read', name: 'read_file', input: { file_path: join(cwd, 'a.ts') } }
        : requests === 2 ? { type: 'tool_use' as const, id: 'write', name: 'write_file', input: { file_path: join(cwd, 'a.ts'), content: 'export const a = 2\n' } }
        : evidence === 'failed' && requests === 3 ? { type: 'tool_use' as const, id: 'test', name: 'run_tests', input: { files: ['a.test.mjs'], timeout: 5000 } }
        : requests === finalRequest - 1 ? { type: 'tool_use' as const, id: 'commit', name: 'deliver_task', input: { commit: true, message: 'save source', files: ['a.ts'] } }
        : { type: 'text' as const, text: '已提交。未执行额外测试或审查。' }
      if (requests > finalRequest) throw new Error('unexpected automatic continuation after safe commit')
      if (block.type === 'text') cb.onTextDelta(block.text)
      cb.onContentBlock(block); cb.onStopReason(block.type === 'text' ? 'end_turn' : 'tool_use', { input_tokens: 1, output_tokens: 1 })
    } }
    const agent = new AgentLoop({ client, promptEngine: new PromptEngine({ model: 'fixture', maxTokens: 1024, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd } }),
      toolRegistry: registry, taskLedger: ledger, ownershipLedger: ownership, maxTurns: 6, contextWindow: 1000000, approvalMode: 'dangerously-skip-permissions', compact: { enabled: false, model: 'fixture' },
    }, new SessionContext(), cwd)
    const unexpectedImpact = () => { impactQueries++; throw new Error('automatic impact scan must not run') }
    agent.config.meridianIndexer = { flushTurn() {}, getDb: () => ({ hasFiles: () => true, getTestsFor: unexpectedImpact, getReverseDependents: unexpectedImpact, getCoEditNeighbors: unexpectedImpact, saveBanditState() {} }) } as never
    const results: string[] = [], errors: Error[] = [], continuations: string[] = []
    const finalChecks: string[] = []
    const evaluateFinal = agent.obligations.evaluateFinal.bind(agent.obligations)
    agent.obligations.evaluateFinal = () => { const result = evaluateFinal(); finalChecks.push(result.verdict); return result }
    let finalVerification: string | undefined
    await agent.run('修改 a.ts 并保存本次提交。审查和测试由用户稍后决定。', {
      onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onAbort() {}, onApprovalRequired: async () => true,
      onError: error => { errors.push(error) }, onTurnComplete: (_u, _t, final, summary, reason) => { if (reason) continuations.push(reason); if (final) finalVerification = summary?.verificationStatus },
      onToolResult: (_id, name, result) => {
        results.push(result)
        if (name === 'write_file') {
          // Existing and newly-created high quality obligations must remain truthful records, not extra turns.
          for (const family of ['bugfix', 'delivery', 'acceptance'] as const) agent.obligations.upsert({ family, claim: `${family} 尚未验证`, risk: 'high' })
          if (evidence !== 'unverified') agent.evidence.trackVerification({ command: 'prior targeted test', kind: 'test', status: evidence === 'failed' ? 'failed' : 'passed', scope: 'targeted', passed: evidence === 'failed' ? 0 : 1, failed: evidence === 'failed' ? 1 : 0, stale: evidence === 'stale' })
        }
      },
    })
    assert.equal(requests, finalRequest, JSON.stringify({ results, errors: errors.map(e => String(e)) }))
    assert.deepEqual(errors, [])
    assert.deepEqual(finalChecks, ['allow'], 'the actual finish gate must allow disclosure without requesting verification')
    assert.equal(qualityCalls, evidence === 'failed' ? 1 : 0)
    if (evidence === 'failed') {
      assert.equal(readFileSync(join(cwd, '.rivet/test-runs.txt'), 'utf8'), 'run\n', 'the real failing test must execute exactly once')
      assert.ok(ledger.getVerifications().some(v => v.status === 'failed'), 'the durable ledger must preserve the actual failure')
      assert.equal(finalVerification, 'failed', 'safe commit must not convert a failed test into a green completion badge')
    }
    assert.equal(impactQueries, 0)
    assert.equal(git('log', '-1', '--format=%s'), 'save source')
    assert.ok(results.some(r => r.includes('VERIFIED: 本次提交')))
    assert.ok(!continuations.includes('obligation-verification'))
    assert.ok(agent.obligations.getStore().obligations.some(o => o.state === 'open'), 'quality debt is disclosed, not falsely marked satisfied')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
