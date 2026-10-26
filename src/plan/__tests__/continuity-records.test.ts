import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTodoTool } from '../../tools/todo.js'
import { TodoStore } from '../../tools/todo-store.js'
import { PLAN_TOOL } from '../../tools/plan.js'
import { readCompletionEvidence, recordCompletionEvidence, criterionHasEvidence } from '../completion-evidence.js'
import type { ToolCallParams } from '../../tools/types.js'
import { approvePlanAndKickoff } from '../../tui/plan-kickoff.js'
import { appendChecksum } from '../../agent/checksum.js'
import { RuntimeSessionManager } from '../../server/session-manager.js'
import { createRouter } from '../../server/index.js'
import { buildSessionRoutes } from '../../server/session-routes.js'
import { readPlanCompletionSummary } from '../completion-summary.js'

test('real todo and plan close retain unverified decisions, deferred work, revisions and facts without verification', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'continuity-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  try {
    mkdirSync(join(cwd, '.rivet/plans'), { recursive: true })
    const plan = '.rivet/plans/demo.md'
    writeFileSync(join(cwd, plan), '# Demo\n\n### Task 1 — Wire\n\n- [ ] [implementation] Wire actual consumer\n- [ ] [verification] Test later\n')
    writeFileSync(join(cwd, 'consumer.ts'), 'export const wired = true\n')
    const params: ToolCallParams = { cwd, sessionId: 'owner', toolUseId: 'record', input: {} }
    assert.equal(await approvePlanAndKickoff({ cwd, sessionId: 'owner', agent: { setActivePlan() {} }, notify() {} }, 'demo'), true)
    assert.equal(readCompletionEvidence(params).decisions![0]!.provenance, 'approval')
    writeFileSync(join(cwd, 'sessions/owner.jsonl'), [
      appendChecksum(JSON.stringify({ role: 'user', origin: 'human', content: '不要自动重跑测试' })),
      appendChecksum(JSON.stringify({ role: 'user', origin: 'hook', content: 'HOOK_IS_NOT_HUMAN' })),
    ].join('\n') + '\n')
    const tool = createTodoTool(new TodoStore())
    const written = await tool.execute({ ...params, input: { action: 'write', plan_ref: plan, todos: [{ id: 'step', content: 'Wire consumer', status: 'completed' }],
      decisions: [{ id: 'no-auto', kind: 'constraint', text: 'No automatic testing', sourceQuote: 'unavailable quote' }, { id: 'quoted', kind: 'constraint', text: 'Paraphrase must not become authority', sourceQuote: '不要自动重跑测试' }, { id: 'hook', kind: 'constraint', text: 'Not a user instruction', sourceQuote: 'HOOK_IS_NOT_HUMAN' }],
      open_items: [{ id: 'later', text: 'User acceptance', status: 'deferred', reason: 'User chooses timing', closedBy: 'User observes result', reopenIf: 'Regression', nextAction: 'Ask user at next review' }] } })
    assert.ok(!written.isError, written.content)
    assert.equal(readCompletionEvidence(params).decisions!.find(d => d.id === 'no-auto')!.provenance, 'unverified')
    assert.equal(readCompletionEvidence(params).decisions!.find(d => d.id === 'quoted')!.text, '不要自动重跑测试')
    assert.equal(readCompletionEvidence(params).decisions!.find(d => d.id === 'hook')!.provenance, 'unverified')
    recordCompletionEvidence(params, [{ id: 'impl', kind: 'implementation', stepId: 'step', criterion: 'wired', status: 'met', consumerBoundary: 'actual route', evidenceRefs: ['source:consumer.ts:1'] }], [], plan)
    const closed = await PLAN_TOOL.execute({ ...params, currentVerificationFingerprint: () => { throw Error('close cannot compute fingerprint') }, input: { action: 'close', file_path: plan, tasks: 'all', apply: true } })
    assert.ok(!closed.isError, closed.content)
    assert.match(closed.content, /执行：completed/)
    const state = readCompletionEvidence(params)
    assert.equal(state.closures!.length, 1)
    assert.equal(state.openItems![0]!.status, 'deferred')
    assert.match(readFileSync(join(cwd, plan), 'utf8'), /\[ \] \[verification\]/)
    assert.equal(criterionHasEvidence(params, state.acceptance[0]!, true), true)
    const manager = new RuntimeSessionManager({ defaultCwd: cwd, createAgent: () => { throw Error('plan query must not construct an agent') } })
    manager.createSession({ id: 'owner', cwd })
    const router = createRouter(buildSessionRoutes(manager, 'fixture'))
    const auth = { authorization: 'Bearer fixture' }
    const currentView = await router('GET', '/sessions/owner/plans/demo', {}, auth)
    assert.equal((currentView.body as any).plan.completion.revision, 'current')
    writeFileSync(join(cwd, plan), readFileSync(join(cwd, plan), 'utf8') + '\nNew requirement\n')
    assert.equal(criterionHasEvidence(params, state.acceptance[0]!, true), false)
    const changedView = await router('GET', '/sessions/owner/plans/demo', {}, auth)
    assert.equal((changedView.body as any).plan.completion.revision, 'changed')
    assert.match(readPlanCompletionSummary((changedView.body as any).plan.content, (changedView.body as any).plan.completion)!, /需复核/)
    await manager.shutdownAll()
    const invalid = await tool.execute({ ...params, input: { action: 'write', todos: [], open_items: [{ id: 'fake', text: 'Pretend closed', status: 'closed' }] } })
    assert.ok(invalid.isError)
  } finally { if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(cwd, { recursive: true, force: true }) }
})
