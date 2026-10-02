import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { copyTextToClipboard } from '../clipboard-text.js'

test('timed-out native writer cannot overwrite a later clipboard request', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-copy-process-'))
  const bin = join(root, 'bin'), store = join(root, 'clipboard'), events = join(root, 'events')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pbcopy'), `#!${process.execPath}
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(events)}, 'ignored\\n'));
    let text = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => text += chunk);
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(events)}, text + ':start\\n');
      const write = () => { fs.writeFileSync(${JSON.stringify(store)}, text); fs.appendFileSync(${JSON.stringify(events)}, text + ':end\\n'); };
      if (text === 'old') setTimeout(write, 3000); else write();
    });`, { mode: 0o700 })
  const oldPath = process.env.PATH
  process.env.PATH = bin + delimiter + (oldPath ?? '')
  try {
    const terminal: string[] = []
    const options = { platform: 'darwin' as const, env: {} }
    const old = copyTextToClipboard('old', seq => terminal.push(seq), options)
    const next = copyTextToClipboard('new', seq => terminal.push(seq), options)
    assert.deepEqual(await Promise.all([old, next]), ['terminal', 'native'])
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(readFileSync(store, 'utf8'), 'new', 'late old process must be gone')
    assert.equal(readFileSync(events, 'utf8'), 'old:start\nnew:start\nnew:end\n')
    assert.equal(terminal.length, 1)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows clipboard script preserves Unicode stdin and never embeds user text', async () => {
  const text = '中文 🎉\n";$env:PATH;`unsafe`'
  const result = await copyTextToClipboard(text, () => assert.fail('native succeeded'), {
    platform: 'win32', env: {}, run: async (bin, args, input) => {
      assert.equal(bin, 'powershell.exe')
      assert.equal(input, text)
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const script = Buffer.from(args[3]!, 'base64').toString('utf16le')
      assert.ok(script.includes('[Console]::In.ReadToEnd()'))
      assert.ok(script.includes('Text.UTF8Encoding'))
      assert.ok(!script.includes(text))
      return true
    },
  })
  assert.equal(result, 'native')
})

test('cancelled clipboard owner does not cancel another owner queued behind it', async () => {
  const owner = new AbortController()
  let release!: (copied: boolean) => void
  let started = false
  const old = copyTextToClipboard('old', () => assert.fail('cancelled copy must not fall back'), {
    platform: 'darwin', env: {}, signal: owner.signal,
    run: async () => { started = true; return new Promise(resolve => { release = resolve }) },
  })
  const next = copyTextToClipboard('new', () => assert.fail('native succeeded'), {
    platform: 'darwin', env: {}, run: async () => true,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, true)
  owner.abort()
  release(false)
  assert.deepEqual(await Promise.all([old, next]), ['cancelled', 'native'])
})
