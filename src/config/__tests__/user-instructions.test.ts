import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadUserInstructions } from '../user-instructions.js'
import { loadConfig } from '../manager.js'
import { trustProject, untrustProject, stripProjectSafetyKeys, detectProjectTrustStakes } from '../project-trust.js'
import { createUserInstructionsSnapshot, USER_INSTRUCTIONS_MAX_FILE_BYTES, UserInstructionsError } from '../../prompt/user-instructions.js'

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'user-instructions-config-'))
  const home = join(root, 'home'), project = join(root, 'project')
  mkdirSync(join(home, 'instructions'), { recursive: true }); mkdirSync(project)
  const config = join(home, 'config.json'), file = join(home, 'instructions', 'rules.md')
  const prior = { home: process.env.RIVET_HOME, config: process.env.RIVET_CONFIG_PATH }
  process.env.RIVET_HOME = home; process.env.RIVET_CONFIG_PATH = config
  t.after(() => {
    if (prior.home === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = prior.home
    if (prior.config === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = prior.config
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(config, '{}'); writeFileSync(file, 'NEVER delete archives.')
  return { root, home, project, config, file }
}

test('disabled rules never resolve or open their configured source', t => {
  fixture(t)
  assert.deepEqual(loadUserInstructions({ enabled: false, path: '/missing/source' }), { version: 1, state: 'disabled' })
  assert.deepEqual(loadUserInstructions(), { version: 1, state: 'disabled' })
})

test('BOM, CRLF and CR normalize to the same complete snapshot', t => {
  const { file, home } = fixture(t)
  writeFileSync(file, '\uFEFF first\r\nsecond\rthird \n')
  assert.deepEqual(loadUserInstructions({ enabled: true, path: file }), createUserInstructionsSnapshot('first\nsecond\nthird'))
  const other = join(home, 'instructions', 'other.txt')
  writeFileSync(other, 'first\nsecond\nthird')
  assert.deepEqual(loadUserInstructions({ enabled: true, path: other }), loadUserInstructions({ enabled: true, path: file }))
  writeFileSync(other, 'x' + ' '.repeat(USER_INSTRUCTIONS_MAX_FILE_BYTES - 1))
  assert.deepEqual(loadUserInstructions({ enabled: true, path: other }), createUserInstructionsSnapshot('x'))
})

test('invalid sources fail without leaking their path or contents', t => {
  const { root, home, file } = fixture(t)
  const outside = join(root, 'outside.md'); writeFileSync(outside, 'outside')
  const link = join(home, 'instructions', 'link.md'); symlinkSync(outside, link)
  for (const path of [undefined, 'relative.md', outside, link, join(home, 'instructions'), join(home, 'instructions', 'missing.md')]) {
    assert.throws(() => loadUserInstructions({ enabled: true, path }), error => {
      assert.ok(error instanceof UserInstructionsError)
      assert.ok(!error.message.includes(root))
      return true
    })
  }
  for (const text of [Buffer.from([0xff, 0xfe]), '\0bad', '   ', 'x'.repeat(USER_INSTRUCTIONS_MAX_FILE_BYTES + 1)]) {
    writeFileSync(file, text)
    assert.throws(() => loadUserInstructions({ enabled: true, path: file }), /user_instructions_source_invalid/)
  }
})

test('escaped expansion rejects the whole file including its final prohibition', t => {
  const { file } = fixture(t)
  writeFileSync(file, '&'.repeat(250) + '\nNEVER delete archives.')
  assert.throws(() => loadUserInstructions({ enabled: true, path: file }), /user_instructions_over_budget/)
})

test('canonical user home symlinks work while instruction-directory escapes fail', t => {
  const { root, home, file } = fixture(t)
  const alias = join(root, 'alias'); symlinkSync(home, alias, 'junction')
  process.env.RIVET_HOME = alias
  assert.equal(loadUserInstructions({ enabled: true, path: file }).state, 'active')
})

test('project, profile and session overlays cannot create, disable or replace user authority', t => {
  const { home, project, config, file } = fixture(t)
  mkdirSync(join(home, 'profiles'))
  writeFileSync(join(project, '.rivet-config.json'), JSON.stringify({ agent: { userInstructions: { enabled: true, path: '/project-rules' } } }))
  writeFileSync(join(home, 'profiles', 'rules-test.json'), JSON.stringify({ agent: { userInstructions: { enabled: true, path: '/profile-rules' } } }))
  assert.deepEqual(stripProjectSafetyKeys({ agent: { userInstructions: { enabled: true }, maxTurns: 20 } }), { agent: { maxTurns: 20 } })
  const stakes = detectProjectTrustStakes(project)
  assert.ok(stakes.ignoredSafetyKeys.includes('agent.userInstructions'))
  assert.ok(!stakes.sensitiveKeys.includes('agent.userInstructions'))
  const overlay = { agent: { userInstructions: { enabled: false, path: '/overlay-rules' } } }
  for (const trusted of [false, true]) {
    if (trusted) trustProject(project); else untrustProject(project)
    assert.equal(loadConfig({ cwd: project, profile: 'rules-test', sessionOverlay: overlay }).agent.userInstructions, undefined)
    writeFileSync(config, JSON.stringify({ agent: { userInstructions: { enabled: true, path: file } } }))
    assert.deepEqual(loadConfig({ cwd: project, profile: 'rules-test', sessionOverlay: overlay }).agent.userInstructions, { enabled: true, path: file })
    writeFileSync(config, '{}')
  }
})

test('a file growing after inspection is still read with a hard byte bound', t => {
  const { file } = fixture(t)
  const original = fs.readSync
  let first = true, requested = 0
  const read = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    if (first) { first = false; writeFileSync(file, 'x'.repeat(USER_INSTRUCTIONS_MAX_FILE_BYTES + 100)) }
    requested += typeof args[3] === 'number' ? args[3] : 0
    return Reflect.apply(original, fs, args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => loadUserInstructions({ enabled: true, path: file }), /source_invalid/)
    assert.ok(requested <= USER_INSTRUCTIONS_MAX_FILE_BYTES + 1)
  } finally { read.mock.restore(); syncBuiltinESMExports() }
})

test('the instructions directory itself cannot redirect into runtime data', t => {
  const { home, file } = fixture(t)
  renameSync(join(home, 'instructions'), join(home, 'sessions'))
  symlinkSync(join(home, 'sessions'), join(home, 'instructions'), 'junction')
  assert.throws(() => loadUserInstructions({ enabled: true, path: file }), /source_invalid/)
})
