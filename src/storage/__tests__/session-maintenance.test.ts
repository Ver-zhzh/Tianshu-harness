import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { buildCompactPlan, hash, identity } from '../compact-plan.js'
import { applyCompactPlan } from '../compact-apply.js'
import { auditStorage } from '../audit.js'
import { acquireStorageMaintenance } from '../maintenance-gate.js'
import { sessionSkillSnapshot } from '../../skills/session-skill-snapshot.js'
import { SkillVersionStore } from '../../skills/skill-version-store.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { projectSlug } from '../../config/paths.js'
import { runStorageCLI } from '../../cli/storage-cli.js'
import { createRouter } from '../../server/index.js'
import { buildStorageAuditRoutes } from '../../server/storage-audit-routes.js'
import { evictOldSessions, SessionPersist } from '../../agent/session-persist.js'
import { assertTestSessionWrite } from '../../platform/test-session-isolation.js'

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'session-maintenance-')), home = join(temp, 'home'), root = join(home, 'sessions'), cwd = join(temp, 'project'), desktop = join(home, 'desktop/sessions')
  const keys = ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_DESKTOP_DIR', 'RIVET_DESKTOP_SESSION_DIR', 'RIVET_TRUST_PROJECT']
  const previous = keys.map(k => process.env[k])
  process.env.RIVET_HOME = home; delete process.env.RIVET_SESSION_DIR; delete process.env.RIVET_DESKTOP_DIR
  process.env.RIVET_DESKTOP_SESSION_DIR = desktop; process.env.RIVET_TRUST_PROJECT = '1'
  mkdirSync(root, { recursive: true }); mkdirSync(cwd); mkdirSync(desktop, { recursive: true })
  const project = join(root, projectSlug(cwd)); mkdirSync(project)
  const files = [
    { path: 'SKILL.md', data: Buffer.from('---\nname: probe\ndescription: probe\n---\nPinned body').toString('base64'), executable: false },
    { path: 'references/guide.bin', data: Buffer.alloc(256, 42).toString('base64'), executable: false },
    { path: 'scripts/run.py', data: Buffer.from('print("pinned")').toString('base64'), executable: true },
  ]
  const legacy = JSON.stringify({ v: 1, skills: [{ name: 'probe', description: 'probe', body: 'Pinned body', triggers: [], source: 'rivet', mode: 'auto', version: 'historical',
    files: files.slice(1).map(f => ({ path: f.path, kind: 'file' })), resources: files }] })
  const add = (id: string, expand = false, chat = true) => {
    writeFileSync(join(project, `${id}.skills.json`), legacy)
    if (chat) writeFileSync(join(project, `${id}.jsonl`), `chat-${id}\n`)
    if (expand) for (const f of files) {
      const path = join(project, id, 'skills/probe', f.path)
      mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.from(f.data, 'base64'), { mode: f.executable ? 0o700 : 0o600 })
    }
  }
  const savePlan = async () => {
    const plan = await buildCompactPlan({ root }), path = join(temp, 'plan.json')
    writeFileSync(path, JSON.stringify(plan))
    return { plan, path }
  }
  return { temp, home, root, cwd, desktop, project, files, legacy, add, savePlan,
    store: new SkillVersionStore(join(root, '_skill-store/v1'), root),
    cleanup() { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i] }); rmSync(temp, { recursive: true, force: true }) } }
}

test('thousands of main, worker and unattached snapshots compact into one version without losing any chat', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 2000; i++) f.add(i % 2 ? `worker-batch-${i}-nonce` : `main-${i}`, i < 4, i % 3 !== 0)
    const beforeChats = readdirSync(f.project).filter(p => p.endsWith('.jsonl')).map(p => [p, hash(readFileSync(join(f.project, p)))])
    const before = readdirSync(f.root), { plan, path } = await f.savePlan()
    assert.equal(plan.entries.length, 2000)
    assert.ok(plan.estimate.netLogicalBytes > 0)
    assert.deepEqual(readdirSync(f.root), before, 'preview cannot create a version store or maintenance control')
    const result = await applyCompactPlan(path)
    assert.equal(result.completed, 2000)
    assert.equal(result.skipped, 0)
    assert.equal(readdirSync(f.store.root).filter(n => /^[a-f0-9]{64}$/.test(n)).length, 1)
    for (const [name, expected] of beforeChats) assert.equal(hash(readFileSync(join(f.project, name!))), expected)
    for (const item of plan.entries) assert.equal(JSON.parse(readFileSync(join(f.root, item.manifest), 'utf8')).v, 2)
    assert.equal(existsSync(join(f.project, 'main-0/skills/probe/SKILL.md')), false)
    const repeat = await applyCompactPlan(path)
    assert.equal(repeat.completed, result.completed)
    assert.equal(repeat.manifestSavings, result.manifestSavings)
  } finally { f.cleanup() }
})

test('catalog loads remain read-only after reclamation, execution reconstructs pinned historical paths', async () => {
  const f = fixture()
  try {
    f.add('old', true)
    const management = new SkillManagement(f.home, join(f.temp, 'external'))
    sessionSkillSnapshot(f.cwd, 'old', management, { purpose: 'catalog' }).list()
    assert.equal(existsSync(f.store.root), false, 'reading v1 must not publish shared versions')
    const { path } = await f.savePlan(); await applyCompactPlan(path)
    const resource = join(f.project, 'old/skills/probe/scripts/run.py')
    assert.equal(existsSync(resource), false)
    sessionSkillSnapshot(f.cwd, 'old', management, { purpose: 'catalog' }).list()
    await auditStorage({ root: f.root, desktopRoot: f.desktop })
    assert.equal(existsSync(resource), false)
    sessionSkillSnapshot(f.cwd, 'old', management, { purpose: 'execute' })
    assert.equal(readFileSync(resource, 'utf8'), 'print("pinned")')
  } finally { f.cleanup() }
})

test('only exact manifest bytes are removable; modified resources, outputs and symlinks survive', async t => {
  const f = fixture()
  try {
    f.add('a', true)
    const skill = join(f.project, 'a/skills/probe'), modified = join(skill, 'scripts/run.py'), output = join(skill, 'result.txt')
    writeFileSync(modified, 'user changes'); writeFileSync(output, 'user output')
    const outside = join(f.temp, 'outside'); writeFileSync(outside, 'outside')
    const link = join(skill, 'generated-link')
    try { symlinkSync(outside, link) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; t.diagnostic('symlink unavailable on this host') }
    const { path, plan } = await f.savePlan()
    assert.ok(plan.skipped.some(s => s.error.includes('Modified resource')))
    await applyCompactPlan(path)
    assert.equal(readFileSync(modified, 'utf8'), 'user changes')
    assert.equal(readFileSync(output, 'utf8'), 'user output')
    assert.equal(readFileSync(outside, 'utf8'), 'outside')
    if (existsSync(link)) assert.ok(lstatSync(link).isSymbolicLink())
    assert.equal(existsSync(join(skill, 'references/guide.bin')), false)
  } finally { f.cleanup() }
})

test('changed files and root mismatch invalidate preview rather than deleting current content', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan(), target = join(f.project, 'a/skills/probe/references/guide.bin')
    writeFileSync(target, 'modified after preview')
    assert.equal((await applyCompactPlan(path)).skipped, 1)
    assert.equal(readFileSync(target, 'utf8'), 'modified after preview')
    assert.equal(JSON.parse(readFileSync(join(f.project, 'a.skills.json'), 'utf8')).v, 1)
    const another = join(f.temp, 'another'); mkdirSync(another)
    await assert.rejects(applyCompactPlan(path, { root: another }), /root/)
  } finally { f.cleanup() }
})

test('executable-flag changes after preview are preserved even when size and mtime are unchanged', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan(), script = join(f.project, 'a/skills/probe/scripts/run.py')
    const before = lstatSync(script)
    fs.chmodSync(script, 0o600)
    assert.equal(lstatSync(script).mtimeMs, before.mtimeMs)
    assert.equal((await applyCompactPlan(path)).skipped, 1)
    assert.equal(readFileSync(script, 'utf8'), 'print("pinned")')
  } finally { f.cleanup() }
})

test('a disappeared manifest is skipped without removing its transcript or resources', async () => {
  const f = fixture()
  try {
    f.add('gone', true)
    const { path } = await f.savePlan()
    rmSync(join(f.project, 'gone.skills.json'))
    assert.equal((await applyCompactPlan(path)).skipped, 1)
    assert.equal(readFileSync(join(f.project, 'gone.jsonl'), 'utf8'), 'chat-gone\n')
    assert.ok(existsSync(join(f.project, 'gone/skills/probe/SKILL.md')))
  } finally { f.cleanup() }
})

test('a forged deletion cannot target transcripts even when the attacker supplies their current hash', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { plan, path } = await f.savePlan()
    plan.entries[0]!.prune[0]!.path = `${projectSlug(f.cwd)}/a.jsonl`
    plan.entries[0]!.prune[0]!.hash = hash(readFileSync(join(f.project, 'a.jsonl')))
    plan.entries[0]!.prune[0]!.identity = identity(lstatSync(join(f.project, 'a.jsonl')))
    writeFileSync(path, JSON.stringify(plan))
    await assert.rejects(applyCompactPlan(path), /authoritative/)
    assert.equal(readFileSync(join(f.project, 'a.jsonl'), 'utf8'), 'chat-a\n')
  } finally { f.cleanup() }
})

test('permission failure after v2 publication resumes without losing resources or counting twice', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan(), originalUnlink = fsp.unlink
    const patch = mock.method(fsp, 'unlink', async (target: fs.PathLike) => {
      if (String(target).includes('skills')) throw Object.assign(new Error('injected unlink denied'), { code: 'EACCES' })
      return originalUnlink(target)
    })
    syncBuiltinESMExports()
    try { await assert.rejects(applyCompactPlan(path), /injected unlink/) }
    finally { patch.mock.restore(); syncBuiltinESMExports() }
    assert.equal(JSON.parse(readFileSync(join(f.project, 'a.skills.json'), 'utf8')).v, 2)
    assert.equal(readFileSync(join(f.project, 'a/skills/probe/scripts/run.py'), 'utf8'), 'print("pinned")')
    const resumed = await applyCompactPlan(path), repeated = await applyCompactPlan(path)
    assert.equal(resumed.completed, 1)
    assert.deepEqual(resumed, repeated)
    assert.equal(readFileSync(join(f.project, 'a.jsonl'), 'utf8'), 'chat-a\n')
  } finally { f.cleanup() }
})

test('disk-full publication leaves the complete v1 fallback and no private file is removed', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan(), originalWrite = fs.writeFileSync
    const patch = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('_staging-')) throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' })
      return originalWrite(...args)
    })
    syncBuiltinESMExports()
    try { await assert.rejects(applyCompactPlan(path), /injected disk full/) }
    finally { patch.mock.restore(); syncBuiltinESMExports() }
    assert.equal(readFileSync(join(f.project, 'a.skills.json'), 'utf8'), f.legacy)
    assert.ok(existsSync(join(f.project, 'a/skills/probe/SKILL.md')))
    assert.equal((await applyCompactPlan(path)).completed, 1)
  } finally { f.cleanup() }
})

test('all canonical resource files are synced before the first private copy is removed', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan(), ref = f.store.reference(f.files)
    const canonical = f.files.map(file => join(f.store.root, ref, 'files', file.path)), synced = new Set<string>()
    const originalSync = fs.fsyncSync, originalUnlink = fsp.unlink
    const syncPatch = mock.method(fs, 'fsyncSync', (fd: number) => {
      const current = fs.fstatSync(fd)
      for (const file of canonical) if (existsSync(file)) {
        const st = lstatSync(file)
        if (st.dev === current.dev && st.ino === current.ino) synced.add(file)
      }
      originalSync(fd)
    })
    const unlinkPatch = mock.method(fsp, 'unlink', async (target: fs.PathLike) => {
      if (String(target).includes('skills')) assert.equal(synced.size, canonical.length, 'canonical files must reach disk first')
      return originalUnlink(target)
    })
    syncBuiltinESMExports()
    try { assert.equal((await applyCompactPlan(path)).completed, 1) }
    finally { syncPatch.mock.restore(); unlinkPatch.mock.restore(); syncBuiltinESMExports() }
  } finally { f.cleanup() }
})

test('net preview deducts new shared bytes once across duplicate packages', async () => {
  const f = fixture()
  try {
    f.add('a')
    const one = await buildCompactPlan({ root: f.root })
    f.add('b')
    const two = await buildCompactPlan({ root: f.root })
    assert.ok(two.estimate.newSharedBytes > 0)
    assert.equal(two.estimate.newSharedBytes, one.estimate.newSharedBytes)
    assert.equal(two.estimate.netLogicalBytes, two.estimate.manifestSavings + two.estimate.privateSavings - two.estimate.newSharedBytes)
  } finally { f.cleanup() }
})

test('corrupt shared versions stop recovery before removing remaining copies', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const { path } = await f.savePlan()
    const originalUnlink = fsp.unlink
    const patch = mock.method(fsp, 'unlink', async (p: fs.PathLike) => { if (String(p).includes('skills')) throw new Error('pause'); return originalUnlink(p) })
    syncBuiltinESMExports()
    try { await assert.rejects(applyCompactPlan(path), /pause/) } finally { patch.mock.restore(); syncBuiltinESMExports() }
    const ref = JSON.parse(readFileSync(join(f.project, 'a.skills.json'), 'utf8')).skills[0].packageRef
    writeFileSync(join(f.store.root, ref, 'files/scripts/run.py'), 'corrupt')
    await assert.rejects(applyCompactPlan(path), /integrity/)
    assert.ok(existsSync(join(f.project, 'a/skills/probe/SKILL.md')))
  } finally { f.cleanup() }
})

test('leases exclude live runtime processes and new writers, dead maintenance is recoverable', async () => {
  const f = fixture()
  const module = new URL('../maintenance-gate.ts', import.meta.url).href
  const args = ['--import', 'tsx', '--input-type=module', '-e']
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(process.execPath, [...args, `import { registerStorageRuntime } from ${JSON.stringify(module)}; registerStorageRuntime(${JSON.stringify(f.root)}); console.log('ready'); setInterval(()=>{},1000)`], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    await once(child.stdout!, 'data')
    assert.throws(() => acquireStorageMaintenance(f.root), /runtime still active/)
    child.kill(); await once(child, 'exit'); child = undefined
    const release = acquireStorageMaintenance(f.root)
    try {
      assert.throws(() => new SessionPersist('blocked-local-runtime', f.cwd), /maintenance in progress/)
      assert.throws(() => f.store.materialize('0'.repeat(64), join(f.project, 'blocked-copy')), /maintenance in progress/)
      await assert.rejects(promisify(execFile)(process.execPath, [...args, `import { registerStorageRuntime } from ${JSON.stringify(module)};registerStorageRuntime(${JSON.stringify(f.root)});`], { env: { ...process.env } }), /maintenance in progress/)
    } finally { release() }
    await promisify(execFile)(process.execPath, [...args, `import { acquireStorageMaintenance } from ${JSON.stringify(module)};acquireStorageMaintenance(${JSON.stringify(f.root)});`], { env: { ...process.env } })
    acquireStorageMaintenance(f.root)()
  } finally { if (child) child.kill(); f.cleanup() }
})

test('unknown and foreign lease ownership cannot be expired by old timestamps', () => {
  const f = fixture()
  try {
    const directory = join(f.root, '_storage-control/runtime'); mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'unknown.lock'), '{bad')
    assert.throws(() => acquireStorageMaintenance(f.root), /runtime still active/)
    writeFileSync(join(directory, 'unknown.lock'), JSON.stringify({ pid: process.pid, hostname: hostname() + '-foreign', acquiredAt: '2000-01-01', ownerToken: 'foreign' }))
    assert.throws(() => acquireStorageMaintenance(f.root), /runtime still active/)
  } finally { f.cleanup() }
})

test('automatic eviction entry point preserves more than fifty main transcripts', () => {
  const f = fixture()
  try {
    for (let i = 0; i < 80; i++) writeFileSync(join(f.project, `main-${i}.jsonl`), `chat-${i}`)
    assert.deepEqual(evictOldSessions('main-79', f.cwd), [])
    assert.equal(readdirSync(f.project).filter(n => n.endsWith('.jsonl')).length, 80)
  } finally { f.cleanup() }
})

test('synthetic production-root guard rejects writes without touching that directory', () => {
  const f = fixture(), protectedHome = join(f.temp, 'synthetic-production-home')
  try {
    assert.throws(() => assertTestSessionWrite(join(protectedHome, 'sessions'), protectedHome), /RIVET_TEST_SESSION_WRITE/)
    assert.equal(existsSync(protectedHome), false)
  } finally { f.cleanup() }
})

test('audit covers overlapping roots once, reports orphans/versions, and supports cancellation', async () => {
  const f = fixture()
  try {
    f.add('a', true); f.add('worker-one', false, false)
    const workerNamedSkill = join(f.project, 'a/skills/worker-labelled')
    mkdirSync(workerNamedSkill); writeFileSync(join(workerNamedSkill, 'notes.md'), 'main-session asset')
    mkdirSync(join(f.root, '_storage-control')); writeFileSync(join(f.root, '_storage-control/note.json'), '{}')
    const eventDir = join(f.root, 'desktop-events/a'); mkdirSync(eventDir, { recursive: true }); writeFileSync(join(eventDir, 'events.jsonl'), 'events')
    const report = await auditStorage({ root: f.root, desktopRoot: join(f.root, 'desktop-events') })
    assert.equal(report.roots.length, 1)
    assert.equal(report.snapshotVersions[1], 2)
    assert.equal(report.suspectedOrphans.files, 1)
    assert.equal(report.categories.desktopEvents!.files, 1)
    assert.equal(report.categories.maintenanceControl!.files, 1)
    assert.equal(report.roles.worker!.files, 1, 'a worker-prefixed skill is not a worker session')
    assert.equal(report.sharedVersions.referenceScanComplete, false)
    assert.equal(existsSync(f.store.root), false)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(auditStorage({ root: f.root, signal: controller.signal }), /abort/i)
  } finally { f.cleanup() }
})

test('CLI defaults to preview and asynchronous audit routes enforce auth, pagination and cancellation', async () => {
  const f = fixture()
  try {
    f.add('a', true)
    const preview = await runStorageCLI(['compact', '--dry-run', '--json'])
    assert.equal(preview.exitCode, 0, preview.output)
    assert.equal(JSON.parse(preview.output).dryRun, true)
    assert.equal(existsSync(f.store.root), false)
    const router = createRouter(buildStorageAuditRoutes({ apiToken: 'fixture-auth', root: f.root, desktopRoot: f.desktop }))
    assert.equal((await router('POST', '/storage/audits', {})).status, 401)
    const headers = { authorization: 'Bearer fixture-auth' }
    const start = await router('POST', '/storage/audits', {}, headers)
    assert.equal(start.status, 202)
    const id = (start.body as { id: string }).id
    assert.equal((await router('POST', '/storage/audits', {}, headers)).status, 409)
    assert.equal((await router('DELETE', `/storage/audits/${id}`, {}, headers)).status, 200)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(((await router('GET', `/storage/audits/${id}`, {}, headers)).body as { status: string }).status, 'cancelled')
    for (let i = 0; i < 110; i++) {
      const directory = join(f.root, `pagination-${i}`); mkdirSync(directory); writeFileSync(join(directory, 'sample.jsonl'), 'chat')
    }
    const next = await router('POST', '/storage/audits', {}, headers), nextId = (next.body as { id: string }).id
    let page: { status: string; hasMore: boolean; report?: { projects: Record<string, unknown> } } | undefined
    for (let attempt = 0; attempt < 300; attempt++) {
      page = (await router('GET', `/storage/audits/${nextId}?page=0`, {}, headers)).body as typeof page
      if (page?.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(page?.status, 'complete')
    assert.equal(Object.keys(page!.report!.projects).length, 100)
    assert.equal(page!.hasMore, true)
    const second = (await router('GET', `/storage/audits/${nextId}?page=1`, {}, headers)).body as typeof page
    assert.ok(Object.keys(second!.report!.projects).length > 0)
    assert.equal((await router('GET', `/storage/audits/${nextId}?page=-1`, {}, headers)).status, 400)
  } finally { f.cleanup() }
})
