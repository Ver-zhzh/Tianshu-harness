import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseImagePathPaste } from '../image-paste.js'

test('unquoted relative image paths with spaces are attachments only when the file exists', () => {
  const cwd = process.cwd()
  const fixture = mkdtempSync(join(tmpdir(), 'rivet-relative-image-'))
  try {
    mkdirSync(join(fixture, 'assets'))
    writeFileSync(join(fixture, 'assets', 'My Shot.png'), '')
    writeFileSync(join(fixture, '截图 一.png'), '')
    process.chdir(fixture)
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      assert.deepEqual(parseImagePathPaste('assets/My Shot.png', platform), ['assets/My Shot.png'])
      assert.deepEqual(parseImagePathPaste('截图 一.png', platform), ['截图 一.png'])
      assert.deepEqual(parseImagePathPaste('assets/My Shot.png\n截图 一.png', platform), ['assets/My Shot.png', '截图 一.png'])
      assert.equal(parseImagePathPaste('看这张 assets/My Shot.png', platform), null)
      assert.equal(parseImagePathPaste('看这张 截图 一.png', platform), null)
      assert.equal(parseImagePathPaste('assets/My Shot.png\n请解释它', platform), null)
    }
  } finally {
    process.chdir(cwd)
    rmSync(fixture, { recursive: true, force: true })
  }
})

for (const [text, expected] of [
  ['/tmp/My Shot.png', ['/tmp/My Shot.png']],
  ["/tmp/a'b.png", ["/tmp/a'b.png"]],
  ["/tmp/a'b'c.png", ["/tmp/a'b'c.png"]],
  ['/tmp/a"b"c.png', ['/tmp/a"b"c.png']],
  ["/tmp/a'b c'd.png", ["/tmp/a'b c'd.png"]],
  ['/tmp/one.png\n/tmp/My Shot.png', ['/tmp/one.png', '/tmp/My Shot.png']],
  [String.raw`C:\O'Brien\My Shot.png`, [String.raw`C:\O'Brien\My Shot.png`]],
  [String.raw`\\server\O'Brien\My Shot.png`, [String.raw`\\server\O'Brien\My Shot.png`]],
  [String.raw`/Users/me/中文\ 截图\(一\).png`, ['/Users/me/中文 截图(一).png']],
  [String.raw`/tmp/a\'b.png /tmp/c\"d.jpg`, ["/tmp/a'b.png", '/tmp/c"d.jpg']],
  ['"/tmp/First Shot.png" "/tmp/Second Shot.jpg"', ['/tmp/First Shot.png', '/tmp/Second Shot.jpg']],
  [String.raw`/tmp/First\ Shot.png /tmp/Second\ Shot.jpg`, ['/tmp/First Shot.png', '/tmp/Second Shot.jpg']],
  [String.raw`'/tmp/a'"'"'b.png'`, ["/tmp/a'b.png"]],
] as const) {
  test(`POSIX image paste: ${text}`, () => assert.deepEqual(parseImagePathPaste(text, 'darwin'), expected))
}

for (const [text, expected] of [
  [String.raw`C:\Users\me\My Shot(一).png`, [String.raw`C:\Users\me\My Shot(一).png`]],
  [String.raw`"C:\My Shots\a.png" "D:\截图\b.jpg"`, [String.raw`C:\My Shots\a.png`, String.raw`D:\截图\b.jpg`]],
  [String.raw`"\\server\share\My Shot.png"`, [String.raw`\\server\share\My Shot.png`]],
  [String.raw`"C:\folder\a.png"`, [String.raw`C:\folder\a.png`]],
] as const) {
  test(`Windows image paste preserves separators: ${text}`, () => assert.deepEqual(parseImagePathPaste(text, 'win32'), expected))
  test(`foreign Windows paste on macOS: ${text}`, () => assert.deepEqual(parseImagePathPaste(text, 'darwin'), expected))
}

for (const text of ['看这张 /tmp/a.png', '"/tmp/a.png" 说明', '/tmp/a.png\n说明', '"/tmp/a.png', '/tmp/a.png /tmp/no.txt']) {
  test(`mixed or malformed paste remains text: ${text}`, () => assert.equal(parseImagePathPaste(text, 'darwin'), null))
}
