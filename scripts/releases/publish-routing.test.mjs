import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main as publishRouting } from './publish-routing.mjs'
import { verifyPromotionReadiness } from './publish-update-control.mjs'
import { pinnedOssCatalogObject, pinnedOssCatalogURL } from './pinned-oss-catalog.mjs'
import { digest } from './update-control.mjs'

const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']
const atomgitURL = (version, name) => `https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness/releases/v${version}/attach_files/${name}/download`
const githubURL = (version, name) => `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${version}/${name}`
const ossURL = (version, name) => `https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${version}/${name}`

function fixture() {
  const version = '3.30.0', remote = new Map(), artifacts = []
  for (const platform of platforms) {
    const arch = platform.endsWith('x86_64') ? 'x64' : 'aarch64'
    const fileName = `Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : `${arch}.app.tar.gz`}`
    const body = Buffer.from(`signed ${platform} package\n`), sha256 = digest(body), signature = `signature-${platform}`
    const atomgit = atomgitURL(version, fileName), github = githubURL(version, fileName), oss = ossURL(version, fileName)
    remote.set(atomgit, body); remote.set(github, body); remote.set(oss, body)
    const source = (url, anonymous = false) => ({ url, verified: true, ...(anonymous ? { anonymous: true } : {}), verifiedAt: '2026-10-24T00:00:00Z', size: body.length, sha256 })
    artifacts.push({ platform, purpose: 'update', fileName, size: body.length, sha256, signature, sources: { atomgit: source(atomgit, true), github: source(github), oss: { url: oss, verified: false } } })
  }
  const catalog = { schemaVersion: 1, revision: 1, version, publishedAt: '2026-10-24T00:00:00Z', artifacts }
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n')
  const manifests = {}
  for (const source of ['atomgit', 'github']) {
    const manifest = { version, notes: '', pub_date: catalog.publishedAt, platforms: Object.fromEntries(artifacts.map(asset => [asset.platform, { url: asset.sources[source].url, signature: asset.signature }])) }
    manifests[source] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    remote.set(source === 'atomgit' ? atomgitURL(version, 'latest.json') : githubURL(version, 'latest.json'), manifests[source])
  }
  remote.set(atomgitURL(version, 'release-catalog.json'), catalogBytes)
  remote.set(githubURL(version, 'release-catalog.json'), catalogBytes)
  const control = { schemaVersion: 1, revision: 1, stable: { version, catalogSha256: digest(catalogBytes) }, revokedVersions: [] }
  return { version, catalog, catalogBytes, latestBytes: manifests.github, remote, controlBytes: Buffer.from(JSON.stringify(control) + '\n') }
}

async function withHarness(options, runTest) {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'tianshu-routing-production-')), oldCwd = process.cwd()
  const pinnedURL = pinnedOssCatalogURL(f.version), pinnedObject = pinnedOssCatalogObject(f.version)
  const rootObject = 'oss://tianshu-update/tianshu/release-catalog.json'
  if (options.pinned === 'same') f.remote.set(pinnedURL, f.catalogBytes)
  if (options.pinned === 'conflict') f.remote.set(pinnedURL, Buffer.from(JSON.stringify({ ...f.catalog, revision: 2 }) + '\n'))
  const events = [], writes = [], logs = []
  const read = async url => { events.push(`read ${url}`); return f.remote.get(url) }
  const fetcher = async () => new Response(f.controlBytes)
  const run = (command, args) => {
    writes.push({ command, args })
    if (command.includes('ossutil')) {
      const target = args[2]; events.push(`write ${target}`)
      if (target === pinnedObject) f.remote.set(pinnedURL, options.readback === 'wrong' ? Buffer.from(JSON.stringify({ ...f.catalog, revision: 3 })) : f.catalogBytes)
      if (target === rootObject) f.remote.set('https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/release-catalog.json', f.catalogBytes)
    } else events.push(`write ${command} ${args.join(' ')}`)
    if (command === 'git') return Buffer.from('git@github.com:huiliyi37/tianshu-website.git')
    return Buffer.from('')
  }
  const request = async (url, requestOptions = {}) => {
    const body = f.remote.get(String(url))
    if (!body) return new Response(null, { status: 404 })
    const range = requestOptions.headers?.Range
    if (range) {
      const [start, end] = range.replace('bytes=', '').split('-').map(Number)
      return new Response(body.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
    }
    return new Response(body, { status: 200 })
  }
  writeFileSync(join(dir, 'release-catalog.json'), f.catalogBytes)
  writeFileSync(join(dir, 'latest.json'), f.latestBytes)
  try {
    process.chdir(dir)
    await runTest({ ...f, dir, pinnedURL, pinnedObject, rootObject, events, writes, logs, request, dependencies: { read, fetch: fetcher, run, log: message => logs.push(message) } })
  } finally { process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true }) }
}

test('publish-routing publishes and reads back version-pinned OSS before other metadata, then promotion readiness passes', async () => {
  await withHarness({ pinned: 'missing' }, async h => {
    assert.equal(h.remote.has(h.pinnedURL), false)
    const result = await publishRouting(['--publish', '--website', 'fixture-website'], h.dependencies)
    assert.equal(result.status, 'uploaded')
    const upload = h.events.indexOf(`write ${h.pinnedObject}`), readback = h.events.indexOf(`read ${h.pinnedURL}`, upload + 1)
    const github = h.events.findIndex(event => event.startsWith('write gh release upload'))
    const root = h.events.indexOf(`write ${h.rootObject}`)
    assert.ok(upload >= 0 && readback > upload, h.events.join('\n'))
    assert.ok(github > readback && root > readback, '固定目录回读必须先于 GitHub/根 OSS 元数据写入')
    const readiness = await verifyPromotionReadiness({ version: h.version, catalogSha256: digest(h.catalogBytes) }, { catalogBytes: h.catalogBytes, request: h.request, probeTag: async () => 'fixture\trefs/tags/v3.30.0' })
    assert.deepEqual(readiness.verifiedPlatforms, platforms)
  })
})

test('existing identical version-pinned OSS catalog is reused without another upload', async () => {
  await withHarness({ pinned: 'same' }, async h => {
    const result = await publishRouting(['--publish', '--website', 'fixture-website'], h.dependencies)
    assert.equal(result.status, 'unchanged')
    assert.equal(h.writes.filter(call => call.args[2] === h.pinnedObject).length, 0)
    assert.ok(h.writes.some(call => call.args[2] === h.rootObject), '根目录仍按原流程发布')
  })
})

test('conflicting version-pinned OSS bytes reject before any upload or other remote write', async () => {
  await withHarness({ pinned: 'conflict' }, async h => {
    const before = h.remote.get(h.pinnedURL)
    await assert.rejects(publishRouting(['--publish', '--website', 'fixture-website'], h.dependencies), /Pinned OSS catalog cannot be replaced/)
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.remote.get(h.pinnedURL), before)
  })
})

test('version-pinned OSS upload requires anonymous readback before any later metadata write', async () => {
  await withHarness({ pinned: 'missing', readback: 'wrong' }, async h => {
    await assert.rejects(publishRouting(['--publish', '--website', 'fixture-website'], h.dependencies), /Pinned OSS catalog readback mismatch/)
    assert.deepEqual(h.writes.map(call => call.args[2]), [h.pinnedObject])
  })
})

test('dry-run probes version-pinned OSS but performs no writes and creates no files', async () => {
  await withHarness({ pinned: 'missing' }, async h => {
    const before = readdirSync(h.dir)
    const result = await publishRouting(['--website', 'fixture-website'], h.dependencies)
    assert.equal(result.status, 'missing')
    assert.ok(h.events.includes(`read ${h.pinnedURL}`))
    assert.equal(h.writes.length, 0)
    assert.deepEqual(readdirSync(h.dir), before)
    assert.match(h.logs[0], /Version-pinned OSS catalog: missing/)
  })
})
