import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyMutation } from '../experiments/verify-recovery-mutations.mjs'

const root = mkdtempSync(join(tmpdir(), 'rivet-mutation-check-tests-'))
after(() => rmSync(root, { recursive: true, force: true }))

function scenario(baseline: string, mutant: string, applied = true) {
  const dir = mkdtempSync(join(root, 'case-')), phases: string[] = []
  mkdirSync(join(dir, 'evidence'))
  return { dir, phases, run: (phase: string, env: NodeJS.ProcessEnv) => {
    phases.push(phase)
    const file = join(dir, phase + '.test.mjs')
    writeFileSync(file, "import {test} from 'node:test';import assert from 'node:assert/strict';\n"
      + (phase === 'mutant' && applied ? "console.error('MUTATION APPLIED: retrievalReadonly');\n" : '')
      + (phase === 'baseline' ? baseline : mutant).replaceAll("'target'", "'real grep handles fixture'"))
    return spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env, encoding: 'utf8', timeout: 5000 })
  } }
}

test('mutation checker refuses a pre-existing baseline failure without running the mutant', () => {
  const s = scenario("test('target',()=>assert.fail('unrelated baseline problem'))", "test('target',()=>assert.fail('mutation'))")
  assert.throws(() => verifyMutation('retrievalReadonly', join(s.dir, 'evidence'), s.run), /baseline must be GREEN/)
  assert.deepEqual(s.phases, ['baseline'])
  assert.match(readFileSync(join(s.dir, 'evidence/retrievalReadonly.baseline.log'), 'utf8'), /unrelated baseline problem/)
})
test('mutation checker accepts only an applied target assertion after a green baseline', () => {
  const s = scenario("test('target',()=>assert.equal(1,1))", "test('target',()=>assert.equal(1,2))")
  verifyMutation('retrievalReadonly', join(s.dir, 'evidence'), s.run)
  assert.deepEqual(s.phases, ['baseline', 'mutant'])
  for (const [body, applied] of [
    ["test('target',()=>assert.equal(1,1))", true],
    ["test('other test',()=>assert.equal(1,2))", true],
    ["test('target',()=>assert.equal(1,2))", false],
    ["assert.fail('loader failed before the selected test')", true],
  ] as const) {
    const broken = scenario("test('target',()=>assert.equal(1,1))", body, applied)
    assert.throws(() => verifyMutation('retrievalReadonly', join(broken.dir, 'evidence'), broken.run))
  }
})
test('mutation checker rejects empty, skipped, TODO or cancelled baseline selections', () => {
  for (const baseline of ['', "test.skip('target',()=>{})", "test.todo('target')", "test('target',{timeout:10},()=>new Promise(()=>{}))"]) {
    const s = scenario(baseline, "test('target',()=>assert.fail('mutation'))")
    assert.throws(() => verifyMutation('retrievalReadonly', join(s.dir, 'evidence'), s.run))
    assert.deepEqual(s.phases, ['baseline'])
  }
})
