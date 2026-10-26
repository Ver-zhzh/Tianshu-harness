import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL, parseOutput } from '../run-tests.js'
import { invalidateVerifyConfig } from '../../config/verify-config.js'
import { makeTestDir } from './_test-tmp.js'

// output-store rawDir() 受 TMPDIR 控制（见 run-tests.test.ts 同款处理）。
const FAKE_TMP = mkdtempSync(join(process.cwd(), '.test-tmp', 'fake-tmp-declared-'))
process.env.TMPDIR = FAKE_TMP
process.env.TMP = FAKE_TMP
process.env.TEMP = FAKE_TMP

// 信任门：项目级 verify 声明对未授信 cwd 被 project-trust 剥离（fail-closed）。
// 本套件专门测声明命令的加载与执行，须显式授信（同 verify-config.test.ts 约定）。
const PREV_TRUST = process.env.RIVET_TRUST_PROJECT
process.env.RIVET_TRUST_PROJECT = '1'

after(() => {
  rmSync(FAKE_TMP, { recursive: true, force: true })
  invalidateVerifyConfig()
  if (PREV_TRUST === undefined) delete process.env.RIVET_TRUST_PROJECT
  else process.env.RIVET_TRUST_PROJECT = PREV_TRUST
})

function makeParams(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return { input, toolUseId: `declared-${Math.random().toString(36).slice(2)}`, cwd }
}

/** Project with only a declared verify.test — no package.json, no python markers. */
function setupDeclaredProject(testCommand: string): string {
  const dir = makeTestDir('run-tests-declared-')
  writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ verify: { test: testCommand } }))
  invalidateVerifyConfig()
  return dir
}

describe('run_tests declared verify.test (A2)', () => {
  it('runs the declared command via shell and passes on exit 0', async () => {
    const dir = setupDeclaredProject('node -e "console.log(\'declared ok\')"')
    const result = await RUN_TESTS_TOOL.execute(makeParams({ full: true }, dir) as never)
    assert.equal(result.isError, false, `expected pass, got: ${String(result.content).slice(0, 300)}`)
    assert.equal(result.verification?.status, 'passed')
    assert.match(result.verification?.command ?? '', /node -e/)
  })

  it('fails on non-zero exit from the declared command', async () => {
    const dir = setupDeclaredProject('node -e "process.exit(3)"')
    const result = await RUN_TESTS_TOOL.execute(makeParams({ full: true }, dir) as never)
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'failed')
  })

  it('declared command beats package.json auto-detection', async () => {
    const dir = setupDeclaredProject('node -e "console.log(\'from declaration\')"')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }))
    const result = await RUN_TESTS_TOOL.execute(makeParams({ full: true }, dir) as never)
    assert.equal(result.isError, false)
    assert.match(result.verification?.command ?? '', /from declaration/)
  })

  it('失败只运行一次，不调用旧归因重试回调', async () => {
    const liveDir = setupDeclaredProject('node -e "process.exit(1)"')
    let retries = 0
    const result = await RUN_TESTS_TOOL.execute({ ...makeParams({ full: true }, liveDir),
      prepareRetrySnapshot: async () => { retries++; throw new Error('must not retry') },
    } as never)
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'failed')
    assert.equal(retries, 0)
    assert.equal(result.extraVerifications, undefined)
  })

})

describe('parseOutput declared formats', () => {
  it('parses cargo test summaries (summing multiple targets)', () => {
    const out = [
      'test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured',
      'test result: FAILED. 3 passed; 2 failed; 0 ignored',
    ].join('\n')
    const r = parseOutput(out, 'declared')
    assert.equal(r.passed, 15)
    assert.equal(r.failed, 2)
    assert.equal(r.skipped, 1)
  })

  it('parses go test failures and package ok lines', () => {
    const out = ['--- FAIL: TestFoo', '--- FAIL: TestBar', 'ok  \texample.com/pkg\t0.5s'].join('\n')
    const r = parseOutput(out, 'declared')
    assert.equal(r.failed, 2)
    assert.equal(r.passed, 1)
  })

  it('falls back to zero counts for unrecognized output', () => {
    const r = parseOutput('some random build log', 'declared')
    assert.equal(r.passed, 0)
    assert.equal(r.failed, 0)
  })
})

describe('scope is selected independently of commands and environments', () => {
  it('empty, blank, projects, shard, candidate and declared defaults never imply full', async () => {
    const dir = setupDeclaredProject('node -e "process.exit(99)"')
    for (const input of [{}, {filter:''}, {filter:'   '}, {projects:[]}, {shard:false}, {deliveryFiles:['a.ts']}]) {
      const result = await RUN_TESTS_TOOL.execute({ ...makeParams(input, dir),
        verificationSnapshot: { candidateOnly: true, path: dir, snapshotRef: 'fixture' } } as never)
      assert.equal(result.isError, true, JSON.stringify(input))
      assert.equal(result.verification, undefined, 'a preview must not create execution evidence')
      assert.match(result.content, /未指定测试范围/)
    }
    assert.equal(RUN_TESTS_TOOL.requiresApproval(makeParams({full:true},dir) as never),true)
    assert.equal(RUN_TESTS_TOOL.requiresApproval(makeParams({files:['a.test.ts']},dir) as never),false)
  })
})
