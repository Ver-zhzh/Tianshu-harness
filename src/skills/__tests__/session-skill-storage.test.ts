import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SkillManagement } from '../skill-management.js'
import { readPackage } from '../skill-package.js'
import { sessionSkillSnapshot, parseSkillSnapshot, upgradeSkillSnapshot } from '../session-skill-snapshot.js'
import { SkillVersionStore } from '../skill-version-store.js'
import { SKILL_TOOL } from '../../tools/skill.js'
import type { ToolCallParams } from '../../tools/types.js'
import { resolveAppPromptInput } from '../../tui/prompt-input-resolver.js'
import { deleteSessionFiles } from '../../agent/session-persist.js'
import { migrateSessionFiles } from '../../agent/session-cd.js'
import type { SkillRegistry } from '../skill-loader.js'
import { runSkillsCLI } from '../../cli/skills-cli.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-storage-')), cwd = join(root, 'project'), sessions = join(root, 'sessions')
  const previous = { session: process.env.RIVET_SESSION_DIR, home: process.env.RIVET_HOME, trust: process.env.RIVET_TRUST_PROJECT }
  process.env.RIVET_SESSION_DIR = sessions; process.env.RIVET_HOME = join(root, 'home'); process.env.RIVET_TRUST_PROJECT = '1'
  const management = new SkillManagement(join(root, 'home'), join(root, 'external'))
  const source = join(cwd, '.rivet/skills/probe')
  mkdirSync(join(source, 'references'), { recursive: true }); mkdirSync(join(source, 'scripts')); mkdirSync(join(root, 'external'))
  writeFileSync(join(source, 'SKILL.md'), '---\nname: probe\ndescription: Test resources\n---\nRead [guide](references/guide.pdf).')
  writeFileSync(join(source, 'references/guide.pdf'), Buffer.alloc(64 * 1024, 42))
  writeFileSync(join(source, 'scripts/run.py'), 'print("pinned")', { mode: 0o755 })
  const dormant = join(cwd, '.rivet/skills/dormant')
  mkdirSync(dormant); writeFileSync(join(dormant, 'SKILL.md'), '---\nname: dormant\ndescription: Not used\n---\nBody')
  writeFileSync(join(dormant, 'notes.md'), 'dormant resource')
  const snapshot = (id: string) => sessionSkillSnapshot(cwd, id, management, { purpose: 'execute' })
  const manifest = (id: string) => JSON.parse(readFileSync(join(sessions, id + '.skills.json'), 'utf8'))
  return { root, cwd, sessions, source, management, snapshot, manifest, store: new SkillVersionStore(), cleanup() {
    for (const [key, value] of [['RIVET_SESSION_DIR', previous.session], ['RIVET_HOME', previous.home], ['RIVET_TRUST_PROJECT', previous.trust]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    rmSync(root, { recursive: true, force: true })
  } }
}
const activate = (registry: SkillRegistry, cwd: string) => SKILL_TOOL.execute({ input: { name: 'probe' }, skillRegistry: registry, cwd, toolUseId: 'storage-test' } as ToolCallParams)

test('new cache files never change the version; scripts, PDFs and hidden resources remain pinned', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.source, '.notes'), 'keep')
    const before = readPackage(f.source)
    mkdirSync(join(f.source, '__pycache__'))
    writeFileSync(join(f.source, '__pycache__/example.pyc'), 'cache')
    writeFileSync(join(f.source, 'scripts/standalone.pyc'), 'cache')
    const after = readPackage(f.source)
    assert.equal(after.fingerprint, before.fingerprint)
    assert.deepEqual(after.files, before.files)
    assert.ok(after.files.some(file => file.path === '.notes'))
    writeFileSync(join(f.source, 'scripts/run.py'), 'print("changed")')
    assert.notEqual(readPackage(f.source).fingerprint, before.fingerprint)
  } finally { f.cleanup() }
})

test('N main/worker snapshots share binary packages, with no inline bytes or eager directories', () => {
  const f = fixture()
  try {
    const ids = ['a', 'b', 'worker-batch-0-nonce', 'worker-batch-1-nonce']
    const refs = []
    for (const id of ids) {
      const registry = f.snapshot(id), manifest = f.manifest(id)
      registry.renderDiscoveryBlock()
      assert.equal(manifest.v, 2)
      assert.equal(existsSync(join(f.sessions, id, 'skills')), false)
      assert.ok(manifest.skills.every((s: object) => !('resources' in s)))
      assert.ok(readFileSync(join(f.sessions, id + '.skills.json')).length < 16 * 1024)
      assert.equal('resources' in registry.get('probe')!, false)
      refs.push(manifest.skills.find((s: { name: string }) => s.name === 'probe').packageRef)
    }
    assert.equal(new Set(refs).size, 1)
    const versions = readdirSync(f.store.root).filter(p => /^[a-f0-9]{64}$/.test(p))
    assert.equal(versions.length, 2, 'one package for each distinct skill, not each session')
    const resources = f.store.export(refs[0])
    assert.equal(Buffer.from(resources.find(p => p.path === 'references/guide.pdf')!.data, 'base64').length, 65536)
    assert.equal(existsSync(join(f.store.root, refs[0], 'files/references/guide.pdf')), true)
  } finally { f.cleanup() }
})

test('catalog and snapshot use one source read for the same resource bytes and version', () => {
  const f = fixture(), originalRead = fs.readFileSync
  let sourceReads = 0
  const patched = mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === join(f.source, 'scripts/run.py')) sourceReads++
    return originalRead(...args)
  })
  syncBuiltinESMExports()
  try {
    const registry = f.snapshot('one-read')
    assert.equal(sourceReads, 1)
    assert.equal(registry.get('probe')!.version, readPackage(f.source).fingerprint)
  } finally { patched.mock.restore(); syncBuiltinESMExports(); f.cleanup() }
})

test('a catalog for a new session persists pinned bytes only on actual activation', async () => {
  const f = fixture()
  try {
    const registry = sessionSkillSnapshot(f.cwd, 'catalog-new', f.management, { purpose: 'catalog' })
    assert.equal(existsSync(join(f.sessions, 'catalog-new.skills.json')), false)
    assert.equal(existsSync(f.store.root), false)
    writeFileSync(join(f.source, 'scripts/run.py'), 'changed after catalog')
    await activate(registry, f.cwd)
    assert.equal(f.manifest('catalog-new').v, 2)
    assert.equal(readFileSync(join(registry.get('probe')!.skillDir!, 'scripts/run.py'), 'utf8'), 'print("pinned")')
    assert.equal(f.snapshot('catalog-new').get('probe')!.version, registry.get('probe')!.version)
  } finally { f.cleanup() }
})

test('skill tool materializes only the invoked package; source changes and uninstall cannot change pinned bytes', async () => {
  const f = fixture()
  try {
    const a = f.snapshot('a'), original = f.manifest('a')
    writeFileSync(join(f.source, 'references/guide.pdf'), 'new resource')
    writeFileSync(join(f.source, 'SKILL.md'), '---\nname: probe\ndescription: New\n---\nNew body')
    const b = f.snapshot('b')
    assert.notEqual(b.get('probe')!.version, a.get('probe')!.version)
    rmSync(f.source, { recursive: true })
    const result = await activate(a, f.cwd)
    assert.match(result.content, /skill-files/)
    assert.match(result.content, /Read/)
    assert.deepEqual(readFileSync(join(a.get('probe')!.skillDir!, 'references/guide.pdf')), Buffer.alloc(65536, 42))
    assert.equal(existsSync(a.get('dormant')!.skillDir!), false)
    assert.deepEqual(f.manifest('a'), original)
    f.management.setMode(f.management.list(f.cwd).skills.find(s => s.name === 'dormant')!.skillId, 'off', f.cwd)
    assert.equal(f.snapshot('a').get('dormant')!.mode, 'auto')
  } finally { f.cleanup() }
})

test('slash, bare name and compact reinjection each materialize resources before exposing paths', () => {
  const f = fixture()
  try {
    for (const [id, input] of [['slash', '/skill probe task'], ['bare', '/probe task']]) {
      const registry = f.snapshot(id!)
      assert.match(resolveAppPromptInput(input!, f.cwd, undefined, undefined, registry)!.prompt, /skill-files/)
      assert.ok(existsSync(join(registry.get('probe')!.skillDir!, 'scripts/run.py')))
      assert.equal(existsSync(registry.get('dormant')!.skillDir!), false)
    }
    const registry = f.snapshot('compact')
    assert.match(registry.renderInvokedSkillsBlock(['probe'], f.cwd)!, /skill-files/)
    assert.ok(existsSync(join(registry.get('probe')!.skillDir!, 'references/guide.pdf')))
  } finally { f.cleanup() }
})

test('off/manual tool rejection and untrusted slash parsing do not materialize resources', async () => {
  const f = fixture()
  try {
    const registry = f.snapshot('policy'), skill = registry.get('probe')!
    for (const mode of ['off', 'manual'] as const) {
      skill.mode = mode
      assert.equal((await activate(registry, f.cwd)).isError, true)
      assert.equal(existsSync(skill.skillDir!), false)
    }
    skill.mode = 'off'
    assert.doesNotMatch(resolveAppPromptInput('/probe', f.cwd, undefined, undefined, registry)!.prompt, /skill-files/)
    skill.mode = 'auto'; process.env.RIVET_TRUST_PROJECT = '0'
    assert.doesNotMatch(resolveAppPromptInput('/probe', f.cwd, undefined, undefined, registry)?.prompt ?? '', /skill-files/)
    assert.equal(existsSync(skill.skillDir!), false)
  } finally { f.cleanup() }
})

test('private writes never alter another session or the store; reload repairs and restores historical directories', async () => {
  const f = fixture()
  try {
    const a = f.snapshot('a'), b = f.snapshot('b')
    await activate(a, f.cwd); await activate(b, f.cwd)
    const aFile = join(a.get('probe')!.skillDir!, 'scripts/run.py'), bFile = join(b.get('probe')!.skillDir!, 'scripts/run.py')
    const ref = f.manifest('a').skills.find((s: { name: string }) => s.name === 'probe').packageRef
    const shared = join(f.store.root, ref, 'files/scripts/run.py')
    assert.equal(lstatSync(aFile).nlink, 1)
    writeFileSync(aFile, 'modified in A')
    assert.equal(readFileSync(bFile, 'utf8'), 'print("pinned")')
    assert.equal(readFileSync(shared, 'utf8'), 'print("pinned")')
    f.snapshot('a')
    assert.equal(readFileSync(aFile, 'utf8'), 'print("pinned")')
    rmSync(a.get('probe')!.skillDir!, { recursive: true })
    // No currently invoked names needed: the durable usage record restores historical paths.
    f.snapshot('a')
    assert.equal(readFileSync(aFile, 'utf8'), 'print("pinned")')
    deleteSessionFiles(f.cwd, 'a')
    f.snapshot('b')
    assert.equal(readFileSync(bFile, 'utf8'), 'print("pinned")')
    f.store.verify(ref)
  } finally { f.cleanup() }
})

test('legacy snapshots retain old caches and provenance; migration uses embedded bytes, never installed sources', () => {
  const f = fixture()
  try {
    const registry = f.snapshot('seed'), seed = f.manifest('seed')
    const legacy = { v: 1, skills: seed.skills.map((s: { packageRef: string }) => {
      const { packageRef, ...skill } = s
      const resources = packageRef ? f.store.export(packageRef) : []
      if (packageRef) resources.push({ path: '__pycache__/historical.pyc', executable: false, data: Buffer.from('old cache').toString('base64') })
      return { ...skill, resources }
    }) }
    const original = JSON.stringify(legacy)
    writeFileSync(join(f.sessions, 'legacy.skills.json'), original)
    rmSync(f.source, { recursive: true })
    const restored = f.snapshot('legacy')
    assert.equal(restored.get('probe')!.body, registry.get('probe')!.body)
    assert.equal(readFileSync(join(restored.get('probe')!.skillDir!, '__pycache__/historical.pyc'), 'utf8'), 'old cache')
    assert.equal(readFileSync(join(f.sessions, 'legacy.skills.json'), 'utf8'), original)
    const upgraded = upgradeSkillSnapshot(parseSkillSnapshot(original), f.store)
    assert.equal(upgraded.v, 2)
    assert.equal('resources' in upgraded.skills[0]!, false)
    for (const skill of upgraded.skills) if (skill.packageRef) f.store.verify(skill.packageRef)
  } finally { f.cleanup() }
})

test('corrupt shared bytes and invalid snapshots fail without replacing pinned manifests', async () => {
  const f = fixture()
  try {
    const registry = f.snapshot('a'), original = readFileSync(join(f.sessions, 'a.skills.json'), 'utf8')
    const ref = f.manifest('a').skills.find((s: { name: string }) => s.name === 'probe').packageRef
    writeFileSync(join(f.store.root, ref, 'files/scripts/run.py'), 'corrupt')
    await assert.rejects(activate(registry, f.cwd), /integrity/)
    assert.equal(readFileSync(join(f.sessions, 'a.skills.json'), 'utf8'), original)
    assert.throws(() => f.snapshot('new'), /integrity/)
    assert.equal(existsSync(join(f.sessions, 'new.skills.json')), false)
    assert.throws(() => parseSkillSnapshot('{"v":99,"skills":[]}'), /Invalid/)
    assert.throws(() => f.store.put([{ path: '../outside', data: '', executable: false }]), /Unsafe/)
    assert.throws(() => f.store.put([{ path: 'SKILL.md', data: '!!!', executable: false }]), /encoding/)
  } finally { f.cleanup() }
})

test('managed symlinks cannot redirect shared or materialized resources outside the store', async t => {
  const f = fixture()
  try {
    const registry = f.snapshot('a'), outside = join(f.root, 'outside')
    mkdirSync(outside)
    mkdirSync(registry.get('probe')!.skillDir!, { recursive: true })
    try { symlinkSync(outside, join(registry.get('probe')!.skillDir!, 'references'), 'junction') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink unavailable'); return }; throw error }
    await assert.rejects(activate(registry, f.cwd), /Symbolic/)
    assert.equal(readdirSync(outside).length, 0)
  } finally { f.cleanup() }
})

test('concurrent processes publish the same complete package without duplicate versions', async () => {
  const f = fixture()
  try {
    const modulePath = new URL('../skill-version-store.ts', import.meta.url).href
    const code = `import { SkillVersionStore } from ${JSON.stringify(modulePath)}; const store = new SkillVersionStore(); console.log(store.put([{path:'SKILL.md',data:Buffer.from('fixture').toString('base64'),executable:false}]))`
    const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env } })))
    assert.equal(new Set(results.map(r => r.stdout.trim())).size, 1)
    f.store.verify(results[0]!.stdout.trim())
    assert.equal(readdirSync(f.store.root).length, 1)
  } finally { f.cleanup() }
})

test('copy fallback still creates independent writable files', async () => {
  const f = fixture()
  const originalCopy = fs.copyFileSync
  let copies = 0
  const patched = mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike) => {
    copies++
    originalCopy(source, target, 0)
  })
  syncBuiltinESMExports()
  try {
    const registry = f.snapshot('fallback')
    await activate(registry, f.cwd)
    assert.ok(copies >= 3)
    const target = join(registry.get('probe')!.skillDir!, 'scripts/run.py')
    writeFileSync(target, 'changed')
    const ref = f.manifest('fallback').skills.find((s: { name: string }) => s.name === 'probe').packageRef
    assert.equal(readFileSync(join(f.store.root, ref, 'files/scripts/run.py'), 'utf8'), 'print("pinned")')
  } finally { patched.mock.restore(); syncBuiltinESMExports(); f.cleanup() }
})

test('/cd keeps shared references and used-resource recovery across project slugs', async () => {
  const f = fixture()
  try {
    delete process.env.RIVET_SESSION_DIR
    const registry = f.snapshot('move')
    await activate(registry, f.cwd)
    const other = join(f.root, 'other'); mkdirSync(other)
    migrateSessionFiles('move', f.cwd, other)
    const restored = sessionSkillSnapshot(other, 'move', f.management, { purpose: 'execute' })
    assert.equal(readFileSync(join(restored.get('probe')!.skillDir!, 'scripts/run.py'), 'utf8'), 'print("pinned")')
    assert.equal(restored.get('probe')!.body, registry.get('probe')!.body)
  } finally { f.cleanup() }
})

test('migration dry-run writes nothing; live runtimes block apply and portable export restores in another data root', async () => {
  const f = fixture()
  try {
    f.snapshot('original')
    const portable = join(f.root, 'portable.json')
    const exported = await runSkillsCLI(['snapshot-export', 'original', '--output', portable, '--json'], { cwd: f.cwd })
    assert.equal(exported.exitCode, 0, exported.output)
    const original = readFileSync(portable, 'utf8')
    writeFileSync(join(f.sessions, 'legacy.skills.json'), original)
    const before = readdirSync(f.store.root)
    const preview = await runSkillsCLI(['snapshot-migrate', 'legacy', '--json'], { cwd: f.cwd })
    assert.equal(preview.exitCode, 0, preview.output)
    assert.ok(JSON.parse(preview.output).reclaimableBytes > 80000)
    assert.equal(readFileSync(join(f.sessions, 'legacy.skills.json'), 'utf8'), original)
    assert.equal(existsSync(join(f.sessions, 'legacy')), false)
    assert.deepEqual(readdirSync(f.store.root), before)
    const applied = await runSkillsCLI(['snapshot-migrate', 'legacy', '--apply', '--json'], { cwd: f.cwd })
    assert.equal(applied.exitCode, 1)
    assert.match(applied.output, /runtime still active/)
    assert.equal(readFileSync(join(f.sessions, 'legacy.skills.json'), 'utf8'), original)
    const restored = f.snapshot('legacy')
    assert.equal(readFileSync(join(restored.get('probe')!.skillDir!, 'scripts/run.py'), 'utf8'), 'print("pinned")')
    assert.equal((await runSkillsCLI(['snapshot-export', 'original', '--output', portable], { cwd: f.cwd })).exitCode, 1)
    // Restore only the portable snapshot: no source packages and no original shared store.
    process.env.RIVET_SESSION_DIR = join(f.root, 'another-data-root')
    mkdirSync(process.env.RIVET_SESSION_DIR)
    writeFileSync(join(process.env.RIVET_SESSION_DIR, 'restored.skills.json'), original)
    rmSync(f.source, { recursive: true })
    const portableRegistry = sessionSkillSnapshot(f.cwd, 'restored', f.management, { purpose: 'execute' })
    assert.equal(readFileSync(join(portableRegistry.get('probe')!.skillDir!, 'scripts/run.py'), 'utf8'), 'print("pinned")')
  } finally { f.cleanup() }
})

test('interrupted package publication cannot commit a manifest or leave a half version', () => {
  const f = fixture(), originalRename = fs.renameSync
  const patched = mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).includes('_staging-')) throw Object.assign(new Error('injected publish failure'), { code: 'EIO' })
    originalRename(source, target)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => f.snapshot('interrupted'), /injected publish/)
    assert.equal(existsSync(join(f.sessions, 'interrupted.skills.json')), false)
    assert.deepEqual(readdirSync(f.store.root), [])
  } finally { patched.mock.restore(); syncBuiltinESMExports(); f.cleanup() }
})

test('failed migration keeps the complete v1 snapshot; failed activation is retryable and never reports success', async () => {
  const f = fixture()
  try {
    const registry = f.snapshot('original'), portable = join(f.root, 'portable.json')
    assert.equal((await runSkillsCLI(['snapshot-export', 'original', '--output', portable], { cwd: f.cwd })).exitCode, 0)
    const original = readFileSync(portable, 'utf8')
    writeFileSync(join(f.sessions, 'legacy.skills.json'), original)
    const offline = join(f.root, 'offline-sessions')
    mkdirSync(offline)
    writeFileSync(join(offline, 'legacy.skills.json'), original)
    const originalRename = fs.renameSync
    const renameMock = mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target).endsWith('legacy.skills.json')) throw new Error('injected manifest failure')
      originalRename(source, target)
    })
    syncBuiltinESMExports()
    try {
      process.env.RIVET_SESSION_DIR = offline
      const result = await runSkillsCLI(['snapshot-migrate', 'legacy', '--apply'], { cwd: f.cwd })
      assert.equal(result.exitCode, 1)
      assert.match(result.output, /injected manifest/)
      assert.equal(readFileSync(join(offline, 'legacy.skills.json'), 'utf8'), original)
    } finally { process.env.RIVET_SESSION_DIR = f.sessions; renameMock.mock.restore(); syncBuiltinESMExports() }
    let invoked = 0
    const copyMock = mock.method(fs, 'copyFileSync', () => { throw new Error('injected copy failure') })
    syncBuiltinESMExports()
    try {
      await assert.rejects(SKILL_TOOL.execute({ input: { name: 'probe' }, cwd: f.cwd, skillRegistry: registry,
        toolUseId: 'failed-copy', onSkillInvoked: () => { invoked++ } } as ToolCallParams), /injected copy/)
      assert.equal(invoked, 0)
      assert.equal(existsSync(join(f.sessions, 'original/skill-resources.json')), false)
    } finally { copyMock.mock.restore(); syncBuiltinESMExports() }
    assert.match((await activate(registry, f.cwd)).content, /skill-files/)
  } finally { f.cleanup() }
})
