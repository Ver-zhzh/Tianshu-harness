import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, open, rm, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AuditManifestReader, AUDIT_MANIFEST_LIMIT } from '../audit-manifest.js'
import { auditStorage } from '../audit.js'
import { canonicalStoragePath } from '../../platform/test-session-isolation.js'

async function fixture() {
  const temp = canonicalStoragePath(await mkdtemp(join(tmpdir(), 'audit-bounded-')))
  const root = join(temp, 'sessions'), desktopRoot = join(temp, 'desktop')
  await mkdir(root); await mkdir(desktopRoot)
  const path = join(root, 'probe.skills.json')
  const entry = async () => {
    const st = await lstat(path)
    return { root, path, relative: 'probe.skills.json', bytes: st.size, allocatedBytes: st.blocks * 512, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, symlink: false }
  }
  return { temp, root, desktopRoot, path, entry, cleanup: () => rm(temp, { recursive: true, force: true }) }
}

test('oversized v2 is counted without parsing; later manifests still supply refs', async () => {
  const f = await fixture()
  try {
    const handle = await open(f.path, 'w')
    await handle.write('{"v":2,"skills":[]}'); await handle.truncate(AUDIT_MANIFEST_LIMIT + 1); await handle.close()
    const ref = 'a'.repeat(64)
    await writeFile(join(f.root, 'small.skills.json'), JSON.stringify({ v: 2, skills: [{ packageRef: ref, body: '汉字' }] }))
    const report = await auditStorage(f)
    assert.equal(report.snapshotVersions[2], 2)
    assert.ok(report.totals.logicalBytes > AUDIT_MANIFEST_LIMIT)
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0]?.code, 'manifest_too_large')
    assert.equal(report.sharedVersions.referenceScanComplete, false)
    assert.equal(report.sharedVersions.unreferenced, 0)
  } finally { await f.cleanup() }
})

test('worker validates the complete manifest and rejects partial or invented references', async () => {
  const f = await fixture(), reader = new AuditManifestReader()
  try {
    const ref = 'b'.repeat(64)
    await writeFile(f.path, JSON.stringify({ v: 2, skills: [{ packageRef: ref, body: '{"packageRef":"fake"}' }, { body: '界'.repeat(30_000) }] }))
    assert.deepEqual((await reader.read(await f.entry())).refs, [ref])
    for (const value of [{ v: 2, skills: [{ packageRef: ref }, { packageRef: 'invalid' }] }, { v: 2, skills: [null] }, { v: 2, skills: Array(8193).fill({}) }]) {
      await writeFile(f.path, JSON.stringify(value))
      await assert.rejects(reader.read(await f.entry()), { code: 'invalid_manifest' })
    }
    await writeFile(f.path, '{"v":2,"skills":[')
    await assert.rejects(reader.read(await f.entry()), { code: 'invalid_manifest' })
  } finally { await reader.close(); await f.cleanup() }
})

test('changed files and symbolic paths cannot supply audit references', async () => {
  const f = await fixture(), reader = new AuditManifestReader()
  try {
    await writeFile(f.path, '{"v":2,"skills":[]}')
    const entry = await f.entry()
    await writeFile(f.path, '{"v":2,"skills":[],"changed":true}')
    await assert.rejects(reader.read(entry), { code: 'manifest_changed' })
    await rm(f.path); await writeFile(join(f.temp, 'outside'), '{"v":2,"skills":[]}')
    await symlink(join(f.temp, 'outside'), f.path)
    await assert.rejects(reader.read(await f.entry()), { code: 'manifest_changed' })
  } finally { await reader.close(); await f.cleanup() }
})

test('hanging parser has a deadline and cancellation frees it without blocking the parent', async () => {
  const f = await fixture(), reader = new AuditManifestReader(50, 'setInterval(() => {}, 1000)')
  try {
    await writeFile(f.path, '{"v":2,"skills":[]}')
    await assert.rejects(reader.read(await f.entry()), { code: 'parse_timeout' })
    const controller = new AbortController(), entry = await f.entry()
    const cancelledReader = new AuditManifestReader(2000, 'setInterval(() => {}, 1000)')
    try {
      const started = performance.now(), pending = cancelledReader.read(entry, controller.signal)
      setTimeout(() => controller.abort(new Error('user cancelled')), 10)
      await assert.rejects(pending, /user cancelled/)
      assert.ok(performance.now() - started < 500, 'cancellation must not wait for the parse timeout')
    } finally { await cancelledReader.close() }
    const normal = new AuditManifestReader()
    try { assert.deepEqual((await normal.read(entry)).refs, []) } finally { await normal.close() }
  } finally { await reader.close(); await f.cleanup() }
})

test('audit never reads large transcripts or logs; post-stat growth is rejected', async () => {
  const f = await fixture(), reader = new AuditManifestReader()
  const original = fsp.open
  try {
    await writeFile(f.path, '{"v":2,"skills":[]}')
    await writeFile(join(f.root, 'chat.jsonl'), 'preserve chat')
    await writeFile(join(f.root, 'cache-log.jsonl'), 'preserve billing')
    let reads = 0, grow = true
    mock.method(fsp, 'open', async (...args: Parameters<typeof original>) => {
      assert.ok(!String(args[0]).endsWith('.jsonl'), 'JSONL is metadata-only')
      const fd = await original(...args)
      return new Proxy(fd, { get(target, key) {
        if (key === 'read') return async (...params: Parameters<typeof fd.read>) => {
          reads++
          const result = await fd.read(...params)
          if (grow) { grow = false; await fsp.appendFile(f.path, ' ') }
          return result
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    syncBuiltinESMExports()
    await assert.rejects(reader.read(await f.entry()), { code: 'manifest_changed' })
    assert.ok(reads <= 3)
    assert.equal((await auditStorage(f)).totals.files, 3)
  } finally { mock.restoreAll(); syncBuiltinESMExports(); await reader.close(); await f.cleanup() }
})

test('parser does not inherit parent eval module flags or TypeScript loaders', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, '{"v":2,"skills":[]}')
    const source = `import { AuditManifestReader } from ${JSON.stringify(new URL('../audit-manifest.ts', import.meta.url).href)};
      const reader = new AuditManifestReader();
      try { const result = await reader.read(${JSON.stringify(await f.entry())}); if (result.refs.length !== 0) throw Error('unexpected refs'); }
      finally { await reader.close(); }`
    for (const options of ['', '--input-type=module']) await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      timeout: 10_000, env: { ...process.env, NODE_OPTIONS: options },
    })
  } finally { await f.cleanup() }
})

test('unavailable parser is not repeatedly restarted for later files', async () => {
  const f = await fixture(), starts = join(f.temp, 'starts')
  const reader = new AuditManifestReader(2000, `require('node:fs').appendFileSync(${JSON.stringify(starts)}, '1'); throw Error('parser infrastructure unavailable')`)
  try {
    await writeFile(f.path, '{"v":2,"skills":[]}')
    for (let i = 0; i < 3; i++) await assert.rejects(reader.read(await f.entry()), { code: 'parser_unavailable' })
    assert.equal(await fsp.readFile(starts, 'utf8'), '1')
  } finally { await reader.close(); await f.cleanup() }
})
