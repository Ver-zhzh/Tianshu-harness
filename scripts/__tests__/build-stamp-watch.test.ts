import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { context } from 'esbuild'
import config from '../../tsup.config.js'

test('the configured build pipeline produces a new provenance stamp on incremental rebuild', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'build-stamp-watch-'))
  let build: Awaited<ReturnType<typeof context>> | undefined
  try {
    const source = join(cwd, 'entry.ts'), feature = join(cwd, 'feature.ts'), file = join(cwd, 'runtime.mjs')
    writeFileSync(source, `export {RUNTIME_PROVENANCE} from ${JSON.stringify(resolve('src/utils/runtime-provenance.ts'))}; export {value} from './feature';`)
    writeFileSync(feature, 'export const value = 1')
    const options = config as { define?: Record<string, string>; esbuildPlugins?: import('esbuild').Plugin[] }
    build = await context({ entryPoints: [source], outfile: file, bundle: true, format: 'esm', platform: 'node', packages: 'external',
      define: options.define, plugins: options.esbuildPlugins })
    await build.rebuild()
    const first = await import(pathToFileURL(file).href + '?first')
    const original = first.RUNTIME_PROVENANCE.buildId
    assert.notEqual(original, 'unknown')
    writeFileSync(feature, 'export const value = 2')
    await build.rebuild()
    const second = await import(pathToFileURL(file).href + '?second')
    assert.equal(second.value, 2)
    assert.notEqual(second.RUNTIME_PROVENANCE.buildId, original, 'watch builds cannot reuse a config-evaluation nonce')
    assert.equal(first.RUNTIME_PROVENANCE.buildId, original, 'old running module keeps its identity')
    assert.ok(readFileSync(file, 'utf8').includes(second.RUNTIME_PROVENANCE.buildId))
  } finally { await build?.dispose(); rmSync(cwd, { recursive: true, force: true }) }
})
