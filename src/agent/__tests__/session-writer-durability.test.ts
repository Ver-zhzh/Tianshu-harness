import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBatchWriter } from '../session-batch-writer.js'
import { decodeTranscriptText, encodeBatch } from '../session-transcript-codec.js'

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'session-writer-durable-'))
  const path = join(dir, 'history.jsonl')
  fs.writeFileSync(path, encodeBatch('confirmed\n'))
  const writer = new SessionBatchWriter(path, () => dir)
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, path, writer }
}

for (const mode of ['sync', 'async'] as const) {
  test(`${mode} append failure preserves buffered records and retries a partial frame exactly once`, async t => {
    const { path, writer } = fixture(t)
    const failure = Object.assign(new Error('injected disk error'), { code: 'EIO' })
    if (mode === 'sync') {
      const original = fs.appendFileSync
      t.mock.method(fs, 'appendFileSync', (path: Parameters<typeof fs.appendFileSync>[0], bytes: Parameters<typeof fs.appendFileSync>[1]) => {
        if (typeof bytes === 'string') throw new Error('Expected an encoded frame')
        original(path, bytes.subarray(0, 9)); throw failure
      })
    } else {
      const original = fsp.appendFile
      t.mock.method(fsp, 'appendFile', async (path: Parameters<typeof fsp.appendFile>[0], bytes: Parameters<typeof fsp.appendFile>[1]) => {
        if (!Buffer.isBuffer(bytes)) throw new Error('Expected an encoded frame')
        await original(path, bytes.subarray(0, 9)); throw failure
      })
    }
    syncBuiltinESMExports()
    writer.enqueueLine('must-survive\n')
    if (mode === 'sync') assert.throws(() => writer.flushSync(), failure)
    else await assert.rejects(writer.flush(), failure)
    assert.match(writer.mergePending(''), /must-survive/)
    t.mock.restoreAll(); syncBuiltinESMExports()
    await writer.flush()
    assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\nmust-survive\n')
    await writer.flush()
    assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\nmust-survive\n')
  })
}

test('datasync failure after a complete append remains retryable without duplicating the frame', async t => {
  const { writer, path } = fixture(t)
  const internal = writer as unknown as { syncFileAsync(): Promise<void> }
  const original = internal.syncFileAsync.bind(writer)
  t.mock.method(internal, 'syncFileAsync', async () => { throw new Error('datasync failed') })
  writer.enqueueLine('pending-durability\n')
  await assert.rejects(writer.flush(), /datasync failed/)
  assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\npending-durability\n')
  internal.syncFileAsync = original
  await writer.flush()
  assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\npending-durability\n')
})

test('sync flush cannot overtake an asynchronous append and cannot consume its queued tail', async t => {
  const { writer, path } = fixture(t)
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const internal = writer as unknown as { syncFileAsync(): Promise<void> }
  const original = internal.syncFileAsync.bind(writer)
  t.mock.method(internal, 'syncFileAsync', async () => { started(); await gate; await original() })
  writer.enqueueLine('second\n')
  const flushing = writer.flush()
  try {
    await entered
    writer.enqueueLine('third\n')
    assert.throws(() => writer.flushSync(), { code: 'EBUSY' })
    assert.equal(writer.mergePending(''), 'third\n')
  } finally { release(); await flushing }
  assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\nsecond\nthird\n')
})

for (const withPrefix of [false, true]) {
  test(`every incomplete final-frame boundary is backed up before resuming (prefix=${withPrefix})`, async t => {
    const { dir, path } = fixture(t)
    const prefix = withPrefix ? encodeBatch('confirmed\n') : Buffer.alloc(0)
    const unfinished = encodeBatch('interrupted-tail\n')
    for (let cut = 1; cut < unfinished.length; cut++) {
      const torn = Buffer.concat([prefix, unfinished.subarray(0, cut)])
      fs.writeFileSync(path, torn)
      const before = new Set(fs.readdirSync(dir))
      const writer = new SessionBatchWriter(path, () => dir)
      writer.enqueueLine('continued\n')
      await writer.flush()
      assert.equal(decodeTranscriptText(fs.readFileSync(path)), `${withPrefix ? 'confirmed\n' : ''}continued\n`, `cut=${cut}`)
      const backup = fs.readdirSync(dir).find(name => !before.has(name) && name.includes('.torn-'))
      assert.ok(backup, `no evidence backup for cut=${cut}`)
      assert.deepEqual(fs.readFileSync(join(dir, backup)), torn)
    }
  })
}

test('middle checksum corruption and failed evidence backup never authorize deleting history', async t => {
  const { writer, path } = fixture(t)
  const corrupt = encodeBatch('confirmed\n'); corrupt[corrupt.length - 1]! ^= 1
  fs.writeFileSync(path, Buffer.concat([corrupt, encodeBatch('later-confirmed\n')]))
  const before = fs.readFileSync(path)
  writer.enqueueLine('new\n')
  await assert.rejects(writer.flush())
  assert.deepEqual(fs.readFileSync(path), before)
  assert.equal(writer.mergePending(''), 'new\n')
})

test('a failed tail backup leaves the original bytes intact and queued work recoverable', async t => {
  const { path, writer } = fixture(t)
  const torn = Buffer.concat([fs.readFileSync(path), encodeBatch('partial\n').subarray(0, 10)])
  fs.writeFileSync(path, torn)
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup blocked') }); syncBuiltinESMExports()
  writer.enqueueLine('new\n')
  await assert.rejects(writer.flush(), /backup blocked/)
  assert.deepEqual(fs.readFileSync(path), torn)
  t.mock.restoreAll(); syncBuiltinESMExports()
  await writer.flush()
  assert.equal(decodeTranscriptText(fs.readFileSync(path)), 'confirmed\nnew\n')
})

test('unrelated bytes appended after a failed write are never truncated on retry', async t => {
  const { writer, path } = fixture(t)
  const internal = writer as unknown as { syncFileAsync(): Promise<void> }
  t.mock.method(internal, 'syncFileAsync', async () => { throw new Error('sync failed') })
  writer.enqueueLine('owned\n')
  await assert.rejects(writer.flush())
  fs.appendFileSync(path, encodeBatch('unrelated\n'))
  const before = fs.readFileSync(path)
  await assert.rejects(writer.flush(), /unrelated history/)
  assert.deepEqual(fs.readFileSync(path), before)
})
