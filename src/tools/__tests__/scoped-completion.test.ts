import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import { BASH_TOOL } from '../bash.js'
import { buildBashVerification } from '../../agent/bash-verification.js'
import { assessImpactedTestCoverage } from '../../agent/verification-attribution.js'
import { buildDeliveryVerificationPlan } from '../../agent/delivery-verification-plan.js'
import { parseTestSelection } from '../test-selection.js'
import { readCompletionCoverage } from '../test-completion.js'
import { SessionJobs } from '../job-store.js'
import { available, dependencies, fixture } from './framework-fixture.js'

test('project selectors consume native arity and invalid shard cannot become a filename', () => {
  const s = parseTestSelection(['--selectProjects', 'green', 'red', '--ignoreProjects=blue', '--shard', '2/3', '--runTestsByPath', 'a.test.cjs'])
  assert.deepEqual(s.projects, ['green', 'red'])
  assert.deepEqual(s.rest, ['--runTestsByPath', 'a.test.cjs'])
  assert.deepEqual(s.shard, { index: 2, total: 3 })
  for (const value of ['0/2', '3/2', 'x/2', '1/0', '1.5/2']) assert.ok(parseTestSelection(['--shard=' + value]).reason)
})

for (const runner of ['jest', 'vitest'] as const) {
  test(`${runner} valid empty shard is complete and earns no coverage`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    try {
      const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
      pkg.scripts.test += ' --shard=2/2 --passWithNoTests'; f.write('package.json', pkg)
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'empty-shard', input: {} })
      assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
      assert.equal(result.verification?.coverage?.files.length, 0)
      assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
    } finally { f.dispose() }
  })

  test(`${runner} selected project cannot erase another project's obligation or failure`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    try {
      f.write(runner === 'jest' ? 'setup.cjs' : 'setup.mjs', 'globalThis.mustFail=true;')
      if (runner === 'jest') f.write('jest.config.cjs', "module.exports={projects:[{displayName:'green',testMatch:['**/*.test.cjs']},{displayName:'red',testMatch:['**/*.test.cjs'],setupFiles:['<rootDir>/setup.cjs']}]};")
      else {
        const major = Number(JSON.parse(readFileSync(join(dependencies!, 'node_modules/vitest/package.json'), 'utf8')).version.split('.')[0])
        const projects = "[{test:{name:'green',include:['**/*.spec.tsx']}},{test:{name:'red',include:['**/*.spec.tsx'],setupFiles:['./setup.mjs']}}]"
        f.write(major === 2 ? 'vitest.workspace.mjs' : 'vitest.config.mjs', major === 2 ? 'export default ' + projects : 'export default {test:{projects:' + projects + '}}')
      }
      f.write(f.file, (runner === 'vitest' ? "import {test,expect} from 'vitest';" : '') + "test('scope',()=>expect(globalThis.mustFail).not.toBe(true));")
      const run = (projects?: string[]) => RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'scope-project', input: { files: [f.file], projects } })
      const all = await run(), green = await run(['green'])
      assert.equal(all.verification?.coverage?.complete, true, JSON.stringify(all.verification))
      assert.equal(green.verification?.coverage?.complete, true, JSON.stringify(green.verification))
      assert.equal(green.verification?.coverage?.files.length, 1)
      assert.equal(JSON.stringify(green.verification?.coverage).includes('projectConfig'), false)
      assert.deepEqual(assessImpactedTestCoverage([f.file], [green.verification!], () => true, f.cwd).uncovered, [f.file])
      const evidence = [all.verification!, green.verification!]
      assert.deepEqual(assessImpactedTestCoverage([f.file], evidence, () => true, f.cwd).uncovered, [f.file])
      const events = evidence.map((v, i) => ({ type: 'verification', command: v.command, status: v.status, timestamp: i, meta: { ...v } })) as Parameters<typeof buildDeliveryVerificationPlan>[4]
      const plan = buildDeliveryVerificationPlan(f.cwd, [f.file], [f.file], 0, events)
      assert.equal(plan.requiredScopes?.length, 2)
      assert.equal(plan.pendingScopes?.length, 1)
      assert.equal(plan.pendingScopes?.[0]?.label, 'red')
      assert.deepEqual(plan.batches[0]?.projects, ['red'])
      assert.match(plan.pendingReasons[0]!.reason, /red/)
      if (runner === 'jest') {
        f.write('green.config.cjs', "module.exports={testMatch:['**/*.test.cjs']};")
        // Establish all source bytes before both proof runs; config changes themselves invalidate evidence.
        const before = await run()
        const bash = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'scope-alternate-config', input: { command: 'npm test -- --config green.config.cjs --runTestsByPath ' + f.file } })
        const alternate = buildBashVerification('npm test -- --config green.config.cjs --runTestsByPath ' + f.file, bash, { content: bash.content, isError: !!bash.isError }, f.cwd)!
        assert.deepEqual(assessImpactedTestCoverage([f.file], [before.verification!, alternate], () => true, f.cwd).uncovered, [f.file])
      }
    } finally { f.dispose() }
  })

  test(`${runner} real shard union, duplicate shard and unsharded remaining-file repair`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    try {
      const files = [f.file, ...['b', 'c', 'd', 'e'].map(n => f.file.replace('/a.', '/' + n + '.'))]
      for (const file of files) f.write(file, runner === 'jest' ? "test('file',()=>{});" : "import {test} from 'vitest';test('file',()=>{});")
      const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
      pkg.scripts.test += ' --shard=1/2'; f.write('package.json', pkg)
      const first = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'shard-one', input: {} })
      assert.equal(first.verification?.coverage?.complete, true, JSON.stringify(first.verification))
      const pending = assessImpactedTestCoverage(files, [first.verification!], () => true, f.cwd).uncovered
      assert.ok(pending.length > 0 && pending.length < files.length)
      assert.deepEqual(assessImpactedTestCoverage(files, [first.verification!, first.verification!], () => true, f.cwd).uncovered, pending)
      const repair = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'shard-repair', input: { files: pending, shard: false } })
      assert.equal(repair.verification?.coverage?.complete, true, JSON.stringify(repair.verification))
      assert.deepEqual(assessImpactedTestCoverage(files, [first.verification!, repair.verification!], () => true, f.cwd).uncovered, [])
      const second = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'shard-two', input: { command: 'npm exec -- ' + pkg.scripts.test.replace('--shard=1/2', '--shard=2/2') } })
      const secondProof = buildBashVerification('npm exec -- ' + pkg.scripts.test.replace('--shard=1/2', '--shard=2/2'), second, { content: second.content, isError: !!second.isError }, f.cwd)!
      assert.equal(secondProof.coverage?.complete, true, JSON.stringify(secondProof))
      assert.deepEqual(assessImpactedTestCoverage(files, [first.verification!, secondProof], () => true, f.cwd).uncovered, [])
      const corrupt = structuredClone(secondProof.coverage!)
      corrupt.catalog!.scopes[0]!.project = '0'.repeat(64)
      assert.equal(readCompletionCoverage(corrupt), undefined)
    } finally { f.dispose() }
  })
}

test('background selected project finishes once and persisted scopes retain missing projects', { skip: !available('jest') }, async () => {
  const f = fixture('jest'), jobs = new SessionJobs(join(f.cwd, '.jobs'))
  try {
    f.write('jest.config.cjs', "module.exports={projects:[{displayName:'one',testMatch:['**/*.test.cjs']},{displayName:'two',testMatch:['**/*.test.cjs']}]};")
    const records: import('../types.js').VerificationMetadata[] = []
    const result = await BASH_TOOL.execute({ cwd: f.cwd, jobs, onVerificationCompleted: v => records.push(v), toolUseId: 'background-scopes', input: { command: 'npm test -- --selectProjects one --runTestsByPath ' + f.file, run_in_background: true } })
    assert.equal(records.length, 0)
    const done = await jobs.await(result.backgroundJobId!, { timeoutMs: 30000 })
    assert.equal(done?.timedOut, false)
    assert.equal(records.length, 1)
    const completion = records[0]!
    assert.equal(completion.coverage?.complete, true, JSON.stringify(completion))
    await jobs.await(result.backgroundJobId!, { timeoutMs: 100 })
    assert.equal(records.length, 1)
    const restored = JSON.parse(JSON.stringify(completion))
    assert.deepEqual(assessImpactedTestCoverage([f.file], [restored], () => true, f.cwd).uncovered, [f.file])
    assert.equal(restored.coverage.catalog.scopes.length, 2)
  } finally { await jobs.killAllAsync(); f.dispose() }
})

test('Node reporter ENV/CLI pairs and native shards preserve user output and completed files', async () => {
  const f = fixture('node-test'), original = process.env.NODE_OPTIONS
  try {
    f.write('b.test.mjs', "import {test} from 'node:test';test('other',()=>{});")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    pkg.scripts.test += ' --test-reporter=spec --test-reporter-destination=user.log --test-shard=1/2'; f.write('package.json', pkg)
    process.env.NODE_OPTIONS = (original ?? '') + ' --test-reporter=dot --test-reporter-destination=env.log'
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-outputs', input: {} })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(result.verification?.coverage?.files.length, 1)
    assert.ok(readFileSync(join(f.cwd, 'user.log'), 'utf8').length)
    assert.ok(readFileSync(join(f.cwd, 'env.log'), 'utf8').length)
    const repair = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-shard-capability', input: { files: [f.file], shard: false } })
    assert.equal(repair.verification?.coverage?.complete, true, JSON.stringify(repair.verification))
    assert.deepEqual(repair.verification?.coverage?.files.map(f => f.path), [f.file])
    pkg.scripts.test += ' ' + f.file; f.write('package.json', pkg)
    const fixed = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-fixed-shard', input: { files: [f.file], shard: false } })
    assert.match(fixed.content, /node_shard_override_unavailable/)
    pkg.scripts.test = 'node --test --test-reporter=spec ' + f.file; f.write('package.json', pkg)
    if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original
    const implicit = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-implicit-stdout', input: { files: [f.file] } })
    assert.equal(implicit.verification?.coverage?.complete, true, JSON.stringify(implicit.verification))
  } finally { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; f.dispose() }
})

test('Node late user reporter error cannot bless a mixed batch', async () => {
  const f = fixture('node-test')
  try {
    f.write('b.test.mjs', "import {test} from 'node:test';test('fails',()=>{throw new Error('assertion')});")
    f.write('reporter.mjs', "export default async function*(events){for await(const event of events)yield '';throw new Error('late reporter error')}")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    pkg.scripts.test += ' --test-reporter=./reporter.mjs'; f.write('package.json', pkg)
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'node-late-output-error', input: { files: [f.file, 'b.test.mjs'] } })
    assert.equal(result.verification?.coverage?.complete, false, JSON.stringify(result.verification))
    assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
  } finally { f.dispose() }
})

test('Jest keeps user JSON, reporter tuple options and processor alongside internal proof', { skip: !available('jest') }, async () => {
  const f = fixture('jest')
  try {
    f.write('observer.cjs', "const fs=require('fs');module.exports=class{constructor(g,o){fs.appendFileSync('reporter.log',o.marker)}onRunComplete(){fs.appendFileSync('reporter.log',' complete')}};")
    f.write('processor.cjs', "const fs=require('fs');module.exports=r=>{fs.appendFileSync('processor.log','processed');return r};")
    f.write('jest.config.cjs', "module.exports=async()=>({testMatch:['**/*.test.cjs'],reporters:[['./observer.cjs',{marker:'preserved'}]],testResultsProcessor:'./processor.cjs'});")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8')); pkg.scripts.test += ' --json --outputFile=user.json.out'; f.write('package.json', pkg)
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'jest-user-output', input: { files: [f.file] } })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(JSON.parse(readFileSync(join(f.cwd, 'user.json.out'), 'utf8')).numPassedTests, 1)
    assert.equal(readFileSync(join(f.cwd, 'reporter.log'), 'utf8'), 'preserved complete')
    assert.equal(readFileSync(join(f.cwd, 'processor.log'), 'utf8'), 'processed')
  } finally { f.dispose() }
})

test('Jest duplicate unnamed declaration slots remain distinct and can be reverified', { skip: !available('jest') }, async () => {
  const f = fixture('jest')
  try {
    f.write('jest.config.cjs', "module.exports={projects:[{testMatch:['**/*.test.cjs']},{testMatch:['**/*.test.cjs']}]};")
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'identical-projects', input: { files: [f.file], projects: [] } })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(new Set(result.verification?.coverage?.files.map(f => f.project)).size, 2)
    assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [])
  } finally { f.dispose() }
})

test('Jest explicit project config paths and CLI reporter list retain scopes and output', { skip: !available('jest') }, async () => {
  const f = fixture('jest')
  try {
    for (const name of ['one', 'two']) f.write(name + '.config.cjs', "module.exports={displayName:'" + name + "',testMatch:['**/*.test.cjs']};")
    f.write('observer.cjs', "require('fs').appendFileSync('reporter.log','loaded ');module.exports=class{onRunComplete(){require('fs').appendFileSync('reporter.log','done')}};")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    pkg.scripts.test += ' --projects one.config.cjs two.config.cjs --reporters default ./observer.cjs'; f.write('package.json', pkg)
    const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'project-paths', input: { files: [f.file] } })
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(result.verification?.coverage?.files.length, 2)
    assert.match(readFileSync(join(f.cwd, 'reporter.log'), 'utf8'), /done/)
    assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [])
  } finally { f.dispose() }
})

test('Jest output errors invalidate even a mixed batch with real passing files', { skip: !available('jest') }, async () => {
  const f = fixture('jest')
  try {
    f.write('src/b.test.cjs', "test('fails',()=>expect(0).toBe(1));")
    f.write('error-reporter.cjs', "module.exports=class{getLastError(){return new Error('user output failed')}};")
    f.write('error-processor.cjs', "module.exports=()=>{throw new Error('user processor failed')};")
    const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8'))
    for (const mode of ['reporter', 'processor', 'file']) {
      pkg.scripts.test = 'jest --runInBand' + (mode === 'file' ? ' --json --outputFile=missing-directory/report.json' : '')
      f.write('package.json', pkg)
      f.write('jest.config.cjs', "module.exports={testMatch:['**/*.test.cjs']," + (mode === 'reporter' ? "reporters:['./error-reporter.cjs']" : mode === 'processor' ? "testResultsProcessor:'./error-processor.cjs'" : '') + '};')
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'output-error-' + mode, input: { files: [f.file, 'src/b.test.cjs'] } })
      assert.equal(result.verification?.coverage?.complete, false, JSON.stringify(result.verification))
      assert.equal(result.verification?.coverage?.scopeError, 'output_error')
      assert.deepEqual(assessImpactedTestCoverage([f.file], [result.verification!], () => true, f.cwd).uncovered, [f.file])
    }
  } finally { f.dispose() }
})

for (const runner of ['jest', 'vitest'] as const) {
  test(`${runner} native custom sequencer is delegated and dynamic configuration cannot forge scopes`, { skip: !available(runner) }, async () => {
    const f = fixture(runner)
    try {
      if (runner === 'jest') {
        f.write('sequence.cjs', "const fs=require('fs'),Base=require('@jest/test-sequencer').default;module.exports=class extends Base{sort(t){fs.appendFileSync('sequence.log','sort\\n');return super.sort(t)}shard(t,o){fs.appendFileSync('sequence.log','shard\\n');return super.shard(t,o)}cacheResults(...a){fs.appendFileSync('sequence.log','cache\\n');return super.cacheResults(...a)}};")
        f.write('jest.config.cjs', "module.exports={testMatch:['**/*.test.cjs'],testSequencer:'./sequence.cjs'};")
      } else {
        f.write('sequence.mjs', "import {appendFileSync} from 'node:fs';import {BaseSequencer} from 'vitest/node';export default class extends BaseSequencer{sort(t){appendFileSync('sequence.log','sort\\n');return super.sort(t)}shard(t){appendFileSync('sequence.log','shard\\n');return super.shard(t)}}")
        f.write('vitest.config.mjs', "export default {test:{sequence:{sequencer:'./sequence.mjs'}}};")
      }
      const pkg = JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8')); pkg.scripts.test += ' --shard=1/1'; f.write('package.json', pkg)
      const result = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'custom-sequence', input: { files: [f.file] } })
      assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
      assert.match(readFileSync(join(f.cwd, 'sequence.log'), 'utf8'), /sort/)
      assert.match(readFileSync(join(f.cwd, 'sequence.log'), 'utf8'), /shard/)
      const counter = "let n=0;try{n=Number(fs.readFileSync('configuration.log','utf8'))}catch{};fs.writeFileSync('configuration.log',String(++n));"
      if (runner === 'jest') f.write('jest.config.cjs', "const fs=require('fs');module.exports=()=>{" + counter + "return {testMatch:['**/*.test.cjs'],globals:{condition:n}}};")
      else f.write('vitest.config.mjs', "import fs from 'node:fs';export default ()=>{" + counter + "return {test:{environmentOptions:{condition:n}}}};")
      const changed = await RUN_TESTS_TOOL.execute({ cwd: f.cwd, toolUseId: 'dynamic-config', input: { files: [f.file] } })
      assert.notEqual(changed.verification?.coverage?.complete, true)
      assert.deepEqual(assessImpactedTestCoverage([f.file], [changed.verification!], () => true, f.cwd).uncovered, [f.file])
    } finally { f.dispose() }
  })
}
