import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FILES, referenceFix } from '../experiments/recovery-long-fixture.js'
import { RecoveryFeedback } from '../experiments/recovery-long-policy.js'

const home = mkdtempSync(join(tmpdir(), 'rivet-long-tests-'))
const saved = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
process.env.RIVET_HOME = home; process.env.RIVET_SESSION_DIR = join(home, 'sessions')
writeFileSync(join(home, 'config.json'), '{}')
const { LongWorld } = await import('../experiments/recovery-long-world.js')
const { AdvisoryBus } = await import('../../src/agent/advisory-bus.js')
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }; rmSync(home, { recursive: true, force: true }) })

test('long fixture is RED initially and independent oracle passes all behaviours', { skip: process.platform !== 'darwin' }, async () => {
  for (const fixed of [false, true]) {
    const world = new LongWorld(fixed ? referenceFix(FILES) : FILES)
    try {
      const checks = await world.checks(), grade = await world.grade()
      assert.equal(checks.complete, true)
      assert.equal(checks.passed, fixed)
      assert.equal(grade.parsed?.results.length, 12, grade.output)
      assert.equal(grade.passed, fixed, grade.output)
      assert.equal(grade.protectedUnchanged, true)
    } finally { world.close() }
  }
})

test('partial facade fix cannot hide corrupted replay or restart identity', { skip: process.platform !== 'darwin' }, async () => {
  const fixed = referenceFix(FILES)
  const world = new LongWorld({ ...fixed, 'src/state.mjs': FILES['src/state.mjs']!, 'src/service.mjs': fixed['src/service.mjs']!.replace("const token=namespace+':'+id+':'+attempt;", "const token=namespace+':'+id+':1';") })
  try {
    const grade = await world.grade()
    assert.equal(grade.passed, false)
    assert.ok(grade.parsed?.results.some((r: any) => r.id === 'replay-stale' && !r.passed))
    assert.ok(grade.parsed?.results.some((r: any) => r.id === 'restart-token' && !r.passed))
  } finally { world.close() }
})

test('source can be edited freely but original checks and external paths remain protected', { skip: process.platform !== 'darwin' }, async () => {
  const world = new LongWorld()
  try {
    await world.initialize()
    const batch = await world.execute('read_file', { file_paths: ['README.md', 'src/service.mjs'] })
    assert.notEqual(batch.isError, true)
    assert.match(batch.content, /createService/)
    const outsideBatch = await world.execute('read_file', { file_paths: ['README.md', '../config.json'] })
    assert.equal(outsideBatch.isError, true)
    const blocked = await world.execute('write_file', { file_path: 'scripts/reproduce.mjs', content: 'console.log("fake pass")' })
    assert.equal(blocked.isError, true)
    const escaped = await world.execute('read_file', { file_path: '../config.json' })
    assert.equal(escaped.isError, true)
    assert.ok(!world.files().some(p => p.includes('grade') || p.includes('oracle')))
    const write = await world.execute('write_file', { file_path: 'src/model-written.mjs', content: 'export const anyImplementation = 42;\n' })
    assert.notEqual(write.isError, true)
    assert.match((await world.execute('read_file', { file_path: 'src/model-written.mjs' })).content, /anyImplementation/)
  } finally { world.close() }
})

test('feedback is bound, bounded and does not invent cause or completion', () => {
  const valid = { before: 'same', after: 'same', complete: true, passed: false, runs: [{ id: 'reproduction', executed: true, exit: 1, timedOut: false }] }
  for (const invalid of [{ ...valid, after: 'changed' }, { ...valid, complete: false }, { ...valid, runs: [{ id: 'reproduction', executed: true, exit: null, timedOut: false }] }]) {
    assert.equal(new RecoveryFeedback().observe(invalid, true, 'run', 'call'), null)
  }
  assert.equal(new RecoveryFeedback().observe({ ...valid, runs: [{ id: 'typecheck', executed: true, exit: 1, timedOut: false }] }, true, 'run', 'compile-only'), null)
  const neutral = new RecoveryFeedback().observe(valid, false, 'run', 'call')!
  const policy = new RecoveryFeedback(), positive = policy.observe(valid, true, 'run', 'call')!
  assert.ok(positive.content.endsWith(neutral.content))
  assert.equal(positive.category, 'encouragement')
  assert.equal(policy.observe(valid, true, 'run', 'again'), null)
  assert.ok(policy.observe({ ...valid, passed: true, runs: [{ id: 'reproduction', executed: true, exit: 0, timedOut: false }] }, true, 'run', 'pass'))
  assert.equal(policy.observe(valid, true, 'run', 'fail-again'), null)
  const bus = new AdvisoryBus(); bus.setFlowStateProvider(() => true); bus.submit(positive); bus.render('七杀', 1)
  assert.equal(bus.drainSystemReminders().length, 0, 'positive feedback cannot bypass productive-flow suppression')
})

test('model-written code cannot read external files, start children, or use network', { skip: process.platform !== 'darwin' }, async () => {
  const world = new LongWorld()
  try {
    const external = join(home, 'outside-fixture.txt')
    writeFileSync(external, 'fixture-only marker')
    const probe = `import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {connect} from 'node:net';
let readDenied=false,spawnDenied=false;
try{readFileSync(${JSON.stringify(external)})}catch(e){readDenied=e.code==='ERR_ACCESS_DENIED'}
try{spawnSync(process.execPath,['--version'])}catch(e){spawnDenied=e.code==='ERR_ACCESS_DENIED'}
const socket=connect({host:'127.0.0.1',port:9});socket.on('error',e=>{console.log(JSON.stringify({readDenied,spawnDenied,networkDenied:['EPERM','EACCES'].includes(e.code),networkCode:e.code}));});setTimeout(()=>{socket.destroy();process.exitCode=2},100).unref();`
    const path = join(world.root, 'src/boundary-probe.mjs')
    writeFileSync(path, probe)
    const result = await world.process(['src/boundary-probe.mjs'])
    assert.equal(result.exit, 0, result.output)
    assert.match(result.output, /"readDenied":true/)
    assert.match(result.output, /"spawnDenied":true/)
    assert.match(result.output, /"networkDenied":true/)
  } finally { world.close() }
})
