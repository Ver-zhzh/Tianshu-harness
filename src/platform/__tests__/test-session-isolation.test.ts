import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { defaultRivetHome } from '../../config/paths.js'

const execute = promisify(execFile)
const persistModule = new URL('../../agent/session-persist.ts', import.meta.url).href
const pathsModule = new URL('../../config/paths.ts', import.meta.url).href
const managerModule = new URL('../../server/session-manager.ts', import.meta.url).href

test('direct node --test isolates inherited real roots before persistence imports; subprocesses inherit the isolated home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'direct-session-guard-'))
  try {
    const fixture = join(root, 'fixture.test.mjs')
    writeFileSync(fixture, `
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { SessionPersist } from ${JSON.stringify(persistModule)};
import { rivetHome } from ${JSON.stringify(pathsModule)};
test('isolated direct persistence', () => {
 const persist = new SessionPersist('direct-test', '/work');
 const child = execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',
  ${JSON.stringify(`import { rivetHome } from ${JSON.stringify(pathsModule)}; console.log(rivetHome());`)}], {encoding:'utf8',env:process.env});
 console.log('ISOLATION=' + JSON.stringify({home:rivetHome(),file:persist.getFilePath(),child:child.trim()}));
});`)
    const env: NodeJS.ProcessEnv = { ...process.env, RIVET_HOME: defaultRivetHome(), RIVET_SESSION_DIR: join(defaultRivetHome(), 'sessions'), RIVET_DESKTOP_SESSION_DIR: join(defaultRivetHome(), 'desktop/sessions') }
    delete env.NODE_TEST_CONTEXT
    const { stdout, stderr } = await execute(process.execPath, ['--import', 'tsx', '--test', fixture], {
      cwd: process.cwd(), env,
    })
    const match = /ISOLATION=(\{[^\n]+\})/.exec(stdout)
    assert.ok(match, stdout + stderr)
    const result = JSON.parse(match[1]!) as { home: string; file: string; child: string }
    const rel = relative(defaultRivetHome(), result.home)
    assert.ok(rel.startsWith('..') || isAbsolute(rel))
    assert.equal(result.child, result.home)
    assert.ok(result.file.startsWith(result.home))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('late real-root overrides fail at SessionPersist, skill snapshots and manager creation instead of being swallowed', async () => {
  const snapshotModule = new URL('../../skills/session-skill-snapshot.ts', import.meta.url).href
  const code = `
import { SessionPersist } from ${JSON.stringify(persistModule)};
import { RuntimeSessionManager } from ${JSON.stringify(managerModule)};
import { sessionSkillSnapshot } from ${JSON.stringify(snapshotModule)};
import { defaultRivetHome } from ${JSON.stringify(pathsModule)};
process.env.RIVET_SESSION_DIR = defaultRivetHome() + '/sessions';
const errors = [];
for (const fn of [() => new SessionPersist('guarded', '/work'),
 () => sessionSkillSnapshot('/work', 'guarded', undefined, {purpose:'execute'}),
 () => new RuntimeSessionManager({ now: () => 1 }).createSession({cwd:'/work'})]) {
 try {fn();errors.push('NOT_BLOCKED')} catch(e) {errors.push(e.code)}
}
console.log(JSON.stringify(errors));`
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } })
  assert.deepEqual(JSON.parse(stdout.trim()), Array(3).fill('RIVET_SESSION_STORAGE_BLOCKED'))
})
