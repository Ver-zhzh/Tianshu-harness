import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockIn, MockOut } from './_harness.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
import { setClipboardReader } from '../clipboard-image.js'

for (const cleanup of ['dispose', 'restoreTerminalSync'] as const) {
  test(`editor returning after ${cleanup} cannot change the draft or terminal`, { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-editor-lifecycle-'))
    const ready = join(root, 'ready'), release = join(root, 'release')
    const script = join(root, 'editor.mjs')
    writeFileSync(script, `import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(release)})) {
          writeFileSync(process.argv.at(-1), 'edited'); clearInterval(timer);
        }
      }, 10); setTimeout(() => process.exit(9), 8000).unref();`)
    const oldVisual = process.env.VISUAL
    process.env.VISUAL = `"${process.execPath}" "${script}"`
    const stdin = new MockIn(), out = new MockOut(), modes: boolean[] = []
    stdin.setRawMode = ((raw: boolean) => { modes.push(raw); return stdin }) as typeof stdin.setRawMode
    const app = new TuiApp({ stdin: stdin as unknown as ReadStream, stdout: out as unknown as WriteStream, cols: 80, rows: 24 })
    app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
    app.start(); app.setInput('original')
    let pending: Promise<void> | undefined
    try {
      pending = (app as unknown as { openDraftEditor(): Promise<void> }).openDraftEditor()
      const deadline = Date.now() + 6000
      while (!existsSync(ready) && Date.now() < deadline) await delay(10)
      assert.ok(existsSync(ready), 'actual asynchronous editor must launch')
      app[cleanup]()
      const outputBoundary = out.chunks.length, rawBoundary = modes.length
      writeFileSync(release, 'return')
      await pending
      assert.equal(app.getInputValue(), 'original', 'late editor must not resurrect the draft')
      assert.equal(out.chunks.slice(outputBoundary).join(''), '', 'no writes after terminal restoration')
      assert.ok(!modes.slice(rawBoundary).includes(true), 'raw mode must stay disabled')
    } finally {
      writeFileSync(release, 'return')
      await pending
      app.dispose()
      if (oldVisual === undefined) delete process.env.VISUAL
      else process.env.VISUAL = oldVisual
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('clipboard read started before editor handoff cannot modify the edited draft after return', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-editor-paste-'))
  const script = join(root, 'editor.mjs')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv.at(-1), 'edited');`)
  const oldVisual = process.env.VISUAL
  process.env.VISUAL = `"${process.execPath}" "${script}"`
  const stdin = new MockIn(), out = new MockOut()
  const app = new TuiApp({ stdin: stdin as unknown as ReadStream, stdout: out as unknown as WriteStream, cols: 80, rows: 24 })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.start(); app.setInput('original')
  let release!: (text: string | null) => void
  let started = false
  const read = new Promise<string | null>(resolve => { release = resolve })
  setClipboardReader({ readImage: async () => null, readText: async () => { started = true; return read } })
  ;(app as any).lastInputFocusAt = Date.now() - 2000
  let paste: Promise<void> | undefined
  try {
    paste = (app as any).handleCtrlV()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(started, true)
    await (app as any).openDraftEditor()
    assert.equal(app.getInputValue(), 'edited', 'the actual editor must return its draft')
    release('late text')
    await paste
    assert.equal(app.getInputValue(), 'edited', 'the old read belongs to the previous input handoff')
  } finally {
    release(null); await paste
    setClipboardReader(null); app.dispose()
    if (oldVisual === undefined) delete process.env.VISUAL
    else process.env.VISUAL = oldVisual
    rmSync(root, { recursive: true, force: true })
  }
})

test('emoji and combining characters belong to the active search, including backspace', () => {
  const stdin = new MockIn(), out = new MockOut()
  const app = new TuiApp({ stdin: stdin as unknown as ReadStream, stdout: out as unknown as WriteStream, cols: 80, rows: 24 })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.start(); app.setInput('keep draft')
  app.registerOverlays({ paletteCommands: () => ({ commands: [], selectedIndex: 0 }) })
  try {
    app.activateOverlay('command-palette')
    stdin.dataHandler!('中🎉e\u0301')
    assert.equal(app.getOverlayQuery(), '中🎉e\u0301')
    assert.equal(app.getInputValue(), 'keep draft')
    stdin.dataHandler!('\x7f')
    assert.equal(app.getOverlayQuery(), '中🎉')
    stdin.dataHandler!('\x7f')
    assert.equal(app.getOverlayQuery(), '中')
  } finally { app.dispose() }
})
