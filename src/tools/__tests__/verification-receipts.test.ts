import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import { BASH_TOOL } from '../bash.js'
import { JOB_TOOL } from '../job-tool.js'
import { SessionJobs } from '../job-store.js'
import { listVerificationRuns, saveVerificationRun } from '../../agent/verification-runs.js'

it('real failing test executes once; queries retain early output, ownership and code identity', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-tests-'))
  const prior = process.env.RIVET_SESSION_DIR, nested = process.env.NODE_TEST_CONTEXT
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); delete process.env.NODE_TEST_CONTEXT
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'one.test.mjs'), "import{test}from'node:test';import{appendFileSync}from'node:fs';test('one',()=>{appendFileSync('runs','1');console.log('EARLY_ERROR_MARKER');console.log('x'.repeat(160000));throw Error('real failure')});")
    execFileSync('git', ['init', '-q'], { cwd })
    const base = { cwd, sessionId: 'A', toolUseId: 'receipt', currentVerificationFingerprint: () => 'code-v1' }
    const result = await RUN_TESTS_TOOL.execute({ ...base, input: { files: ['one.test.mjs'] } })
    assert.equal(result.isError, true)
    assert.ok(result.verification?.executionId)
    const id = result.verification!.executionId!
    assert.match(readFileSync(result.rawPath!, 'utf8'), /EARLY_ERROR_MARKER/)
    const before = listVerificationRuns(cwd, 'A')
    assert.equal(before.length, 1)
    assert.equal(before[0]!.outcome, 'failed')
    assert.equal(before[0]!.executionState, 'exited')
    for (const action of ['list', 'get']) {
      const queried = await RUN_TESTS_TOOL.execute({ ...base, input: { action, execution_id: id, deliveryFiles: ['does-not-exist'] } })
      assert.notEqual(queried.isError, true)
    }
    const foreign = await RUN_TESTS_TOOL.execute({ ...base, sessionId: 'B', input: { action: 'get', execution_id: id } })
    assert.equal(foreign.isError, true)
    const changed = await RUN_TESTS_TOOL.execute({ ...base, currentVerificationFingerprint: () => { throw Error('query must not spawn fingerprint commands') }, input: { action: 'get', execution_id: id } })
    assert.ok(!changed.isError, changed.content)
    assert.match(changed.content, /当前版本有效性未知/)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '1')
    const lost = { ...before[0]!, executionId: 'orphan', executionState: 'running' as const }
    saveVerificationRun(cwd, lost)
    assert.equal(listVerificationRuns(cwd, 'A').find(r => r.executionId === 'orphan')!.outcome, 'unknown')
  } finally {
    if (nested !== undefined) process.env.NODE_TEST_CONTEXT = nested
    if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('background completion and repeated await/log queries reuse one persisted receipt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-background-'))
  const prior = process.env.RIVET_SESSION_DIR, nested = process.env.NODE_TEST_CONTEXT
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); delete process.env.NODE_TEST_CONTEXT
  const jobs = new SessionJobs(join(cwd, 'jobs'))
  try {
    writeFileSync(join(cwd, 'one.test.mjs'), "import{test}from'node:test';import{appendFileSync}from'node:fs';test('one',()=>{appendFileSync('runs','1');console.log('FIRST_MARKER')});")
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
    const base = { cwd, sessionId: 'A', toolUseId: 'background', jobs }
    const started = await BASH_TOOL.execute({ ...base, input: { command: 'node --test one.test.mjs', run_in_background: true } })
    assert.ok(started.backgroundJobId)
    for (let i = 0; i < 2; i++) {
      const done = await JOB_TOOL.execute({ ...base, input: { action: 'await', id: started.backgroundJobId, timeout: 5000 } })
      assert.match(done.content, /执行|coverage=complete/)
    }
    const logs = await JOB_TOOL.execute({ ...base, input: { action: 'logs', id: started.backgroundJobId, search: 'FIRST_MARKER' } })
    assert.match(logs.content, /FIRST_MARKER/)
    assert.equal(listVerificationRuns(cwd, 'A').length, 1)
    assert.equal(listVerificationRuns(cwd, 'A')[0]!.outcome, 'passed')
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '1')
  } finally {
    await jobs.killAllAsync()
    if (nested !== undefined) process.env.NODE_TEST_CONTEXT = nested
    if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior
    rmSync(cwd, { recursive: true, force: true })
  }
})
