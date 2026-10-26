import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import { BASH_TOOL } from '../bash.js'
import { JOB_TOOL } from '../job-tool.js'
import { SessionJobs } from '../job-store.js'
import { listVerificationRuns, saveVerificationRun } from '../../agent/verification-runs.js'
import type { ToolCallParams } from '../types.js'

test('real executions reuse receipts across repeated calls and restart-unknown, with explicit rerun/scope/version/environment preserved', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'reuse-real-'))
  const previous = process.env.RIVET_SESSION_DIR, previousNode = process.env.NODE_TEST_CONTEXT, previousEnv = process.env.WORKFLOW_RECEIPT_TEST_ENV
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); delete process.env.NODE_TEST_CONTEXT
  const params: ToolCallParams = { cwd, sessionId: 'owner', toolUseId: 'reuse', input: { files: ['one.test.mjs'] }, currentVerificationFingerprint: () => 'same-version' }
  try {
    writeFileSync(join(cwd, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}')
    for (const name of ['one', 'two']) writeFileSync(join(cwd, `${name}.test.mjs`), "import{test}from'node:test';import{appendFileSync}from'node:fs';test('case',()=>appendFileSync('runs','1'))")
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['add', 'package.json', 'one.test.mjs', 'two.test.mjs'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-qm', 'base'], { cwd })
    const first = await RUN_TESTS_TOOL.execute(params)
    assert.ok(!first.isError, first.content)
    assert.ok(first.verification?.executionId)
    const again = await RUN_TESTS_TOOL.execute({ ...params, input: { files: ['./one.test.mjs'], timeout: 100_000 } })
    assert.equal(again.verificationRun?.executionId, first.verification!.executionId)
    assert.match(again.content, /本次未启动进程/)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '1')
    const rerun = await RUN_TESTS_TOOL.execute({ ...params, input: { ...params.input, rerun: true } })
    assert.notEqual(rerun.verification?.executionId, first.verification!.executionId)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '11')
    process.env.WORKFLOW_RECEIPT_TEST_ENV = 'different'
    assert.ok((await RUN_TESTS_TOOL.execute(params)).verification?.executionId, 'changed environment must run')
    appendFileSync(join(cwd, 'one.test.mjs'), '\n// changed code version\n')
    const changed = await RUN_TESTS_TOOL.execute(params)
    assert.ok(changed.verification?.executionId, 'changed bytes must run')
    await RUN_TESTS_TOOL.execute({ ...params, input: { files: ['two.test.mjs'] } })
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '11111')
    const run = listVerificationRuns(cwd, 'owner').find(r => r.executionId === changed.verification!.executionId)!
    saveVerificationRun(cwd, { ...run, executionId: 'restart-unknown', executionState: 'running', endedAt: undefined })
    const recovered = await RUN_TESTS_TOOL.execute(params)
    assert.match(recovered.content, /restart-unknown.*unknown/)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '11111', 'recovery must not rerun')
  } finally {
    for (const [key, value] of [['RIVET_SESSION_DIR', previous], ['NODE_TEST_CONTEXT', previousNode], ['WORKFLOW_RECEIPT_TEST_ENV', previousEnv]]) if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('background receipt reuse does not spawn another job; opaque shell exit zero never claims tests passed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'reuse-background-')), previous = process.env.RIVET_SESSION_DIR, previousNode = process.env.NODE_TEST_CONTEXT
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); delete process.env.NODE_TEST_CONTEXT
  const jobs = new SessionJobs(join(cwd, 'jobs'))
  const params: ToolCallParams = { cwd, jobs, sessionId: 'owner', toolUseId: 'background', input: { command: 'node --test one.test.mjs', run_in_background: true }, currentVerificationFingerprint: () => 'version' }
  try {
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
    writeFileSync(join(cwd, 'one.test.mjs'), "import{test}from'node:test';import{appendFileSync}from'node:fs';test('case',()=>appendFileSync('runs','1'))")
    await BASH_TOOL.execute(params)
    const job = jobs.list()[0]!
    const waited = await JOB_TOOL.execute({ ...params, input: { action: 'await', id: job.id, timeout: 5000 } })
    assert.ok(!waited.isError, waited.content)
    const again = await BASH_TOOL.execute(params)
    assert.match(again.content, /本次未启动进程/)
    assert.equal(jobs.list().length, 1)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '1')
    const foreground = await BASH_TOOL.execute({ ...params, input: { command: params.input.command, run_in_background: false, timeout: 30_000, description: 'inspect previous result' } })
    assert.match(foreground.content, /本次未启动进程/)
    assert.equal(readFileSync(join(cwd, 'runs'), 'utf8'), '1', 'execution mode and descriptive text cannot trigger another run')
    writeFileSync(join(cwd, 'fail.test.mjs'), "import{test}from'node:test';test('real failure',()=>{throw Error('FAIL')})")
    const opaque = await BASH_TOOL.execute({ ...params, input: { command: 'node --test fail.test.mjs | tail -1', run_in_background: false } })
    assert.equal(opaque.exitCode, 0)
    assert.equal(opaque.verification?.outcome, 'unknown')
    assert.notEqual(opaque.verification?.countsReliable, true)
    const receipt = listVerificationRuns(cwd, 'owner').find(r => r.executionId === opaque.verification?.executionId)
    assert.equal(receipt?.outcome, 'unknown')
    assert.equal(receipt?.executionState, 'exited')
    const nonzero = await BASH_TOOL.execute({ ...params, input: { command: 'node --test fail.test.mjs && echo done', run_in_background: false } })
    assert.notEqual(nonzero.exitCode, 0)
    assert.equal(nonzero.verification?.outcome, 'unknown', 'opaque shell failure is not an attributed test verdict')
  } finally {
    await jobs.killAllAsync()
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    if (previousNode === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previousNode
    rmSync(cwd, { recursive: true, force: true })
  }
})
