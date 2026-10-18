import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import { BASH_TOOL } from '../bash.js'
import { buildBashVerification } from '../../agent/bash-verification.js'
import { assessImpactedTestCoverage } from '../../agent/verification-attribution.js'
import { SessionJobs } from '../job-store.js'
import { prepareCompletionCapture, readCompletionCoverage } from '../test-completion.js'

import { dependencies, available, fixture } from './framework-fixture.js'

for (const runner of ['vitest', 'jest'] as const) {
  test(`${runner} zero tests, skip, hidden name filtering, changed code and timeout never cover a file`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    const definition = runner === 'vitest' ? "import {test} from 'vitest';" : ''
    const run = () => RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'proof-boundaries', input: { files: [f.file], timeout: 10_000 } })
    const uncovered = (result: Awaited<ReturnType<typeof run>>) => assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
    try {
      f.write(f.file, definition + "test.skip('omitted',()=>{});")
      uncovered(await run())
      f.write(f.file, definition)
      uncovered(await run())
      f.write(f.file, definition + "test('selected',()=>{});test('omitted',()=>{});")
      f.write(runner === 'vitest' ? 'vitest.config.mjs' : 'jest.config.cjs', runner === 'vitest' ? "export default {test:{testNamePattern:'selected'}};" : "module.exports={testMatch:['**/*.test.cjs'],testNamePattern:'selected'};")
      uncovered(await run())
      f.write(runner === 'vitest' ? 'vitest.config.mjs' : 'jest.config.cjs', runner === 'vitest' ? 'export default {};' : "module.exports={testMatch:['**/*.test.cjs']};")
      f.write(f.file, definition + (runner === 'vitest' ? "import {writeFileSync} from 'node:fs';" : "const {writeFileSync}=require('node:fs');") + "test('changes code',()=>writeFileSync('changed.ts','export const changed=1;'));")
      const changed = await run()
      assert.equal(changed.verification?.coverage?.workspaceChanged, true, changed.rawPath ? readFileSync(changed.rawPath, 'utf8') : JSON.stringify(changed.verification))
      uncovered(changed)
      f.write(f.file, definition + "test('slow',()=>new Promise(resolve=>setTimeout(resolve,20000)));")
      const timed = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'proof-timeout', input: { files: [f.file], timeout: 100 } })
      assert.equal(timed.verification?.blockedReason, 'timeout')
      uncovered(timed)
    } finally { f.dispose() }
  })
}

test('Vitest preserves configured and CLI reporters, setup and custom config', { skip: !available('vitest') }, async () => {
  const f = fixture('vitest')
  try {
    f.write('observer.mjs', "import {appendFileSync} from 'node:fs';export default class {done=false;finish(){if(!this.done){this.done=true;appendFileSync('reporter.log','done\\n')}}onFinished(){this.finish()}onTestRunEnd(){this.finish()}}")
    f.write('setup.mjs', "globalThis.fixtureSetup=42;")
    f.write('custom.config.mjs', "export default {test:{reporters:['default','./observer.mjs'],setupFiles:['./setup.mjs']}};")
    f.write(f.file, "import {test,expect} from 'vitest';test('setup',()=>expect(globalThis.fixtureSetup).toBe(42));")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    pkg.scripts.test += ' --config custom.config.mjs'
    f.write('package.json', pkg)
    for (const cli of [false, true]) {
      if (cli) { pkg.scripts.test += ' --reporter default --reporter ./observer.mjs'; f.write('package.json', pkg) }
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'reporter-compose', input: { files: [f.file] } })
      assert.equal(result.verification?.coverage?.complete, true, result.rawPath ? readFileSync(result.rawPath, 'utf8') : result.content)
    }
    assert.equal(readFileSync(join(f.cwd, 'reporter.log'), 'utf8'), 'done\ndone\n')
  } finally { f.dispose() }
})

test('missing, foreign and corrupt receipts cannot acquire complete proof', { skip: !available('vitest') }, () => {
  const f = fixture('vitest')
  try {
    const capture = prepareCompletionCapture('npm run test', f.cwd)!
    assert.ok(capture)
    assert.equal(capture.read(0)?.complete, false)
    capture.dispose()
    assert.equal(readCompletionCoverage({ version: 2, runner: 'vitest', runId: 'foreign', cwd: f.cwd, repositoryRoot: f.cwd, complete: true, filtered: false, files: [] }), undefined)
  } finally { f.dispose() }
})

test('Jest multi-project failure cannot be hidden by another project passing the same file', { skip: !available('jest') }, async () => {
  const f = fixture('jest')
  try {
    f.write('setup.cjs', 'globalThis.mustFail=true;')
    f.write('jest.config.cjs', "module.exports={projects:[{displayName:'green',testMatch:['**/*.test.cjs']},{displayName:'red',testMatch:['**/*.test.cjs'],setupFiles:['<rootDir>/setup.cjs']}]};")
    f.write(f.file, "test('per-project',()=>expect(globalThis.mustFail).not.toBe(true));")
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'multi-project', input: { files: [f.file] } })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(result.verification?.coverage?.files.length, 2)
    assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
  } finally { f.dispose() }
})

test('Vitest project identities and real isolated/integration receipts survive package cwd rebasing', { skip: !available('vitest') }, async () => {
  const live = fixture('vitest', true), snapshot = fixture('vitest', true)
  try {
    // An opaque root fan-out must fall back to package batches, including in the snapshot.
    for (const f of [live, snapshot]) writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.7.0', scripts: { test: 'pnpm -r test' } }))
    const result = await RUN_TESTS_TOOL.execute({ cwd: live.cwd, toolUseId: 'modern-snapshot', input: { files: [live.path] },
      verificationSnapshot: { path: snapshot.cwd, snapshotRef: 'modern-snapshot', repositoryRoot: live.cwd } })
    assert.equal(result.isError, false, result.content)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(result.extraVerifications?.[0]?.verificationPhase, 'integration')
    assert.equal(result.extraVerifications?.[0]?.coverage?.complete, true)
    assert.deepEqual(assessImpactedTestCoverage([live.path], [result.verification!, ...result.extraVerifications!], () => true, live.cwd).uncovered, [])
  } finally { live.dispose(); snapshot.dispose() }
})

test('Vitest multi-project same-file outcomes retain every project identity', { skip: !available('vitest') }, async () => {
  const f = fixture('vitest')
  try {
    const major = Number(JSON.parse(readFileSync(join(dependencies!, 'node_modules/vitest/package.json'), 'utf8')).version.split('.')[0])
    f.write('vitest.green.config.mjs', "export default {test:{name:'green',include:['src/*.spec.tsx']}};")
    f.write('vitest.red.config.mjs', "export default {test:{name:'red',include:['src/*.spec.tsx'],setupFiles:['./setup.mjs']}};")
    f.write('setup.mjs', 'globalThis.mustFail=true;')
    if (major === 2) f.write('vitest.workspace.mjs', "export default ['./vitest.green.config.mjs','./vitest.red.config.mjs'];")
    else f.write('vitest.config.mjs', "export default {test:{projects:['./vitest.green.config.mjs','./vitest.red.config.mjs']}};")
    f.write(f.file, "import {test,expect} from 'vitest';test('projects',()=>expect(globalThis.mustFail).not.toBe(true));")
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'vitest-projects', input: { files: [f.file] } })
    assert.equal(result.verification?.coverage?.complete, true, result.rawPath ? readFileSync(result.rawPath, 'utf8') : result.content)
    assert.equal(result.verification?.coverage?.files.length, 2)
    assert.equal(new Set(result.verification?.coverage?.files.map(file => file.project)).size, 2)
    assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
  } finally { f.dispose() }
})

test('fixed Node script keeps hooks, loader, filenames and excludes nested child evidence', async () => {
  const f = fixture('node-test')
  try {
    f.write('loader.mjs', 'globalThis.fixtureLoaded=true;')
    f.write(f.file, "import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';test('loader',()=>assert.equal(globalThis.fixtureLoaded,true));test('nested',()=>assert.equal(spawnSync(process.execPath,['--test','nested.test.mjs'],{encoding:'utf8'}).status,0));")
    f.write('nested.test.mjs', "import {test} from 'node:test';test('nested',()=>{});")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    pkg.scripts.test = 'node --import ./loader.mjs --test a.test.mjs'; f.write('package.json', pkg)
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'fixed-node', input: { files: [f.file] } })
    assert.equal(result.isError, false, result.content)
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.deepEqual(result.verification?.coverage?.files.map(file => file.path), [f.file])
    assert.equal(readFileSync(join(f.cwd, 'hooks.log'), 'utf8'), 'pre\npost\n')
  } finally { f.dispose() }
})
for (const runner of ['vitest', 'jest'] as const) {
  test(`${runner} actual script emits a bound complete receipt without losing pre/post hooks`, { skip: !available(runner) && 'requires installed matrix fixture dependencies' }, async () => {
    const f = fixture(runner)
    try {
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'framework', input: { files: [f.file] } })
      assert.equal(result.isError, false, result.content)
      const proof = result.verification!
      assert.equal(proof.coverage?.version, 3)
      assert.equal(proof.coverage?.complete, true, JSON.stringify(proof))
      assert.equal(proof.countsReliable, true)
      assert.equal(proof.passed, 1)
      assert.deepEqual(assessImpactedTestCoverage([f.file], [proof], () => true, f.cwd).uncovered, [])
      assert.equal(readFileSync(join(f.directory, 'hooks.log'), 'utf8'), 'pre\npost\n')
    } finally { f.dispose() }
  })
  test(`${runner} mixed outcomes preserve good coverage; focused execution cannot claim a whole file`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    try {
      const other = runner === 'vitest' ? 'src/b.spec.tsx' : 'src/b.test.cjs'
      f.write(other, runner === 'vitest' ? "import {test} from 'vitest';test('failure',()=>{throw Error('expected')});" : "test('failure',()=>{throw Error('expected')});")
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'framework-mixed', input: { files: [f.file, other] } })
      assert.equal(result.isError, true)
      assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
      assert.deepEqual(assessImpactedTestCoverage([f.file, other], [result.verification!], () => true, f.cwd), { uncovered: [other], uncoverable: [], failed: [other] })
      f.write(other, runner === 'vitest' ? "import {test} from 'vitest';test.skip('skip',()=>{});" : "test.skip('skip',()=>{});")
      const skipped = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'framework-mixed-skip', input: { files: [f.file, other] } })
      assert.deepEqual(assessImpactedTestCoverage([f.file, other], [skipped.verification!], () => true, f.cwd).uncovered, [other])
      f.write(f.file, runner === 'vitest' ? "import {test} from 'vitest';test.only('selected',()=>{});test('omitted',()=>{});" : "test.only('selected',()=>{});test('omitted',()=>{});")
      const focused = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'framework-focused', input: { files: [f.file] } })
      assert.ok(focused.verification?.coverage?.filtered || !focused.verification?.coverage?.complete, JSON.stringify(focused.verification))
      assert.deepEqual(assessImpactedTestCoverage([f.file], [focused.verification!], () => true, f.cwd).uncovered, [f.file])
    } finally { f.dispose() }
  })
}

test('real Node mixed batch does not erase a successful file', async () => {
  const f = fixture('node-test')
  try {
    f.write('bad.test.mjs', "import {test} from 'node:test';test('failure',()=>{throw Error('expected')});")
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-mixed-proof', input: { command: 'node --test a.test.mjs bad.test.mjs' } })
    const proof = buildBashVerification('node --test a.test.mjs bad.test.mjs', result, { content: result.content, isError: !!result.isError }, f.cwd)
    assert.equal(proof.coverage?.complete, true)
    assert.deepEqual(assessImpactedTestCoverage([f.file], [proof], () => true, f.cwd).uncovered, [])
    assert.deepEqual(assessImpactedTestCoverage(['bad.test.mjs'], [proof], () => true, f.cwd).failed, ['bad.test.mjs'])
  } finally { f.dispose() }
})

test('workspace root and background completion share the same Vitest capture', { skip: !available('vitest') }, async () => {
  const f = fixture('vitest', true), jobs = new SessionJobs(join(f.cwd, '.jobs'))
  try {
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'workspace-filter', input: { filter: f.path } })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.deepEqual(result.verification?.targetFiles, [f.path])
    const records: import('../types.js').VerificationMetadata[] = []
    const launched = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'workspace-background', jobs, onVerificationCompleted: record => records.push(record), input: { command: 'pnpm --filter @fixture/web test', run_in_background: true } })
    assert.equal(records.length, 0)
    const done = await jobs.await(launched.backgroundJobId!, { timeoutMs: 30_000 })
    assert.equal(done?.timedOut, false)
    assert.equal(records.length, 1)
    assert.equal(records[0]!.coverage?.complete, true, JSON.stringify(records[0]))
    assert.deepEqual(assessImpactedTestCoverage([f.path], records, () => true, f.cwd).uncovered, [])
  } finally { await jobs.killAllAsync(); f.dispose() }
})
