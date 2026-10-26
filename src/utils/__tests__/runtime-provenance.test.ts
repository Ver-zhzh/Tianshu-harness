import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { RUNTIME_PROVENANCE, withRuntimeRun, runtimeObservation, recordRuntimeRequest } from '../runtime-provenance.js'

test('unbundled source does not infer a build from cwd or environment', () => {
  assert.equal(RUNTIME_PROVENANCE.buildId, 'unknown')
  assert.equal(RUNTIME_PROVENANCE.moduleSha256, 'unknown')
})

test('bundled identity hashes its actual module and stays fixed after a disk rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-provenance-'))
  try {
    const file = join(dir, 'out', 'runtime.mjs'), stamp = { id: 'fixture-build-a', revision: 'fixture-revision', version: '1.2.3' }
    for (const entry of ['runtime', 'other']) writeFileSync(join(dir, entry + '.ts'), `export {RUNTIME_PROVENANCE} from ${JSON.stringify(resolve('src/utils/runtime-provenance.ts'))}`)
    await build({ entryPoints: [join(dir, 'runtime.ts'), join(dir, 'other.ts')], outdir: join(dir, 'out'), splitting: true,
      outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { __RIVET_BUILD_STAMP__: JSON.stringify(JSON.stringify(stamp)) } })
    const loaded = await import(pathToFileURL(file).href)
    const before = loaded.RUNTIME_PROVENANCE
    assert.equal(before.buildId, stamp.id)
    assert.equal(before.sourceRevision, stamp.revision)
    const actualModule = readdirSync(join(dir, 'out')).map(name => join(dir, 'out', name))
      .find(candidate => createHash('sha256').update(readFileSync(candidate)).digest('hex') === before.moduleSha256)
    assert.ok(actualModule, 'fingerprint matches an actual emitted module even with code splitting')
    writeFileSync(actualModule, 'export const unrelated = true')
    assert.deepEqual(loaded.RUNTIME_PROVENANCE, before, 'running process retains its captured identity')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent runs and retries keep separate identities; probes cannot reassign tools', async () => {
  await Promise.all(['a', 'b'].map(id => withRuntimeRun({ runId: 'run-' + id, sessionId: id }, async () => {
    recordRuntimeRequest({ sessionId: id, requestId: 'request-' + id, purpose: 'main_execution' }, 'attempt-1-' + id)
    await new Promise(resolve => setImmediate(resolve))
    recordRuntimeRequest({ sessionId: 'other', requestId: 'wrong', purpose: 'main_execution' }, 'wrong')
    recordRuntimeRequest({ sessionId: id, requestId: 'probe', purpose: 'provider_probe' }, 'probe')
    assert.equal(runtimeObservation().requestId, 'request-' + id)
    recordRuntimeRequest({ sessionId: id, requestId: 'request-' + id, purpose: 'main_execution' }, 'attempt-2-' + id)
    assert.equal(runtimeObservation().attemptId, 'attempt-2-' + id)
    assert.equal(runtimeObservation().runId, 'run-' + id)
  })))
  assert.equal(runtimeObservation().runId, undefined)
  assert.equal(runtimeObservation().requestId, undefined)
})
