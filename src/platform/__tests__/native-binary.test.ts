import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectNativeBinary, assertNativeBinary } from '../native-binary.js'
import { nativeHeader } from './native-binary-fixtures.js'

function binary(t: import('node:test').TestContext, bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-native-header-'))
  const path = join(root, 'binary.node')
  writeFileSync(path, bytes)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return path
}

for (const [os, format] of [['darwin', 'Mach-O'], ['win32', 'PE'], ['linux', 'ELF']]) {
  for (const arch of ['arm64', 'x64']) {
    test(`accepts ${format} ${arch}, rejects wrong OS and architecture`, t => {
      const path = binary(t, nativeHeader(os!, arch))
      assert.deepEqual(assertNativeBinary(path, { os: os!, arch }), { format, architectures: [arch] })
      assert.throws(() => assertNativeBinary(path, { os: os!, arch: arch === 'x64' ? 'arm64' : 'x64' }), { code: 'ENATIVE_BINARY_MISMATCH' })
      assert.throws(() => assertNativeBinary(path, { os: os === 'darwin' ? 'win32' : 'darwin', arch }), /重新构建/)
    })
  }
}

test('accepts universal Mach-O containing the requested slice', t => {
  const buffer = Buffer.alloc(48)
  buffer.writeUInt32BE(0xcafebabe, 0); buffer.writeUInt32BE(2, 4)
  buffer.writeUInt32BE(0x01000007, 8); buffer.writeUInt32BE(0x0100000c, 28)
  const path = binary(t, buffer)
  for (const arch of ['x64', 'arm64']) assertNativeBinary(path, { os: 'darwin', arch })
})

for (const bytes of [Buffer.alloc(0), Buffer.from('MZ'), Buffer.alloc(64), (() => {
  const header = nativeHeader('win32', 'x64'); header.writeUInt32LE(0xffffffff, 0x3c); return header
})()]) {
  test(`rejects malformed/truncated header (${bytes.length} bytes)`, t => {
    const path = binary(t, bytes)
    assert.equal(inspectNativeBinary(path).format, 'unknown')
    assert.throws(() => assertNativeBinary(path), { code: 'ENATIVE_BINARY_MISMATCH' })
  })
}
