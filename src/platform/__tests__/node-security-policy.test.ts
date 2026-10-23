import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSecureNodeVersion } from '../node-security-policy.js'

test('only patched supported Node lines pass', () => {
  for (const version of ['24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(isSecureNodeVersion(version), true, version)
  }
  for (const version of ['24.18.0', '24.22.0', '26.12.0', '22.23.4', '25.0.0', '27.0.0', '24.22.1-rc.1', 'garbage']) {
    assert.equal(isSecureNodeVersion(version), false, version)
  }
})

test('npm metadata advertises the same supported Node lines', () => {
  const root = new URL('../../../', import.meta.url)
  const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { engines: { node: string } }
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as { packages: { '': { engines: { node: string } } } }
  assert.equal(packageJson.engines.node, '^24.22.1 || ^26.12.1')
  assert.equal(lock.packages[''].engines.node, packageJson.engines.node)
})

test('CLI operational entry points run the Node security gate', () => {
  const entry = readFileSync(new URL('../../cli/entry.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(entry, /requireSecureNodeRuntime\(\)/)
  assert.match(main, /requireSecureNodeRuntime\(\)/)
  assert.ok(entry.indexOf('requireSecureNodeRuntime()') < entry.indexOf('await routeEarlyCli(args)'))
  assert.ok(main.indexOf('requireSecureNodeRuntime()') < main.indexOf('await routeEarlyCli(args)'))
})

test('both bundled runtime fetchers check the requested version', () => {
  for (const path of ['../../../scripts/fetch-node-runtime.js', '../../../desktop/scripts/fetch-node-runtime.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /assertSecureNodeVersion\(/, path)
  }
})

test('CLI launcher refuses an unsafe runtime before routing commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-node-security-'))
  try {
    const preload = join(root, 'pretend-old-node.mjs')
    writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '24.22.0' })\n")
    const entry = fileURLToPath(new URL('../../cli/entry.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', entry, '--list'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, RIVET_HOME: root },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Node\.js v24\.22\.0 is not a supported security release/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('desktop fetcher rejects an unsafe NODE_VERSION before download', () => {
  const script = fileURLToPath(new URL('../../../desktop/scripts/fetch-node-runtime.js', import.meta.url))
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, NODE_VERSION: '24.18.0' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /desktop bundled runtime: Node\.js v24\.18\.0/)
})

test('legacy desktop shell fetcher delegates to the guarded JS fetcher', () => {
  const source = readFileSync(new URL('../../../desktop/scripts/fetch-node-runtime.sh', import.meta.url), 'utf8')
  assert.match(source, /exec node scripts\/fetch-node-runtime\.js/)
  assert.doesNotMatch(source, /curl -fsSL/)
})
