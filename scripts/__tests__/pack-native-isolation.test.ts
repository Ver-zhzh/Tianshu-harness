import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { nativeHeader } from '../../src/platform/__tests__/native-binary-fixtures.js'
import { assertNativeBinary } from '../../src/platform/native-binary.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))

function fixture(t: import('node:test').TestContext, target: { os: string; arch: string }, badDownload = false, touchHost = false) {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-pack-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src', 'platform'), { recursive: true })
  for (const name of ['pack-native.js', 'pack-job-launcher.js', 'native-pack-paths.js', 'runtime-platform-filter.js']) cpSync(join(repo, 'scripts', name), join(root, 'scripts', name))
  cpSync(join(repo, 'src', 'platform', 'native-binary.ts'), join(root, 'src', 'platform', 'native-binary.ts'))
  writeFileSync(join(root, 'scripts', 'fetch-node-runtime.js'), 'export const DEFAULT_NODE_VERSION = "24.18.0"')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const pkg = join(root, 'node_modules', 'better-sqlite3')
  const hostModule = join(pkg, 'build', 'Release', 'better_sqlite3.node')
  const hostDist = join(root, 'dist', 'native', 'better_sqlite3.node')
  mkdirSync(join(pkg, 'build', 'Release'), { recursive: true })
  mkdirSync(join(root, 'dist', 'native'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), '{"name":"better-sqlite3","version":"12.10.0"}')
  const hostBytes = nativeHeader(process.platform, process.arch)
  writeFileSync(hostModule, hostBytes); writeFileSync(hostDist, hostBytes)
  const installer = join(root, 'node_modules', 'prebuild-install')
  mkdirSync(installer, { recursive: true })
  writeFileSync(join(installer, 'package.json'), '{"bin":"bin.cjs"}')
  const bytes = badDownload ? hostBytes : nativeHeader(target.os, target.arch)
  writeFileSync(join(installer, 'bin.cjs'), `
    const fs = require('fs'), path = require('path');
    if (process.cwd() === ${JSON.stringify(pkg)}) throw new Error('download touched host package');
    fs.mkdirSync('build/Release', {recursive:true});
    fs.writeFileSync('build/Release/better_sqlite3.node', Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'));
    ${touchHost ? `fs.appendFileSync(${JSON.stringify(hostDist)}, 'changed during download');` : ''}
  `)
  return { root, hostModule, hostDist, hostBytes, inode: statSync(hostDist).ino }
}

function pack(root: string, target: { os: string; arch: string }) {
  const triple = `${target.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${target.os === 'win32' ? 'pc-windows-msvc' : 'apple-darwin'}`
  return spawnSync(process.execPath, [join(root, 'scripts', 'pack-native.js')], {
    encoding: 'utf8', env: { ...process.env, TAURI_ENV_TARGET_TRIPLE: triple, PACK_NATIVE_SKIP_ABI_CHECK: '1' },
  })
}

for (const arch of ['x64', process.arch]) {
  const target = { os: process.platform === 'win32' ? 'darwin' : 'win32', arch }
  test(`cross pack ${target.os}-${arch} preserves host files and uses isolated downloader`, t => {
    const f = fixture(t, target)
    const result = pack(f.root, target)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assertNativeBinary(join(f.root, 'dist', 'native', `${target.os}-${arch}`, 'better_sqlite3.node'), target)
    for (const path of [f.hostModule, f.hostDist]) assert.deepEqual(readFileSync(path), f.hostBytes)
    assert.equal(statSync(f.hostDist).ino, f.inode)
  })
}

test('foreign/malformed download fails without overwriting a previously valid target', t => {
  const target = { os: process.platform === 'win32' ? 'darwin' : 'win32', arch: 'x64' }
  const f = fixture(t, target, true)
  const dir = join(f.root, 'dist', 'native', `${target.os}-${target.arch}`)
  mkdirSync(dir)
  const before = nativeHeader(target.os, target.arch)
  writeFileSync(join(dir, 'better_sqlite3.node'), before)
  const result = pack(f.root, target)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /expected .*received/)
  assert.deepEqual(readFileSync(join(dir, 'better_sqlite3.node')), before)
  for (const path of [f.hostModule, f.hostDist]) assert.deepEqual(readFileSync(path), f.hostBytes)
})

test('post-pack self-check rejects a host file changed during download', t => {
  const target = { os: process.platform === 'win32' ? 'darwin' : 'win32', arch: 'x64' }
  const f = fixture(t, target, false, true)
  const result = pack(f.root, target)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /宿主原生件被改写/)
})

test('cross Windows helper staging runs even when the optional SQLite source is absent', { skip: process.platform === 'win32' }, t => {
  const target = { os: 'win32', arch: 'x64' }
  const f = fixture(t, target)
  const sourceDir = join(f.root, 'native', 'win32-x64')
  mkdirSync(sourceDir, { recursive: true })
  const bytes = nativeHeader('win32', 'x64')
  writeFileSync(join(sourceDir, 'job-launch.exe'), bytes)
  rmSync(f.hostModule)
  const result = pack(f.root, target)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const staged = join(f.root, 'dist', 'native', 'win32-x64', 'job-launch.exe')
  assert.equal(existsSync(staged), true, 'pack-native must stage the required helper before its optional SQLite early return')
  assert.deepEqual(readFileSync(staged), bytes)
})
