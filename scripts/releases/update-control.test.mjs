import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CONTROL_URLS, canonical, digest, bucket, validateControl, chooseControl, selectRelease, transition } from './update-control.mjs'
import { publishTransaction, readRemote, main, verifyPromotionReadiness, buildLegacyOssManifest } from './publish-update-control.mjs'
import { summarizeRouting } from './report-routing.mjs'
import { guardStablePublication } from './guard-stable-publication.mjs'
import { CATALOG_URLS } from './catalog.mjs'

const fixture = () => ({ schemaVersion: 1, revision: 1, stable: { version: '3.29.2', catalogSha256: 'a'.repeat(64) }, candidate: { version: '3.30.0', catalogSha256: 'b'.repeat(64), platforms: { 'darwin-aarch64': { status: 'active', percentage: 0 }, 'windows-x86_64': { status: 'active', percentage: 0 } } }, revokedVersions: [] })
const catalog = () => ({ version: '3.30.0', artifacts: ['darwin-aarch64', 'windows-x86_64'].map(platform => ({ platform, purpose: 'update', sha256: 'c'.repeat(64) })) })
const evidence = () => ({ version: '3.30.0', platforms: Object.fromEntries(catalog().artifacts.map(a => [a.platform, { sha256: a.sha256, passed: true, checkedAt: '2026-10-09T00:00:00Z', conclusion: 'Installed signed package on a real test machine', realSignedUpgrade: true }])) })
const promotionPlatforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']
const atomgitURL = (version, name) => `https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness/releases/v${version}/attach_files/${name}/download`
const githubURL = (version, name) => `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${version}/${name}`
const ossURL = (version, name) => `https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${version}/${name}`
function promotionFixture(version = '3.30.0') {
  const remote = new Map(), calls = [], artifacts = [], packageURLs = {}
  for (const platform of promotionPlatforms) {
    const arch = platform.endsWith('x86_64') ? 'x64' : 'aarch64'
    const fileName = `Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : `${arch}.app.tar.gz`}`
    const body = Buffer.from(`signed update package for ${version} ${platform}\n`), sha256 = digest(body), signature = `signature-${platform}`
    const urls = { atomgit: atomgitURL(version, fileName), github: githubURL(version, fileName), oss: ossURL(version, fileName) }
    packageURLs[platform] = urls
    for (const url of Object.values(urls)) remote.set(url, body)
    const source = (url, anonymous) => ({ url, verified: true, ...(anonymous ? { anonymous: true } : {}), verifiedAt: '2026-10-24T00:00:00Z', size: body.length, sha256 })
    artifacts.push({ platform, purpose: 'update', fileName, size: body.length, sha256, signature, sources: { atomgit: source(urls.atomgit, true), github: source(urls.github, false), oss: { url: urls.oss, verified: false } } })
  }
  const value = { schemaVersion: 1, revision: 1, version, publishedAt: '2026-10-24T00:00:00Z', artifacts }
  const catalogBytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const release = { version, catalogSha256: digest(catalogBytes) }
  const manifestURLs = { atomgit: atomgitURL(version, 'latest.json'), github: githubURL(version, 'latest.json') }
  for (const source of ['atomgit', 'github']) {
    const manifest = { version, notes: '', pub_date: value.publishedAt, platforms: Object.fromEntries(artifacts.map(asset => [asset.platform, { url: asset.sources[source].url, signature: asset.signature }])) }
    remote.set(manifestURLs[source], Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  }
  const catalogURLs = { atomgit: atomgitURL(version, 'release-catalog.json'), github: githubURL(version, 'release-catalog.json'), oss: ossURL(version, 'release-catalog.json') }
  for (const url of Object.values(catalogURLs)) remote.set(url, catalogBytes)
  const request = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const body = remote.get(String(url))
    if (!body) return new Response(null, { status: 404 })
    const range = options.headers?.Range
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!match) return new Response(null, { status: 400 })
      const start = Number(match[1]), end = Number(match[2])
      return new Response(body.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } })
    }
    return new Response(body, { status: 200 })
  }
  return { catalog: value, catalogBytes, release, remote, request, calls, packageURLs, manifestURLs, catalogURLs, probeTag: async () => `fixture\trefs/tags/v${version}` }
}
const readiness = fixture => verifyPromotionReadiness(fixture.release, { catalogBytes: fixture.catalogBytes, request: fixture.request, probeTag: fixture.probeTag })
function controlFixture() {
  const stable = promotionFixture('3.29.2'), candidate = promotionFixture('3.30.0')
  const control = { schemaVersion: 1, revision: 7, stable: stable.release, candidate: { ...candidate.release, platforms: Object.fromEntries(promotionPlatforms.map(platform => [platform, { status: 'active', percentage: 100 }])) }, revokedVersions: [] }
  const acceptance = { version: candidate.release.version, platforms: Object.fromEntries(candidate.catalog.artifacts.map(asset => [asset.platform, { sha256: asset.sha256, passed: true, checkedAt: '2026-10-24T00:00:00Z', conclusion: 'Signed upgrade fixture', realSignedUpgrade: true }])) }
  const controlBytes = Buffer.from(canonical(control) + '\n')
  const fetcher = async (url, options = {}) => {
    const href = String(url)
    if (options.method && options.method !== 'GET') throw new Error('unexpected remote write')
    if (href.includes('api.github.com/') && href.includes('/releases/tags/')) return new Response(JSON.stringify({ draft: false, prerelease: true }))
    if (href.endsWith('update-control.json')) return new Response(controlBytes)
    if (href === stable.catalogURLs.github) return new Response(stable.catalogBytes)
    if (href === candidate.catalogURLs.github) return new Response(candidate.catalogBytes)
    if ([CATALOG_URLS[0], CATALOG_URLS[1]].includes(href)) return new Response(stable.catalogBytes)
    if (href.endsWith('/latest.json')) return new Response(stable.remote.get(stable.manifestURLs.github))
    return new Response(null, { status: 404 })
  }
  return { stable, candidate, control, acceptance, fetcher }
}
function writeControlWorkspace(dir, f) {
  writeFileSync(join(dir, 'catalog.json'), f.candidate.catalogBytes)
  writeFileSync(join(dir, 'release-catalog.json'), f.candidate.catalogBytes)
  writeFileSync(join(dir, 'latest.json'), f.candidate.remote.get(f.candidate.manifestURLs.github))
  writeFileSync(join(dir, 'acceptance.json'), JSON.stringify(f.acceptance))
}
test('cohorts are stable, nested, platform-specific and equal to Rust golden vector', () => {
  assert.equal(bucket('fixture', '3.30.0', 'darwin-aarch64'), 8371)
  assert.notEqual(bucket('fixture', '3.30.0', 'darwin-aarch64'), bucket('fixture', '3.30.0', 'windows-x86_64'))
  for (const percentage of [0, 1, 5, 20, 50, 100]) {
    const c = fixture(); c.candidate.platforms['darwin-aarch64'].percentage = percentage
    assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture').channel, percentage > 83 ? 'candidate' : 'stable')
    assert.equal(selectRelease(c, 'darwin-aarch64', undefined).channel, 'stable')
  }
})
test('manual and preview selection never bypass pauses, missing platforms or revocation', () => {
  const c = fixture()
  assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture', true).channel, 'preview')
  assert.equal(selectRelease(c, 'linux-x86_64', 'fixture', true).channel, 'stable')
  c.candidate.platforms['darwin-aarch64'].status = 'paused'
  assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture', true).channel, 'stable')
  const revoked = transition(c, 'revoke')
  assert.equal(selectRelease(revoked, 'windows-x86_64', 'fixture', true).channel, 'stable')
  assert.throws(() => transition(revoked, 'resume'), /cannot reopen/)
})
test('control chooses revision, rejects conflicting content, rollback and lost revocations', () => {
  const c = fixture(), next = transition(c, 'pause')
  assert.equal(chooseControl([c, next]).revision, 2)
  assert.throws(() => chooseControl([c], next), /ROLLBACK/)
  const conflict = structuredClone(c); conflict.candidate.platforms['darwin-aarch64'].percentage = 1
  assert.throws(() => chooseControl([c, conflict]), /CONFLICT/)
  const revoked = transition(c, 'revoke'); next.revision = 3
  assert.throws(() => chooseControl([next], revoked), /REVOKED_REMOVED/)
  assert.throws(() => validateControl({ ...c, revision: 0 }))
  assert.throws(() => validateControl({ ...c, revokedVersions: Array(30000).fill('3.0.0') }))
})
test('release transitions require matching evidence and refuse reductions or premature promotion', () => {
  const c = fixture(), options = { catalog: catalog(), evidence: evidence(), percentage: 5 }
  assert.throws(() => transition(c, 'set-percentage', { ...options, evidence: undefined }), /Acceptance/)
  assert.throws(() => transition(c, 'set-percentage', { ...options, catalog: { ...catalog(), version: '3.31.0' } }), /version differs/)
  const five = transition(c, 'set-percentage', options)
  assert.throws(() => transition(five, 'set-percentage', { ...options, percentage: 1 }), /Pause/)
  assert.throws(() => transition(five, 'promote', options), /100%/)
  const hundred = transition(five, 'set-percentage', { ...options, percentage: 100 })
  const bad = evidence(); bad.platforms['windows-x86_64'].realSignedUpgrade = false
  assert.throws(() => transition(hundred, 'promote', { ...options, evidence: bad }), /Real signed/)
  const promoted = transition(hundred, 'promote', options)
  assert.equal(promoted.stable.version, '3.30.0'); assert.equal(promoted.candidate, undefined)
  const paused = transition(five, 'pause', { platforms: ['darwin-aarch64'] })
  assert.equal(paused.candidate.platforms['windows-x86_64'].status, 'active')
  assert.equal(transition(paused, 'resume', { platforms: ['darwin-aarch64'] }).candidate.platforms['darwin-aarch64'].percentage, 5)
})
test('promotion readiness passes three platforms with anonymous AtomGit/GitHub/OSS packages and pinned metadata', async () => {
  const f = promotionFixture(), result = await readiness(f)
  assert.deepEqual(result.verifiedPlatforms, promotionPlatforms)
  const packages = new Set(Object.values(f.packageURLs).flatMap(urls => Object.values(urls)))
  assert.equal(f.calls.filter(call => !call.options.headers?.Range && packages.has(call.url)).length, 9)
  assert.equal(f.calls.filter(call => call.options.headers?.Range).length, 14, '九包 + 三目录 + 两 manifest 都要精确 Range')
  for (const call of f.calls) {
    assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.headers.Authorization, undefined)
    assert.equal(call.options.headers.Cookie, undefined)
  }
})
test('promotion refuses to expose a legacy OSS manifest without qualified OSS package bytes', async () => {
  const f = promotionFixture()
  f.remote.delete(f.packageURLs['windows-x86_64'].oss)
  await assert.rejects(readiness(f), /oss-package/)
})
test('legacy OSS manifest keeps platform signatures and points only to qualified OSS assets', () => {
  const f = promotionFixture(), manifest = JSON.parse(f.remote.get(f.manifestURLs.github))
  const bytes = buildLegacyOssManifest(manifest, f.catalog)
  const output = JSON.parse(bytes)
  for (const asset of f.catalog.artifacts) {
    assert.equal(output.platforms[asset.platform].url, asset.sources.oss.url)
    assert.equal(output.platforms[asset.platform].signature, asset.signature)
  }
  const mismatched = structuredClone(manifest)
  mismatched.platforms['windows-x86_64'].signature = 'wrong'
  assert.throws(() => buildLegacyOssManifest(mismatched, f.catalog), /identity differs/)
  delete mismatched.platforms['darwin-aarch64']
  assert.throws(() => buildLegacyOssManifest(mismatched, f.catalog), /coverage differs/)
})
test('promotion readiness requires a mirrored AtomGit tag and distinguishes probe failure', async t => {
  for (const [name, probeTag, expected] of [
    ['missing tag', async () => '', /version tag is missing/],
    ['probe failure', async () => { throw new Error('offline') }, /anonymous tag probe failed/],
  ]) await t.test(name, async () => {
    const f = promotionFixture(); f.probeTag = probeTag
    await assert.rejects(readiness(f), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /https:\/\/atomgit\.com\/huiliyi37\/Tianshu-harness\.git#refs\/tags\/v3\.30\.0/)
      assert.ok(error.issues.some(issue => issue.check === 'atomgit-tag'))
      return true
    })
  })
})
test('promotion readiness aggregates missing package, catalog and manifest endpoints', async t => {
  const cases = [
    ['atomgit', 'package'], ['github', 'package'], ['oss', 'package'], ['atomgit', 'manifest'], ['github', 'manifest'], ['oss', 'catalog'],
  ]
  for (const [source, kind] of cases) await t.test(`${source} ${kind}`, async () => {
    const f = promotionFixture(), platform = 'windows-x86_64'
    const url = kind === 'package' ? f.packageURLs[platform][source] : kind === 'manifest' ? f.manifestURLs[source] : f.catalogURLs[source]
    f.remote.delete(url)
    await assert.rejects(readiness(f), error => {
      const check = kind === 'package' ? `${source}-package` : kind === 'manifest' ? `${source}-manifest` : 'oss-catalog'
      assert.ok(error.issues.some(issue => issue.check === check && issue.url === url), error.message)
      assert.match(error.message, kind === 'package' ? /windows-x86_64/ : /all/)
      assert.ok(error.message.includes(url), '错误必须含稳定公开端点而非临时重定向 URL')
      return true
    })
  })
})
test('promotion readiness preserves platform and public endpoint on anonymous and Range failures', async t => {
  for (const mode of ['anonymous', 'range']) await t.test(mode, async () => {
    const f = promotionFixture(), target = f.packageURLs['darwin-aarch64'].atomgit, original = f.request
    f.request = async (url, options = {}) => {
      if (String(url) === target && mode === 'anonymous' && !options.headers?.Range) throw new Error('offline')
      if (String(url) === target && mode === 'range' && options.headers?.Range) return new Response(f.remote.get(target), { status: 200 })
      return original(url, options)
    }
    await assert.rejects(readiness(f), error => {
      assert.ok(error.issues.some(issue => issue.platform === 'darwin-aarch64' && issue.check === 'atomgit-package' && issue.url === target), error.message)
      assert.match(error.message, mode === 'anonymous' ? /anonymous request failed/ : /HTTP 206/)
      return true
    })
  })
})
test('promotion manifests must match version, exact platforms, URLs and updater signatures', async () => {
  const f = promotionFixture()
  const atomgit = JSON.parse(f.remote.get(f.manifestURLs.atomgit)); atomgit.version = '3.29.2'
  f.remote.set(f.manifestURLs.atomgit, Buffer.from(JSON.stringify(atomgit)))
  const github = JSON.parse(f.remote.get(f.manifestURLs.github))
  delete github.platforms['darwin-aarch64']
  github.platforms['windows-x86_64'].url = f.packageURLs['windows-x86_64'].atomgit
  github.platforms['darwin-x86_64'].signature = 'wrong-signature'
  f.remote.set(f.manifestURLs.github, Buffer.from(JSON.stringify(github)))
  await assert.rejects(readiness(f), error => {
    assert.match(error.message, /manifest version or platform map is invalid/)
    assert.match(error.message, /darwin-aarch64 \| github-manifest .*missing manifest platform/)
    assert.match(error.message, /windows-x86_64 \| github-manifest .*manifest download URL differs/)
    assert.match(error.message, /darwin-x86_64 \| github-manifest .*manifest updater signature differs/)
    return true
  })
})
test('promotion refuses reformatted or replaced immutable catalog bytes on every pinned source', async t => {
  for (const source of ['atomgit', 'github', 'oss']) await t.test(source, async () => {
    const f = promotionFixture()
    f.remote.set(f.catalogURLs[source], Buffer.from(JSON.stringify({ ...f.catalog, revision: 2 }, null, 2) + '\n'))
    await assert.rejects(readiness(f), error => {
      assert.ok(error.issues.some(issue => issue.check === `${source}-catalog` && issue.url === f.catalogURLs[source]), error.message)
      assert.match(error.message, /sha256/)
      return true
    })
  })
})
test('dual-source publication is idempotent after a partial failure and confirms bytes', async () => {
  const tx = { next: fixture(), completed: {} }, stored = {}, uploads = [], saves = []; let fail = true
  const io = { read: async s => stored[s], upload: async (s, b) => { uploads.push(s); if (s === 'oss' && fail) throw new Error('offline'); stored[s] = b }, save: async t => saves.push(structuredClone(t)) }
  await assert.rejects(publishTransaction(tx, io), /offline/)
  assert.equal(tx.completed.github, true); assert.equal(tx.completed.oss, undefined)
  fail = false; await publishTransaction(tx, io)
  assert.deepEqual(uploads, ['github', 'oss', 'oss']); assert.equal(saves.at(-1).completed.oss, true)
  assert.equal(digest(stored.github), digest(stored.oss))
  await assert.rejects(publishTransaction({ next: fixture(), completed: {} }, { read: async () => Buffer.from(canonical({ ...fixture(), revision: 0 })), upload: async () => {}, save: async () => {} }), /Invalid update control/)
})
test('bounded local metadata service covers malformed bodies, missing sources and byte identity', async () => {
  const bytes = Buffer.from(canonical(fixture()) + '\n')
  const server = createServer((req, res) => { if (req.url === '/missing') { res.writeHead(404); res.end() } else if (req.url === '/huge') res.end(' '.repeat(256 * 1024 + 1)); else res.end(bytes) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { assert.equal(digest(await readRemote(base)), digest(bytes)); assert.equal(await readRemote(base + '/missing'), undefined); await assert.rejects(readRemote(base + '/huge'), /256 KiB/) }
  finally { await new Promise(resolve => server.close(resolve)) }
})
test('production publisher isolates candidate operations from legacy writes and website refresh', () => {
  const source = readFileSync(new URL('./publish-update-control.mjs', import.meta.url), 'utf8')
  const promotion = source.slice(source.indexOf("if (operation === 'promote' && !transaction.completed.promotion)"), source.indexOf("} else if (operation !== 'promote')"))
  assert.ok(promotion.includes("'--prerelease=false'")); assert.ok(promotion.includes('publish-routing.mjs')); assert.ok(promotion.includes('legacyPath'))
  assert.ok(!promotion.includes("['cp', 'latest.json'"), 'old clients must receive an OSS-routed manifest')
  const before = source.slice(0, source.indexOf("if (operation === 'promote' && !transaction.completed.promotion)"))
  assert.ok(!before.includes("run(process.execPath, ['scripts/releases/publish-routing.mjs'"))
  assert.ok(source.indexOf('if (!publish) return') < source.indexOf('saveFile(txPath, transaction)'))
  assert.ok(source.includes('Stable entry changed during candidate publication'))
})
test('local upgrade report keeps the last result per attempt and retains diagnostics', () => {
  const report=summarizeRouting([
    {event:'policy_selected',detail:{channel:'preview',policyRevision:2,platform:'darwin-aarch64'}},
    {event:'upgrade_attempt',detail:{attemptId:'a',status:'preparing',fromVersion:'3.29.2',toVersion:'3.30.0'}},
    {event:'upgrade_result',detail:{attemptId:'a',status:'installer_returned'}},
    {event:'upgrade_result',detail:{attemptId:'a',status:'confirmed'}},
    {event:'install_failed',detail:{code:'UPDATE_POLICY_PAUSED',stage:'policy'}},
    {event:'slow_download',source:'atomgit',receivedBytes:40},
    {event:'download_failed',source:'github',receivedBytes:80},
  ])
  assert.equal(report.upgrades.length,1); assert.equal(report.upgrades[0].status,'confirmed')
  assert.equal(report.selections[0].policyRevision,2); assert.equal(report.failures[0].stage,'policy')
  assert.equal(report.sources.atomgit.failed,1); assert.equal(report.sources.atomgit.receivedBytes,40)
  assert.equal(report.sources.github.failed,1); assert.equal(report.sources.github.receivedBytes,80)
})
test('failed promotion readiness creates no transaction and calls no remote write command', async () => {
  const f = controlFixture(), dir = mkdtempSync(join(tmpdir(), 'tianshu-promotion-gate-')), oldCwd = process.cwd()
  let readinessCalls = 0, writeCalls = 0
  try {
    process.chdir(dir); writeControlWorkspace(dir, f)
    const before = readdirSync(dir)
    await assert.rejects(main(['promote', '--catalog', 'catalog.json', '--acceptance', 'acceptance.json', '--release-notes-reviewed', '--publish'], {
      fetch: f.fetcher,
      verifyPromotionReadiness: async () => { readinessCalls++; throw new Error('readiness blocked') },
      run: () => { writeCalls++; return Buffer.from('{"isPrerelease":true,"isDraft":false}') },
    }), /readiness blocked/)
    assert.equal(readinessCalls, 1)
    assert.equal(writeCalls, 0, '门禁失败前不得调用 gh/ossutil/routing')
    assert.deepEqual(readdirSync(dir), before, '门禁失败前不得创建事务或控制快照')
    assert.ok(!existsSync(join(dir, 'release/update-control-transaction.json')))
  } finally { process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true }) }
})
test('promotion publishes an OSS-routed legacy manifest after package readiness', async () => {
  const f = controlFixture(), dir = mkdtempSync(join(tmpdir(), 'tianshu-legacy-promote-')), oldCwd = process.cwd(), oldLog = console.log
  const githubLatest = `https://github.com/huiliyi37/Tianshu-harness/releases/latest/download/latest.json`
  const ossLatest = 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'
  const remote = new Map([...f.stable.remote, ...f.candidate.remote])
  const currentControl = Buffer.from(canonical(f.control) + '\n')
  for (const url of CONTROL_URLS) remote.set(url, currentControl)
  for (const url of CATALOG_URLS) remote.set(url, f.stable.catalogBytes)
  remote.set(githubLatest, f.stable.remote.get(f.stable.manifestURLs.github))
  remote.set(ossLatest, f.stable.remote.get(f.stable.manifestURLs.github))
  let readinessCalls = 0
  const fetcher = async url => {
    const href = String(url)
    if (href.includes('api.github.com/') && href.includes('/releases/tags/')) return new Response(JSON.stringify({ draft: false, prerelease: true }))
    const body = remote.get(href)
    return body ? new Response(body) : new Response(null, { status: 404 })
  }
  const run = (command, args) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'view') return Buffer.from(args.includes('--json') ? '{"isPrerelease":true,"isDraft":false}' : 'ok')
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') { remote.set(CONTROL_URLS[1], readFileSync(args[3])); return Buffer.alloc(0) }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'edit') { remote.set(githubLatest, f.candidate.remote.get(f.candidate.manifestURLs.github)); return Buffer.alloc(0) }
    if (command === process.execPath && args[0] === 'scripts/releases/publish-routing.mjs') { for (const url of CATALOG_URLS) remote.set(url, f.candidate.catalogBytes); return Buffer.alloc(0) }
    if (args[0] === 'cp') {
      const target = args[2]
      const url = target.endsWith('/update-control.json') ? CONTROL_URLS[0] : target.endsWith('/latest.json') ? ossLatest : f.candidate.catalogURLs.oss
      remote.set(url, readFileSync(args[1]))
      return Buffer.alloc(0)
    }
    throw new Error(`Unexpected publication command: ${command} ${args.join(' ')}`)
  }
  try {
    process.chdir(dir); writeControlWorkspace(dir, f); console.log = () => {}
    await main(['promote', '--catalog', 'catalog.json', '--acceptance', 'acceptance.json', '--release-notes-reviewed', '--publish', '--transaction', 'transaction.json'], {
      fetch: fetcher, run, verifyPromotionReadiness: async () => { readinessCalls++; return { verifiedPlatforms: promotionPlatforms } },
    })
    assert.equal(readinessCalls, 1)
    const legacy = JSON.parse(remote.get(ossLatest))
    for (const asset of f.candidate.catalog.artifacts) {
      assert.equal(legacy.platforms[asset.platform].url, asset.sources.oss.url)
      assert.equal(legacy.platforms[asset.platform].signature, asset.signature)
    }
    assert.equal(JSON.parse(remote.get(CONTROL_URLS[0])).stable.version, f.candidate.release.version)
  } finally { console.log = oldLog; process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true }) }
})
test('emergency pause and revoke never invoke the new promotion readiness gate', async () => {
  const f = controlFixture(), dir = mkdtempSync(join(tmpdir(), 'tianshu-emergency-control-')), oldCwd = process.cwd(), oldLog = console.log
  let readinessCalls = 0
  try {
    process.chdir(dir); writeControlWorkspace(dir, f); console.log = () => {}
    for (const operation of ['pause', 'revoke']) await main([operation, '--catalog', 'catalog.json'], {
      fetch: f.fetcher,
      verifyPromotionReadiness: async () => { readinessCalls++; throw new Error('emergency operation must not be blocked') },
      run: () => { throw new Error('dry run must not write') },
    })
    assert.equal(readinessCalls, 0)
  } finally { console.log = oldLog; process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true }) }
})
test('production dry run validates prerelease and creates no files or remote writes', async () => {
  const makeCatalog = version => ({ schemaVersion:1, revision:1, version, publishedAt:'2026-10-09T00:00:00Z', artifacts:['windows-x86_64','darwin-aarch64'].map(platform => {
    const fileName=`Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : 'aarch64.app.tar.gz'}`
    return {platform,purpose:'update',fileName,size:100,sha256:'c'.repeat(64),signature:'test-signature',sources:{github:{url:`https://github.com/huiliyi37/Tianshu-harness/releases/download/v${version}/${fileName}`,verified:true,size:100,sha256:'c'.repeat(64),verifiedAt:'2026-10-09T00:00:00Z'}}}
  }) })
  const stableBytes=Buffer.from(JSON.stringify(makeCatalog('3.29.2'))), candidateBytes=Buffer.from(JSON.stringify(makeCatalog('3.30.0')))
  const control={schemaVersion:1,revision:1,stable:{version:'3.29.2',catalogSha256:digest(stableBytes)},revokedVersions:[]}
  const dir=mkdtempSync(join(tmpdir(),'tianshu-control-cli-')), oldCwd=process.cwd(), oldFetch=globalThis.fetch, oldLog=console.log
  let prerelease=true; const calls=[], messages=[]
  try {
    process.chdir(dir);writeFileSync('catalog.json',candidateBytes);writeFileSync('acceptance.json',JSON.stringify(evidence()))
    const before=readdirSync(dir)
    globalThis.fetch=async (url, options) => {
      assert.ok(!options?.method || options.method==='GET');calls.push(String(url))
      if (url.includes('/releases/tags/')) return new Response(JSON.stringify({draft:false,prerelease}))
      if (url.endsWith('update-control.json')) return new Response(JSON.stringify(control))
      if (url.includes('/v3.30.0/')) return new Response(candidateBytes)
      return new Response(stableBytes)
    }
    console.log = text => messages.push(text)
    await main(['stage','--catalog','catalog.json','--acceptance','acceptance.json','--platforms','windows-x86_64,darwin-aarch64'])
    assert.deepEqual(readdirSync(dir),before);assert.equal(JSON.parse(messages[0]).next.candidate.platforms['windows-x86_64'].percentage,0)
    prerelease=false;await assert.rejects(main(['stage','--catalog','catalog.json','--acceptance','acceptance.json','--platforms','windows-x86_64']),/prerelease/)
    assert.ok(calls.some(url=>url.includes('/releases/latest/download/latest.json')))
  } finally { globalThis.fetch=oldFetch;console.log=oldLog;process.chdir(oldCwd);rmSync(dir,{recursive:true,force:true}) }
})
test('old publishers cannot expose a candidate or replace a pinned stable catalog', async () => {
  const c=fixture(), fetcher=async () => new Response(JSON.stringify(c))
  await guardStablePublication('3.29.2',undefined,fetcher)
  await assert.rejects(guardStablePublication('3.30.0',undefined,fetcher),/controlled stable/)
  await assert.rejects(guardStablePublication('3.29.2',Buffer.from('{}'),fetcher),/Invalid release catalog/)
})

const legacyPublisher = new URL('../upload-update-to-oss.sh', import.meta.url)
test('private OSS publisher guards metadata before its first write', {
  skip: !existsSync(legacyPublisher) && 'Private OSS publisher is not included in this public source checkout',
}, () => {
  const shell=readFileSync(legacyPublisher,'utf8')
  const guard = shell.indexOf('guard-stable-publication.mjs'), upload = shell.indexOf('"$OSSUTIL" cp')
  const assetsDone = shell.indexOf('候选资产上传完成'), latestWrite = shell.indexOf('cp "$WORK/latest-oss.json"')
  assert.ok(guard >= 0 && guard < upload)
  assert.ok(assetsDone >= 0 && assetsDone < latestWrite)
})
