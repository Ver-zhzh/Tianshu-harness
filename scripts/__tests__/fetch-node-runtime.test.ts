import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isSecureNodeVersion } from '../../src/platform/node-security-policy.js'

const script = fileURLToPath(new URL('../fetch-node-runtime.js', import.meta.url))

test('importing the shared Node version does not fetch or create runtime resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-import-'))
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const mod = await import(${JSON.stringify(new URL('../fetch-node-runtime.js', import.meta.url).href)}); console.log(mod.DEFAULT_NODE_VERSION)`], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '24.22.1')
    assert.equal(existsSync(join(root, 'out')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI fetch entry reuses a complete cached Node payload without desktop source', { skip: !isSecureNodeVersion(process.versions.node) }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-cache-'))
  try {
    const token = process.platform === 'win32' ? 'win' : process.platform
    const payload = join(root, `${token}-${process.arch}`)
    mkdirSync(payload)
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    cpSync(process.execPath, join(payload, nodeName))
    writeFileSync(join(payload, '.node-version'), process.versions.node)
    const result = spawnSync(process.execPath, [script, root], { env: { ...process.env, NODE_VERSION: process.versions.node, TAURI_ENV_TARGET_TRIPLE: '' }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const probe = spawnSync(join(payload, nodeName), ['-p', 'process.versions.node'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    assert.equal(probe.stdout.trim(), process.versions.node)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI fetch entry rejects an unsafe NODE_VERSION before touching cached resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-unsafe-'))
  try {
    const result = spawnSync(process.execPath, [script, root], {
      env: { ...process.env, NODE_VERSION: '24.18.0', TAURI_ENV_TARGET_TRIPLE: '' },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not a supported security release/)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cache marker from a different Node version forces a fresh download', () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-stale-marker-'))
  try {
    const token = process.platform === 'win32' ? 'win' : process.platform
    const payload = join(root, `${token}-${process.arch}`)
    mkdirSync(payload)
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    cpSync(process.execPath, join(payload, nodeName))
    writeFileSync(join(payload, '.node-version'), '24.18.0')
    // Abort the download without touching the network: if the stale marker were
    // trusted, the script would print "already staged" and exit 0 instead.
    const preload = join(root, 'fail-fetch.mjs')
    writeFileSync(preload, "globalThis.fetch = async () => new Response('not found', { status: 404 })\n")
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, root], {
      env: { ...process.env, NODE_VERSION: '24.99.99', TAURI_ENV_TARGET_TRIPLE: '' },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Node download failed: HTTP 404/)
    assert.doesNotMatch(result.stderr, /already staged/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
