import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startHookProcess } from '../hook-process.js'
import { resolveHookLauncher } from '../hook-job-launcher.js'
import { hookFrame, hookFrameDecoder, HookFrame } from '../hook-frames.js'

test('supervisor frame codec handles fragmented headers and bounded payloads', () => {
  const frames: Array<[number, string]> = []
  const decode = hookFrameDecoder((kind, bytes) => frames.push([kind, bytes.toString('utf8')]))
  const wire = Buffer.concat([hookFrame(HookFrame.stdout, Buffer.from('中文🙂')), hookFrame(HookFrame.cancel)])
  for (const byte of wire) decode(Buffer.from([byte]))
  assert.deepEqual(frames, [[HookFrame.stdout, '中文🙂'], [HookFrame.cancel, '']])
  const oversized = Buffer.alloc(5); oversized.writeUInt32LE(65_537, 1)
  assert.throws(() => decode(oversized), /64KiB/)
})

test('Windows native supervisor preserves stdin and confirms job cleanup', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  assert.ok(await resolveHookLauncher(), 'native Windows acceptance requires a compatible built helper')
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-native-'))
  try {
    const handle = startHookProcess({ cmd: process.execPath, args: ['-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(input))`],
      cwd, env: process.env, input: '{"text":"中文🙂"}', timeoutMs: 5_000 })
    assert.equal((await handle.result).output, '{"text":"中文🙂"}')
    assert.equal(await handle.reaped, 'exited')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('Windows job cancellation stops a detached descendant before its late write', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-native-tree-'))
  try {
    const descendant = `setTimeout(()=>require('fs').writeFileSync('late','1'),1500)`
    const body = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true}).unref();require('fs').writeFileSync('ready','1');setInterval(()=>{},1000)`
    const handle = startHookProcess({ cmd: process.execPath, args: ['-e', body], cwd, env: process.env, input: '{}', timeoutMs: 5_000 })
    const until = Date.now() + 5_000
    while (!await readFile(join(cwd, 'ready')).then(() => true, () => false)) {
      assert.ok(Date.now() < until, 'supervised command did not start')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    handle.cancel()
    assert.equal((await handle.result).status, 'cancelled')
    assert.equal(await handle.reaped, 'exited')
    await new Promise(resolve => setTimeout(resolve, 1_600))
    assert.equal(await readFile(join(cwd, 'late')).then(() => true, () => false), false)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('Windows missing or incompatible helper never spawns the user command', { skip: process.platform !== 'win32' }, async () => {
  const previous = process.env.RIVET_JOB_LAUNCHER
  process.env.RIVET_JOB_LAUNCHER = process.execPath
  try {
    const handle = startHookProcess({ cmd: process.execPath, args: ['-e', 'process.stdout.write("MUST NOT RUN")'], cwd: tmpdir(), env: process.env, input: '{}', timeoutMs: 5_000 })
    const result = await handle.result
    assert.equal(result.reason, 'helper_unavailable')
    assert.equal(result.output, '')
    assert.equal(await handle.reaped, 'exited')
  } finally {
    if (previous === undefined) delete process.env.RIVET_JOB_LAUNCHER
    else process.env.RIVET_JOB_LAUNCHER = previous
  }
})

test('Windows batch interpreter preserves paths containing spaces, unicode and shell characters', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-batch-'))
  try {
    const script = join(cwd, '中文 & literal%PATH% batch.cmd')
    await writeFile(script, '@echo off\r\necho batch-ok\r\n')
    const handle = startHookProcess({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', script], cwd, env: process.env, input: '{}', timeoutMs: 5_000 })
    const result = await handle.result
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.output, 'batch-ok')
    assert.equal(await handle.reaped, 'exited')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
