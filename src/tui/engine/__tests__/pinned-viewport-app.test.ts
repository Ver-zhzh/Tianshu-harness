import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp, liveMaxRowsFor } from '../app.js'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
import { NormalTerminal } from './_normal-terminal.js'
import { MockIn, makeApp, stripAnsi } from './_harness.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const copies = (text: string, needle: string) => text.split(needle).length - 1

test('classic physical screen plus scrollback contains one answer across redraw, next submit and history overlay', async t => {
  const terminal = new NormalTerminal(100, 24), stdin = new MockIn()
  const app = new TuiApp({ stdout: terminal as unknown as WriteStream, stdin: stdin as unknown as ReadStream, cols: 100, rows: 24, modelName: 'test' })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  t.after(() => app.dispose())
  app.start()
  const frames: LiveRegionLine[][] = []
  const render = LiveEngine.prototype.render
  t.mock.method(LiveEngine.prototype, 'render', function (this: LiveEngine, lines: readonly LiveRegionLine[], opts?: { reservedTail?: number }) {
    frames.push(lines.map(line => ({ ...line })))
    return render.call(this, lines, opts)
  })
  const sent: string[] = []
  app.onSubmit(text => sent.push(text))
  stdin.dataHandler!('first task\r')
  await settle()
  app.callbacks.onTextDelta('ANSWER_UNIQUE_中文正文\n\n')
  app.callbacks.onTextDelta('SECOND_PARAGRAPH_UNIQUE\n')
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await settle()
  app.commitStatic('TOOL_RESULT_UNIQUE')
  const check = () => {
    for (const marker of ['ANSWER_UNIQUE_中文正文', 'SECOND_PARAGRAPH_UNIQUE', 'TOOL_RESULT_UNIQUE']) {
      assert.equal(copies(terminal.text(), marker), 1, `${marker} must exist once in physical terminal, including native history`)
    }
  }
  check()
  app.setInput('editable draft')
  for (let i = 0; i < 5; i++) app.forceRedraw()
  check()
  assert.ok(!frames.at(-1)!.some(line => line.text.includes('ANSWER_UNIQUE')), 'committed content must never return to the classic live frame')
  assert.ok(frames.at(-1)!.length < terminal.rows, 'classic leaves terminal ownership with native scrollback')
  terminal.resize(100, 40); app.forceRedraw(); check()
  app.openUIHistory(); await settle()
  stdin.dataHandler!('\x1b'); await settle()
  check()
  stdin.dataHandler!('\r'); await settle()
  assert.deepEqual(sent, ['first task', 'editable draft'])
  check()
  app.setScreenReader(true); app.forceRedraw(); check()
  app.setScreenReader(false); app.forceRedraw(); check()
  assert.ok(frames.at(-1)!.length <= liveMaxRowsFor(40))
  app.restoreTerminalSync(); app.restoreTerminalSync(); check()
})

test('classic resize and clear preserve editable composer without projecting committed history', t => {
  const { app, out } = makeApp({ cols: 100, rows: 24 })
  t.after(() => app.dispose())
  app.commitStatic('PREVIOUS_OUTPUT_UNIQUE')
  const committed = app.getScrollbackContent()
  app.setInput('draft stays editable')
  for (const [columns, rows] of [[100, 48], [60, 12], [120, 30], [40, 7], [100, 24]]) {
    out.columns = columns!; out.rows = rows!; out.clear(); app.forceRedraw()
    assert.doesNotMatch(stripAnsi(out.chunks.join('')), /PREVIOUS_OUTPUT_UNIQUE/)
    assert.equal(app.getInputValue(), 'draft stays editable')
    assert.equal(app.getScrollbackContent(), committed)
  }
  app.clearScreen(); out.clear(); app.forceRedraw()
  assert.doesNotMatch(stripAnsi(out.chunks.join('')), /PREVIOUS_OUTPUT_UNIQUE/)
})
