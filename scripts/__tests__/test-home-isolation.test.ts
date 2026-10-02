import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sessionsDir } from '../../src/config/paths.js'

if (process.env.RIVET_TEST_HOME_PROBE === '1') {
  test('probe runner home', () => {
    assert.ok(process.env.RIVET_HOME)
    assert.deepEqual(readdirSync(process.env.RIVET_HOME), [])
    assert.ok(sessionsDir().startsWith(join(process.env.RIVET_HOME, 'sessions')), 'sessions must stay in this runner home')
    console.log(`TEST_HOME:${process.env.RIVET_HOME}`)
    console.log(`BASE_HOME:${process.env.HOME ?? '<unset>'}`)
  })
} else {
  test('concurrent project test runners never share or clear each other\'s home', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-runner-isolation-'))
    const execute = promisify(execFile)
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root,
      RIVET_SESSION_DIR: join(root, 'inherited-session-directory'), RIVET_TEST_HOME_PROBE: '1' }
    delete env.NODE_TEST_CONTEXT
    const cwd = fileURLToPath(new URL('../../', import.meta.url))
    try {
      const runs = await Promise.all([1, 2].map(() => execute(process.execPath,
        ['--import', 'tsx', 'scripts/run-node-tests.ts', 'test-home-isolation.test.ts'],
        { cwd, env, timeout: 20_000, encoding: 'utf8', windowsHide: true })))
      const homes = runs.map(run => run.stdout.match(/TEST_HOME:([^\r\n]+)/)?.[1])
      assert.ok(homes.every(Boolean), 'both actual runners must execute the probe')
      assert.notEqual(homes[0], homes[1], 'parallel runners must receive distinct storage')
      assert.ok(homes.every(home => !existsSync(home!)), 'each runner must reclaim only its own temporary home')
      assert.ok(runs.every(run => run.stdout.includes(`BASE_HOME:${process.env.HOME ?? '<unset>'}`)), 'HOME remains unchanged')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
