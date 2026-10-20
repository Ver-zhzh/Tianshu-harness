import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillDrafts } from '../skill-drafts.js'
import { SkillManagement } from '../skill-management.js'
import { runSkillsCLI } from '../../cli/skills-cli.js'
import { RepoLock } from '../../agent/repo-lock.js'

const document = (name = 'weekly', body = 'Follow the agreed steps.') => `---\nname: ${name}\ndescription: Use to prepare a weekly report.\n---\n${body}\n`
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'draft-contract-'))
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const management = new SkillManagement(join(root, 'home'), join(root, 'external'))
  return { cwd, management, drafts: new SkillDrafts(management), target: { scope: 'project' as const, cwd } }
}

test('all draft writes and approvals enforce the same identity and document completeness', () => {
  const f = fixture()
  for (const content of [document('other'), document('weekly', ''), document().replace('Use to prepare a weekly report.', ' '), 'Not YAML', document().replace('name: weekly\n', ''), document().replace('name: weekly', 'name: [invalid'), document().replace('name: weekly', 'name: 42')]) {
    assert.throws(() => f.drafts.save(f.target, 'weekly', content))
  }
  const dir = join(f.cwd, '.rivet', 'skills', '_drafts'); mkdirSync(dir, { recursive: true })
  const path = join(dir, 'weekly.md'); writeFileSync(path, document('other'))
  assert.throws(() => f.drafts.approve(f.target, 'weekly'), /name|名称/i)
  assert.equal(readFileSync(path, 'utf8'), document('other'))
  assert.equal(f.drafts.list(f.target)[0]!.name, 'weekly')
  const legacyVersion = f.drafts.list(f.target)[0]!.version
  const corrected = f.drafts.save(f.target, 'weekly', document(), legacyVersion)
  assert.equal(f.drafts.list(f.target)[0]!.error, undefined)
  f.drafts.reject(f.target, 'weekly', corrected.version)
  assert.equal(f.drafts.list(f.target).length, 0)
})

test('draft revisions prevent stale updates, approvals and rejection without losing edits', () => {
  const f = fixture()
  const original = f.drafts.save(f.target, 'weekly.md', document(), null)
  assert.equal(original.name, 'weekly')
  assert.match(original.version, /^[a-f0-9]{64}$/)
  assert.deepEqual(f.drafts.save(f.target, 'weekly', document(), null), original)
  assert.throws(() => f.drafts.save(f.target, 'weekly', document('weekly', 'new'), null), /changed|exists|conflict/i)
  assert.throws(() => f.drafts.save(f.target, 'weekly', document('weekly', 'new')), /changed|exists|conflict/i)
  const next = f.drafts.save(f.target, 'weekly', document('weekly', 'new'), original.version)
  assert.notEqual(next.version, original.version)
  assert.throws(() => f.drafts.save(f.target, 'weekly', document(), original.version), /changed|conflict/i)
  assert.throws(() => f.drafts.approve(f.target, 'weekly', original.version), /changed|conflict/i)
  assert.throws(() => f.drafts.reject(f.target, 'weekly', original.version), /changed|conflict/i)
  assert.equal(f.drafts.read(f.target, 'weekly'), document('weekly', 'new'))
  f.drafts.approve(f.target, 'weekly', next.version)
  assert.equal(f.drafts.list(f.target).length, 0)
  assert.ok(f.management.list(f.cwd).skills.some(s => s.name === 'weekly'))
})

test('another process holding the draft lock cannot race version validation and replacement', () => {
  const f = fixture(), saved = f.drafts.save(f.target, 'weekly', document(), null)
  const lock = new RepoLock({ lockPath: join(f.cwd, '.rivet/skills/_drafts/weekly.md.lock') })
  lock.withLock(() => {
    assert.throws(() => f.drafts.save(f.target, 'weekly', document('weekly', 'new'), saved.version), /lock|timed out/i)
    assert.equal(f.drafts.read(f.target, 'weekly'), document())
  })
})

test('CLI writes share validation, explicit revisions, scope isolation and installation conflicts', async () => {
  const f = fixture(), file = join(f.cwd, 'draft.md')
  const cli = (...args: string[]) => runSkillsCLI(args, { cwd: f.cwd, management: f.management })
  const save = (...args: string[]) => cli('draft', 'weekly', '--scope', 'project', '--file', file, '--json', ...args)
  writeFileSync(file, document('other')); assert.equal((await save()).exitCode, 1)
  writeFileSync(file, document()); const first = await save(); assert.equal(first.exitCode, 0)
  const version = JSON.parse(first.output).version
  writeFileSync(file, document('weekly', 'Updated reviewed steps.'))
  assert.equal((await save()).exitCode, 1)
  assert.equal((await save('--version', version)).exitCode, 0)
  assert.equal((await cli('approve', 'weekly', '--scope', 'project', '--version', version)).exitCode, 1)
  assert.equal(f.drafts.list({ scope: 'personal' }).length, 0)
  const latest = f.drafts.list(f.target)[0]!
  f.drafts.approve(f.target, 'weekly', latest.version)
  f.drafts.save(f.target, 'weekly', document(), null)
  assert.throws(() => f.drafts.approve(f.target, 'weekly'), /exists/)
  assert.equal(f.drafts.read(f.target, 'weekly'), document())
  const second = join(f.cwd, 'another'); mkdirSync(second)
  assert.equal(f.drafts.list({ scope: 'project', cwd: second }).length, 0)
})
