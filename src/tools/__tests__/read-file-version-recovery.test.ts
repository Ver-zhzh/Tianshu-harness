import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests, noteFileObserved, getFileReadContentHash } from '../read-file.js'
import { ArtifactStore } from '../../artifact/store.js'
import { fileReadGate } from '../../agent/file-read-gate.js'
import { currentFileVersion } from '../../agent/file-version.js'
import { PrewarmCache } from '../../agent/prewarm.js'
import { buildPrewarmValue } from '../../agent/prewarm-file.js'

const originalReadRef = process.env.RIVET_READ_REF
afterEach(() => {
  __resetReadHistoryForTests()
  if (originalReadRef === undefined) delete process.env.RIVET_READ_REF
  else process.env.RIVET_READ_REF = originalReadRef
})

for (const artifact of [false, true]) for (const range of [false, true]) {
  test(`${artifact ? 'artifact' : 'read-ref'} read restores evicted version with ${range ? 'partial' : 'full'} observation`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'read-version-recovery-'))
    try {
      __resetReadHistoryForTests()
      process.env.RIVET_READ_REF = '1'
      const file = join(cwd, 'sample.ts'), sessionId = 'reader'
      const content = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`.padEnd(80, ' ')).join('\n')
      writeFileSync(file, content)
      const params = { cwd, sessionId, toolUseId: 'initial', input: { file_path: 'sample.ts' },
        contextWindow: 128_000, ...(artifact ? { artifactStore: new ArtifactStore(cwd, sessionId) } : {}) }
      const initial = await READ_FILE_TOOL.execute(params)
      assert.equal(initial.fileStates?.[0]?.version, currentFileVersion(file))
      for (let i = 0; i < 501; i++) noteFileObserved(join(cwd, `other-${i}.ts`), 1, 1, sessionId, 'x')
      assert.equal(getFileReadContentHash(file, sessionId), undefined, 'production capacity trimming evicted the observation')

      const reread = await READ_FILE_TOOL.execute({ ...params, toolUseId: 'recover',
        input: { file_path: 'sample.ts', ...(range ? { offset: 50, limit: 2 } : {}) } })
      assert.equal(reread.fileStates?.[0]?.version, range ? null : currentFileVersion(file), 'a bounded range cannot establish a whole-file version')
      assert.equal(reread.fileStates?.[0]?.observation, range ? 'partial' : 'full')
      assert.ok(!reread.content.startsWith('[read-ref]'), 'missing version requires an actual read')
      assert.equal(fileReadGate('edit_file', params) === undefined, !range, 'exact edits need actual version evidence')
      assert.equal(fileReadGate('write_file', params) === undefined, !range, 'partial read never authorizes whole-file overwrite')
      assert.ok(fileReadGate('edit_file', { ...params, sessionId: 'other' }), 'observations do not cross sessions')
      if (range) {
        const full = await READ_FILE_TOOL.execute({ ...params, toolUseId: 'full-recover' })
        assert.equal(full.fileStates?.[0]?.version, currentFileVersion(file))
        assert.equal(full.fileStates?.[0]?.observation, 'full')
        assert.equal(fileReadGate('edit_file', params), undefined)
      }
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
}

test('version recovery reads a same-size external modification even with restored mtime', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'read-version-external-'))
  try {
    __resetReadHistoryForTests()
    const file = join(cwd, 'sample.ts')
    const content = Array.from({ length: 100 }, () => '// old content'.padEnd(80, ' ')).join('\n')
    writeFileSync(file, content)
    const fixedTime = new Date('2026-10-01T00:00:00.000Z')
    utimesSync(file, fixedTime, fixedTime)
    const params = { cwd, sessionId: 'reader', toolUseId: 'initial', input: { file_path: 'sample.ts' },
      contextWindow: 128_000, artifactStore: new ArtifactStore(cwd, 'reader') }
    await READ_FILE_TOOL.execute(params)
    for (let i = 0; i < 501; i++) noteFileObserved(join(cwd, `other-${i}.ts`), 1, 1, 'reader', 'x')
    const before = statSync(file)
    writeFileSync(file, content.replaceAll('old', 'new'))
    utimesSync(file, before.atime, before.mtime)
    assert.equal(statSync(file).mtimeMs, before.mtimeMs, 'exercise identical filesystem metadata')
    assert.equal(statSync(file).size, before.size)
    const result = await READ_FILE_TOOL.execute({ ...params, toolUseId: 'recover' })
    assert.ok(result.content.includes('// new content'))
    assert.equal(result.fileStates?.[0]?.version, currentFileVersion(file))
    assert.equal(fileReadGate('edit_file', params), undefined)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('a cache hit cannot borrow a version observation with different metadata', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'read-version-mismatch-'))
  try {
    __resetReadHistoryForTests()
    const file = join(cwd, 'sample.ts'), sessionId = 'reader'
    writeFileSync(file, '// original content\n'.repeat(200))
    const params = { cwd, sessionId, toolUseId: 'initial', input: { file_path: 'sample.ts' },
      contextWindow: 128_000, artifactStore: new ArtifactStore(cwd, sessionId) }
    await READ_FILE_TOOL.execute(params)
    const current = statSync(file)
    noteFileObserved(file, current.mtimeMs + 1000, 5, sessionId, 'other')
    const result = await READ_FILE_TOOL.execute({ ...params, toolUseId: 'recover' })
    assert.equal(result.fileStates?.[0]?.version, currentFileVersion(file))
    assert.equal(fileReadGate('edit_file', params), undefined)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

for (const artifact of [false, true]) test(`live ${artifact ? 'artifact' : 'read-ref'} cache rejects same-metadata content changes`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'read-live-version-'))
  try {
    __resetReadHistoryForTests(); process.env.RIVET_READ_REF = '1'
    const file = join(cwd, 'sample.ts'), time = new Date('2026-10-01T00:00:00Z')
    const old = Array.from({ length: 100 }, () => '// old content'.padEnd(80, ' ')).join('\n')
    writeFileSync(file, old); utimesSync(file, time, time)
    const prewarmCache = new PrewarmCache(), warm = await buildPrewarmValue(cwd, 'sample.ts')
    assert.ok(warm); prewarmCache.set(file, warm)
    const params = { cwd, sessionId: 'reader', toolUseId: 'initial', input: { file_path: 'sample.ts' },
      contextWindow: 128_000, ...(artifact ? { artifactStore: new ArtifactStore(cwd, 'reader') } : {}) }
    await READ_FILE_TOOL.execute(params)
    writeFileSync(file, old.replaceAll('old', 'new')); utimesSync(file, time, time)
    const fresh = await READ_FILE_TOOL.execute({ ...params, prewarmCache, toolUseId: 'refresh' })
    assert.ok(fresh.content.includes('// new content'), 'fresh reads cannot cycle through the old cache')
    assert.equal(fresh.fileStates?.[0]?.version, currentFileVersion(file))
    assert.equal(fileReadGate('edit_file', params), undefined)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('a changed focused read cannot inherit whole-file overwrite authority from the old version', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'read-focus-authority-'))
  try {
    __resetReadHistoryForTests()
    const file = join(cwd, 'sample.ts'), time = new Date('2026-10-01T00:00:00Z')
    const content = Array.from({ length: 100 }, (_, i) => `// line ${i + 1} old content`.padEnd(80, ' ')).join('\n')
    writeFileSync(file, content); utimesSync(file, time, time)
    const params = { cwd, sessionId: 'reader', toolUseId: 'initial', input: { file_path: 'sample.ts' }, contextWindow: 128_000 }
    await READ_FILE_TOOL.execute(params)
    assert.equal(fileReadGate('write_file', params), undefined)
    writeFileSync(file, content.replaceAll('old', 'new')); utimesSync(file, time, time)
    const focused = await READ_FILE_TOOL.execute({ ...params, toolUseId: 'focus', input: { file_path: 'sample.ts', focus: 'line 50' } })
    assert.equal(focused.fileStates?.[0]?.version, currentFileVersion(file))
    assert.equal(focused.fileStates?.[0]?.observation, 'partial')
    assert.ok(fileReadGate('write_file', params), 'the new version was not fully observed')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
