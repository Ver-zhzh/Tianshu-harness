import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { HookWorld } from '../experiments/scoped-hook-world.js'

const home = mkdtempSync(join(tmpdir(), 'rivet-hook-tests-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('historical service really blocks; reference preserves all declared behaviours', { skip: process.platform !== 'darwin' }, async () => {
  for (const fixed of [false, true]) {
    const world = new HookWorld(fixed)
    try {
      const checks = await world.checks(), grade = await world.grade()
      assert.equal(checks.complete, true)
      assert.equal(checks.passed, fixed, JSON.stringify(checks))
      assert.equal(grade.parsed.results.length, 15)
      assert.equal(grade.passed, fixed, JSON.stringify(grade))
      assert.equal(grade.protectedUnchanged, true)
      const cases = new Map(grade.parsed.results.map((r: any) => [r.id, r.passed]))
      assert.equal(cases.get('hook-executed'), true)
      assert.equal(cases.get('owned-isolation'), true)
      assert.equal(cases.get('responsiveness'), fixed)
      assert.ok(!JSON.stringify(checks).includes("couldn't create cache file"))
    } finally { world.close() }
  }
})

test('making helper async without awaiting the real consumer is RED', { skip: process.platform !== 'darwin' }, async () => {
  const world = new HookWorld(true)
  try {
    const file = join(world.root, 'src/delivery.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace('await commitScopedFiles', 'commitScopedFiles'))
    const checks = await world.checks()
    assert.equal(checks.passed, false)
    assert.match(checks.runs[0].output, /Promise|Property.*ok/)
  } finally { world.close() }
})

test('real cancelled/timeout outcomes are judged by execution evidence, not blocked spelling', { skip: process.platform !== 'darwin' }, async () => {
  const world = new HookWorld(true)
  try {
    const file = join(world.root, 'src/delivery.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace("status:'blocked'", "status:input.signal?.aborted||input.timeoutMs?'cancelled':'blocked'"))
    const grade = await world.grade()
    for (const id of ['cancel', 'timeout']) assert.equal(grade.parsed.results.find((r: any) => r.id === id).passed, true, JSON.stringify(grade.parsed.results))
  } finally { world.close() }
})

test('protected fixture changes cannot produce trusted completion evidence', { skip: process.platform !== 'darwin' }, async () => {
  const world = new HookWorld(true)
  try {
    writeFileSync(join(world.root, 'README.md'), 'changed outside the authorized source surface')
    const checks = await world.checks('test/smoke.test.mjs')
    assert.equal(checks.protectedUnchanged, false)
    assert.equal(checks.complete, false)
    assert.equal(checks.passed, false)
  } finally { world.close() }
})

test('spawned children keep OS restrictions on external data and network', { skip: process.platform !== 'darwin' }, async () => {
  const world = new HookWorld()
  try {
    const external = join(home, 'outside-fixture.txt')
    writeFileSync(external, 'fixture marker')
    const child = `import{readFileSync,writeFileSync}from'node:fs';import{connect}from'node:net';
let readDenied=false,writeDenied=false;try{readFileSync(${JSON.stringify(external)})}catch(e){readDenied=['EPERM','EACCES'].includes(e.code)}
try{writeFileSync(${JSON.stringify(external)},'changed')}catch(e){writeDenied=['EPERM','EACCES'].includes(e.code)}
const s=connect({host:'127.0.0.1',port:9});s.on('error',e=>console.log(JSON.stringify({readDenied,writeDenied,networkDenied:['EPERM','EACCES'].includes(e.code)})));setTimeout(()=>s.destroy(),300).unref();`
    writeFileSync(join(world.root, 'test/child.mjs'), child)
    writeFileSync(join(world.root, 'test/boundary.mjs'), `import{spawnSync}from'node:child_process';const r=spawnSync('/usr/bin/env',['-i','PATH=/usr/bin:/bin',process.execPath,'test/child.mjs'],{encoding:'utf8'});console.log(r.stdout,r.stderr);process.exitCode=r.status??1;`)
    const result = await (world as any).command(['test/boundary.mjs'], undefined, true)
    assert.equal(result.exit, 0, result.output)
    for (const key of ['readDenied', 'writeDenied', 'networkDenied']) assert.ok(result.output.includes(`"${key}":true`), result.output)
    assert.equal(readFileSync(external, 'utf8'), 'fixture marker')
  } finally { world.close() }
})

test('advertised generated files, Unicode batch reads and test listener work in the real world', { skip: process.platform !== 'darwin' }, async () => {
  const world = new HookWorld()
  try {
    await world.initialize()
    const preflight = await world.preflight()
    assert.equal(preflight.passed, true, JSON.stringify(preflight))
    await world.execute('write_file', { file_path: 'src/中文 空格.ts', content: 'export const fixture=1;\n' })
    const read = await world.execute('read_file', { file_paths: ['.build/delivery.mjs', 'src/中文 空格.ts'] })
    assert.notEqual(read.isError, true, read.content)
    const directory = await world.execute('read_file', { file_path: 'src' })
    assert.equal(directory.observation.code, 'directory_path'); assert.match(directory.content, /list_files/)
    const write = await world.execute('write_file', { file_path: '.build/delivery.mjs', content: 'fake' })
    assert.equal(write.observation.code, 'protected_path')
    const path = join(world.root, 'test/监听 空格.test.mjs')
    writeFileSync(path, `import{test}from'node:test';import assert from'node:assert/strict';import{createServer}from'node:http';import{listen}from'../support/test-server.mjs';
test('assigned listener',async()=>{const server=createServer((q,r)=>r.end('ok'));const h=await listen(server);try{assert.equal(await(await fetch(h.url)).text(),'ok')}finally{await h.close()}});`)
    const checks = await world.execute('run_checks', { test_file: 'test/监听 空格.test.mjs' })
    assert.equal(checks.check.passed, true, checks.content)
    assert.equal(checks.content.includes('[PERM0002]'), false, 'raw launcher warning remains in trace, not repeated in model check output')
    const ports = [...world.capabilities.loopbackPorts], occupied = createServer()
    await new Promise<void>(r => occupied.listen(ports[0], '127.0.0.1', r))
    try {
      const conflict = await world.execute('run_checks', { test_file: 'test/监听 空格.test.mjs' })
      assert.equal(conflict.observation.origin, 'harness'); assert.equal(conflict.observation.executed, false)
      assert.equal(conflict.observation.code, 'assigned_port_unavailable'); assert.deepEqual(world.capabilities.loopbackPorts, ports)
    } finally { await new Promise<void>(r => occupied.close(() => r())) }
    const before = world.sourceHash()
    const hidden = await world.execute('write_file', { file_path: 'src/.internal.ts', content: 'export const hidden=1;' })
    assert.notEqual(hidden.isError, true); assert.notEqual(world.sourceHash(), before, 'declared hidden source must participate in proof binding')
  } finally { world.close() }
})
