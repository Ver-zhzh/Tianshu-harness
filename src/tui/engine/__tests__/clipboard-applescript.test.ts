import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryShellClipboard } from '../clipboard-image.js'

test('macOS clipboard file literals roundtrip unusual temporary paths', { skip: process.platform !== 'darwin' }, async () => {
  const compileDir = mkdtempSync(join(tmpdir(), 'rivet-script-compile-'))
  const directory = '/private/tmp/中文"quote\\slash\nnext'
  let checked = false
  let failure: unknown
  try {
    const result = await tryShellClipboard({
      platform: 'darwin', tmpdir: directory, randomUUID: () => 'fixture',
      execFile: async (bin, args) => {
        try {
        assert.equal(bin, 'osascript')
        const script = args[1]!
        execFileSync('osacompile', ['-o', join(compileDir, 'clipboard.scpt'), '-e', script], { stdio: 'pipe' })
        const paths = [...script.matchAll(/set filePath to (POSIX file .* as text)/g)]
        assert.equal(paths.length, 3)
        for (const [index, match] of paths.entries()) {
          const evaluated = execFileSync('osascript', ['-e', `return POSIX path of (${match[1]})`], { encoding: 'utf8' }).trimEnd()
          assert.equal(evaluated, `${directory}/rivet-clip-fixture.${['png', 'tiff', 'jpg'][index]}`)
        }
        checked = true
        return { stdout: 'none' }
        } catch (error) { failure = error; throw error }
      },
    })
    // Production catches script failures, so the callback must complete for the assertion to hold.
    assert.equal(result, null)
    assert.ifError(failure)
    assert.ok(checked, 'all generated file literals must compile and roundtrip')
  } finally { rmSync(compileDir, { recursive: true, force: true }) }
})
