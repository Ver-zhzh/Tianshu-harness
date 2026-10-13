import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'tianshu-rpc-defects-'))
const rpcPath = path.join(root, 'src/lsp/rpc.ts'), framingPath = path.join(root, 'src/lsp/rpc-framing.ts')
const testPath = path.join(root, 'src/lsp/__tests__/rpc.test.ts')
const absolutize = (source, filename) => source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, quote, ref) => `${prefix}${quote}${path.resolve(path.dirname(filename), ref)}${quote}`)
const cases = [
  { name: 'missing-body-cap', module: 'framing', anchor: '!Number.isSafeInteger(length) || length > MAX_LSP_MESSAGE_BYTES',
    replacement: 'false', assertion: 'rejects oversized and malformed Content-Length' },
  { name: 'missing-header-cap', module: 'framing', anchor: 'if (buffer.length - offset > MAX_LSP_HEADER_BYTES)',
    replacement: 'if (false)', assertion: 'bounds incomplete and complete oversized headers' },
  { name: 'header-counted-in-body-cap', module: 'framing', anchor: 'length > MAX_LSP_MESSAGE_BYTES',
    replacement: 'length + header.length + 4 > MAX_LSP_MESSAGE_BYTES', assertion: 'accepts a body exactly at the cap' },
  { name: 'coalesced-chunk-cap', module: 'framing', anchor: '    let offset = 0\n    while (offset < chunk.length)',
    replacement: "    if (chunk.length > MAX_LSP_MESSAGE_BYTES) throw new Error('buffer exceeded')\n    let offset = 0\n    while (offset < chunk.length)", assertion: 'accepts coalesced legal frames' },
  { name: 'utf8-roundtrip', module: 'rpc', anchor: 'decoder.push(chunk, message => {',
    replacement: "decoder.push(Buffer.from(chunk.toString('utf8')), message => {", assertion: 'preserves fragmented Unicode' },
  { name: 'requests-after-death', module: 'rpc', anchor: '      if (terminalError) return Promise.reject(terminalError)',
    replacement: '', assertion: 'rejects new requests immediately after transport failure' },
  { name: 'notifications-after-death', module: 'rpc', anchor: '      if (terminalError) return\n',
    replacement: '', assertion: 'rejects new requests immediately after transport failure' },
  { name: 'unrelated-listeners-removed', module: 'rpc', anchor: "readable.removeListener('data', onData)",
    replacement: "readable.removeAllListeners('data')", assertion: 'read/write errors, close and dispose remain terminal' },
]
try {
  const rpc = await readFile(rpcPath, 'utf8'), framing = await readFile(framingPath, 'utf8'), test = await readFile(testPath, 'utf8')
  for (const defect of cases) {
    const original = defect.module === 'rpc' ? rpc : framing
    assert.ok(original.includes(defect.anchor), `${defect.name}: mutation anchor missing`)
    const changed = original.replace(defect.anchor, defect.replacement)
    const rpcCopy = path.join(isolated, 'rpc.ts'), framingCopy = path.join(isolated, 'framing.ts'), testCopy = path.join(isolated, 'rpc.test.ts')
    await writeFile(framingCopy, absolutize(defect.module === 'framing' ? changed : framing, framingPath))
    await writeFile(rpcCopy, absolutize(defect.module === 'rpc' ? changed : rpc, rpcPath).replaceAll(path.join(root, 'src/lsp/rpc-framing.js'), framingCopy))
    await writeFile(testCopy, absolutize(test, testPath).replaceAll(path.join(root, 'src/lsp/rpc.js'), rpcCopy))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', defect.assertion, testCopy],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    const log = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${defect.name} must fail`)
    assert.match(log, /AssertionError/, `${defect.name} must fail behavior rather than imports`)
    assert.ok(log.includes(defect.assertion), log)
    console.log(`${defect.name}: restored defect is red`)
  }
} finally { await rm(isolated, { recursive: true, force: true }) }
