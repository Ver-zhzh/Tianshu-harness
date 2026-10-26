import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { nativeHeader } from '../../src/platform/__tests__/native-binary-fixtures.js'
import { packJobLauncher } from '../pack-job-launcher.js'
import { invalidateJobLauncherCache, resolveJobLauncher } from '../../src/tools/process-kill.js'
import { inspectNativeBinary } from '../../src/platform/native-binary.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
let root: string
let previousLauncher: string | undefined

describe('Windows job launcher packaging contract', () => {
  beforeEach(() => {
    previousLauncher = process.env.RIVET_JOB_LAUNCHER
    delete process.env.RIVET_JOB_LAUNCHER
    invalidateJobLauncherCache()
    root = mkdtempSync(join(tmpdir(), 'tianshu-pack-job-'))
    mkdirSync(join(root, 'native'))
    for (const file of ['job-launch.c', 'job-hook-supervisor.h', 'build-windows.bat']) cpSync(join(repo, 'native', file), join(root, 'native', file))
  })
  afterEach(() => {
    if (previousLauncher === undefined) delete process.env.RIVET_JOB_LAUNCHER
    else process.env.RIVET_JOB_LAUNCHER = previousLauncher
    invalidateJobLauncherCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('builds the tracked source through the existing MSVC batch entry and stages validated PE output', () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const bytes = nativeHeader('win32', 'x64')
    const run = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options })
      const output = resolve(String(options.cwd), args[4] ?? '.')
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, 'job-launch.exe'), bytes)
      return Buffer.alloc(0)
    }) as unknown as typeof execFileSync
    const target = packJobLauncher(root, { os: 'win32', arch: 'x64' }, { host: { os: 'win32', arch: 'x64' }, run })
    assert.equal(target, join(root, 'dist', 'native', 'job-launch.exe'))
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.command, /cmd\.exe$/i)
    assert.deepEqual(calls[0]!.args, ['/d', '/c', 'build-windows.bat', 'x64', 'win32-x64'])
    assert.equal(calls[0]!.options.cwd, join(root, 'native'))
    assert.equal(calls[0]!.options.timeout, 120_000)
    assert.deepEqual(readFileSync(target!), bytes)
  })

  it('builds a Windows ARM64 target separately without replacing the x64 host helper', () => {
    const host = join(root, 'dist', 'native', 'job-launch.exe')
    mkdirSync(join(host, '..'), { recursive: true })
    const before = nativeHeader('win32', 'x64')
    writeFileSync(host, before)
    const preferred = join(root, 'native', 'job-launch.exe')
    const preferredBytes = Buffer.concat([before, Buffer.from('preferred host helper')])
    writeFileSync(preferred, preferredBytes)
    const run = ((_command: string, args: string[]) => {
      assert.equal(args[3], 'arm64')
      const output = resolve(root, 'native', args[4] ?? '.')
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, 'job-launch.exe'), nativeHeader('win32', 'arm64'))
      return Buffer.alloc(0)
    }) as unknown as typeof execFileSync
    const target = packJobLauncher(root, { os: 'win32', arch: 'arm64' }, { host: { os: 'win32', arch: 'x64' }, run })
    assert.equal(target, join(root, 'dist', 'native', 'win32-arm64', 'job-launch.exe'))
    assert.deepEqual(readFileSync(host), before)
    assert.deepEqual(readFileSync(preferred), preferredBytes)
    const resolved = resolveJobLauncher({ here: join(root, 'src', 'tools'), platform: 'win32' })
    assert.equal(resolved, preferred)
    assert.deepEqual(inspectNativeBinary(resolved!), { format: 'PE', architectures: ['x64'] })
    assert.deepEqual(inspectNativeBinary(join(root, 'native', 'win32-arm64', 'job-launch.exe')), { format: 'PE', architectures: ['arm64'] })
  })

  it('fails on unavailable compiler context without overwriting an existing staged helper', () => {
    const target = join(root, 'dist', 'native', 'job-launch.exe')
    mkdirSync(join(target, '..'), { recursive: true })
    const before = nativeHeader('win32', 'x64')
    writeFileSync(target, before)
    const run = (() => { throw new Error('MSVC compiler context unavailable') }) as typeof execFileSync
    assert.throws(() => packJobLauncher(root, { os: 'win32', arch: 'x64' }, { host: { os: 'win32', arch: 'x64' }, run }), /MSVC/)
    assert.deepEqual(readFileSync(target), before)
  })

  it('stages a locally supplied Windows-built cross target without downloading or changing host files', () => {
    const source = join(root, 'native', 'win32-x64', 'job-launch.exe')
    mkdirSync(join(source, '..'), { recursive: true })
    const bytes = nativeHeader('win32', 'x64')
    writeFileSync(source, bytes)
    const target = packJobLauncher(root, { os: 'win32', arch: 'x64' }, {
      host: { os: 'darwin', arch: 'arm64' }, run: (() => assert.fail('cross staging must not execute or download a Windows binary')) as typeof execFileSync,
    })
    assert.equal(target, join(root, 'dist', 'native', 'win32-x64', 'job-launch.exe'))
    assert.deepEqual(readFileSync(target!), bytes)
    assert.equal(existsSync(join(root, 'dist', 'native', 'job-launch.exe')), false)
  })

  it('rejects a wrong-architecture helper before overwriting a valid staged target', () => {
    const source = join(root, 'native', 'win32-x64', 'job-launch.exe')
    const target = join(root, 'dist', 'native', 'win32-x64', 'job-launch.exe')
    mkdirSync(join(source, '..'), { recursive: true })
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(source, nativeHeader('win32', 'arm64'))
    const before = nativeHeader('win32', 'x64')
    writeFileSync(target, before)
    assert.throws(() => packJobLauncher(root, { os: 'win32', arch: 'x64' }, { host: { os: 'darwin', arch: 'arm64' } }), /expected PE x64/)
    assert.deepEqual(readFileSync(target), before)
  })

  it('leaves non-Windows target builds unchanged and does not probe a Windows compiler', () => {
    for (const os of ['darwin', 'linux']) {
      assert.equal(packJobLauncher(root, { os, arch: 'x64' }, { host: { os: 'win32', arch: 'x64' }, run: (() => assert.fail('not a Windows target')) as typeof execFileSync }), null)
    }
    assert.equal(existsSync(join(root, 'dist')), false)
  })

  it('does not fabricate or download a missing cross helper; desktop staging must require it', () => {
    const target = packJobLauncher(root, { os: 'win32', arch: 'x64' }, { host: { os: 'darwin', arch: 'arm64' }, run: (() => assert.fail('no unsigned helper download')) as typeof execFileSync })
    assert.equal(target, null)
    assert.equal(existsSync(join(root, 'dist', 'native', 'win32-x64', 'job-launch.exe')), false)
  })
})
