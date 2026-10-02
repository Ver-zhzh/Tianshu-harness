import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream } from 'node:tty'
import { InputHandler } from '../input-handler.js'
import { InputLine } from '../input-line.js'

test('suspension releases stdin and disposal cannot restart it', () => {
  const stdin = new PassThrough()
  const handler = new InputHandler({ stdin: stdin as unknown as ReadStream })
  try {
    assert.equal(stdin.readableFlowing, true)
    handler.setSuspended(true)
    assert.equal(stdin.readableFlowing, false, 'editor must own stdin')
    handler.setSuspended(false)
    assert.equal(stdin.readableFlowing, true)
    handler.dispose()
    handler.setSuspended(false)
    assert.equal(stdin.readableFlowing, false, 'late callbacks must not reacquire stdin')
  } finally { handler.dispose(); stdin.destroy() }
})

test('suspension discards partial keyboard/paste state before editor handoff', async () => {
  const stdin = new PassThrough()
  const handler = new InputHandler({ stdin: stdin as unknown as ReadStream, escapeTimeoutMs: 10 })
  const input = new InputLine()
  handler.onAnyKey(key => input.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift))
  try {
    stdin.emit('data', '\x1b')
    handler.setSuspended(true)
    await delay(25)
    handler.setSuspended(false)
    stdin.emit('data', 'x')
    assert.equal(input.value, 'x', 'stale ESC must not turn the next key into Meta')
    stdin.emit('data', '\x1b[200~unfinished')
    handler.setSuspended(true)
    handler.setSuspended(false)
    stdin.emit('data', 'y')
    assert.equal(input.value, 'xy', 'stale paste must not swallow new input')
  } finally { handler.dispose(); stdin.destroy() }
})

for (const remainder of ['x', '\x1b[200~unfinished', '\x1b[200~done\x1b[201~', '\x1b']) {
  test(`handoff stops the current input chunk: ${JSON.stringify(remainder)}`, () => {
    const stdin = new PassThrough()
    const handler = new InputHandler({ stdin: stdin as unknown as ReadStream })
    const input = new InputLine()
    handler.onAnyKey(key => {
      if (key.name === 'ctrl_g') handler.setSuspended(true)
      else input.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift)
    })
    handler.onPaste(text => input.insertText(text))
    try {
      stdin.emit('data', '\x07' + remainder)
      assert.equal(input.value, '', 'the editor owns the remainder of the chunk')
      handler.setSuspended(false)
      stdin.emit('data', 'y')
      assert.equal(input.value, 'y', 'resumed input must not be swallowed by a stale paste')
    } finally { handler.dispose(); stdin.destroy() }
  })
}

for (const [sequence, value, cursor] of [
  ['\x1b\x7f', 'hello ', 6],
  ['\x1b\x08', 'hello ', 6],
  ['\x1bb', 'hello world', 6],
  ['\x1b[98;3u', 'hello world', 6],
  ['\x1b[127;3u', 'hello ', 6],
] as const) {
  for (const split of [false, true]) {
    test(`word editing through terminal parser: ${JSON.stringify(sequence)} split=${split}`, () => {
      const stdin = new PassThrough()
      const handler = new InputHandler({ stdin: stdin as unknown as ReadStream })
      const input = new InputLine({ value: 'hello world' })
      handler.onAnyKey(key => input.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift))
      try {
        if (split) { stdin.emit('data', sequence.slice(0, 1)); stdin.emit('data', sequence.slice(1)) }
        else stdin.emit('data', sequence)
        assert.equal(input.value, value)
        assert.equal(input.cursor, cursor)
      } finally { handler.dispose(); stdin.destroy() }
    })
  }
}

test('legacy and CSI-u Meta+f move forward without inserting characters', () => {
  for (const sequence of ['\x1bf', '\x1b[102;3u']) {
    const stdin = new PassThrough()
    const handler = new InputHandler({ stdin: stdin as unknown as ReadStream })
    const input = new InputLine({ value: 'hello world' })
    input.handleKey('home', '', false, false)
    handler.onAnyKey(key => input.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift))
    try {
      stdin.emit('data', sequence)
      assert.equal(input.cursor, 5)
      assert.equal(input.value, 'hello world')
    } finally { handler.dispose(); stdin.destroy() }
  }
})

test('legacy Meta Unicode is one modified key and never leaves half a surrogate in the draft', () => {
  const stdin = new PassThrough()
  const handler = new InputHandler({ stdin: stdin as unknown as ReadStream })
  const input = new InputLine()
  handler.onAnyKey(key => input.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift))
  try {
    stdin.emit('data', '\x1b🎉')
    assert.equal(input.value, '')
  } finally { handler.dispose(); stdin.destroy() }
})
