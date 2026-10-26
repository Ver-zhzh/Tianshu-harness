import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'

test('a failed npm test retains its cause in the model result and raw recovery', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bash-failed-summary-'))
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:desktop': 'node runner.cjs' } }))
    writeFileSync(join(cwd, 'runner.cjs'), `
      for (let i = 0; i < 20; i++) console.log('✔ case ' + i);
      console.log('ℹ pass 212\\nℹ fail 0\\nℹ skipped 0\\nℹ todo 0');
      console.error('cleanup terminated by signal SIGTERM');
      process.exitCode = 1;
    `)
    const result = await BASH_TOOL.execute({ cwd, toolUseId: 'failed-summary', input: { command: 'npm run test:desktop' } })
    assert.equal(result.exitCode, 1)
    assert.match(result.content, /cleanup terminated by signal SIGTERM/, 'the final model-visible body must explain the failure')
    assert.ok(result.rawPath)
    assert.match(readFileSync(result.rawPath, 'utf8'), /cleanup terminated by signal SIGTERM/)
    assert.match(readFileSync(result.rawPath, 'utf8'), /ℹ pass 212/, 'raw recovery retains the unfiltered output')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
