import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const mutations = [
  ['paused preview bypass', 'update-control.mjs', "r?.status === 'active'", 'true', /manual and preview selection/],
  ['revision rollback', 'update-control.mjs', 'next.revision < previous.revision', 'false', /control chooses revision/],
  ['revocation removed', 'update-control.mjs', '!previous.revokedVersions.every(v => next.revokedVersions.includes(v))', 'false', /control chooses revision/],
  ['percentage reduction', 'update-control.mjs', 'options.percentage < c.platforms[p].percentage', 'false', /release transitions require/],
  ['legacy stable bypass', 'guard-stable-publication.mjs', 'if (control.stable.version !== version)', 'if (false)', /old publishers/],
  ['promotion without real upgrade', 'update-control.mjs', 'realUpgrade && e.realSignedUpgrade !== true', 'false', /release transitions require/],
  ['promotion skips AtomGit packages', 'publish-update-control.mjs', "for (const asset of updates) for (const source of ['atomgit', 'github', 'oss'])", "for (const asset of updates) for (const source of ['github', 'oss'])", /promotion readiness passes three platforms/],
  ['promotion skips GitHub packages', 'publish-update-control.mjs', "for (const asset of updates) for (const source of ['atomgit', 'github', 'oss'])", "for (const asset of updates) for (const source of ['atomgit', 'oss'])", /promotion readiness passes three platforms/],
  ['promotion skips OSS packages', 'publish-update-control.mjs', "for (const asset of updates) for (const source of ['atomgit', 'github', 'oss'])", "for (const asset of updates) for (const source of ['atomgit', 'github'])", /promotion refuses to expose a legacy OSS manifest/],
  ['legacy manifest uses GitHub packages', 'publish-update-control.mjs', "['cp', legacyPath, 'oss://tianshu-update/tianshu/latest.json'", "['cp', 'latest.json', 'oss://tianshu-update/tianshu/latest.json'", /promotion publishes an OSS-routed legacy manifest/],
  ['promotion tag optional', 'publish-update-control.mjs', "if (!String(hit).trim()) add('all', 'atomgit-tag', tagEndpoint, 'version tag is missing')", "if (false) add('all', 'atomgit-tag', tagEndpoint, 'version tag is missing')", /missing tag/],
  ['promotion catalogs GitHub only', 'publish-update-control.mjs', "    ['atomgit-catalog', atomgitDownloadURL(tag, 'release-catalog.json')],\n    ['github-catalog', catalogURL(catalog.version)],\n    ['oss-catalog', ossAssetURL(catalog.version, 'release-catalog.json')],", "    ['github-catalog', catalogURL(catalog.version)],", /promotion refuses reformatted|promotion readiness aggregates missing/],
  ['promotion catalog pin bypass', 'publish-update-control.mjs', "    const bytes = await readBytes(url, { size: catalogBytes.length, sha256: release.catalogSha256 })\n    if (!bytes.equals(catalogBytes)) throw new Error('pinned catalog raw bytes differ')", '    await readBytes(url)', /promotion refuses reformatted/],
  ['promotion manifest version ignored', 'publish-update-control.mjs', 'manifest.version !== catalog.version || ', '', /promotion manifests must match/],
  ['promotion manifest platform ignored', 'publish-update-control.mjs', "if (!entry) { add(platform, `${source}-manifest`, url, 'missing manifest platform'); continue }", 'if (!entry) { continue }', /promotion manifests must match/],
  ['promotion manifest URL ignored', 'publish-update-control.mjs', "        if (entry.url !== expectedURL) add(platform, `${source}-manifest`, url, 'manifest download URL differs from the catalog')", '', /promotion manifests must match/],
  ['promotion manifest signature ignored', 'publish-update-control.mjs', "        if (entry.signature !== asset.signature) add(platform, `${source}-manifest`, url, 'manifest updater signature differs from the catalog')", '', /promotion manifests must match/],
  ['promotion gate not called', 'publish-update-control.mjs', '    await readiness(next.stable, { catalogBytes, request: fetcher, verifyDownload: dependencies.verifyDownload, probeTag: dependencies.probeTag })', '', /failed promotion readiness/],
  ['emergency operations gated', 'publish-update-control.mjs', "  if (operation === 'promote') {\n    if (!argv.includes('--release-notes-reviewed'))", "  if (['promote', 'pause', 'revoke'].includes(operation)) {\n    if (!argv.includes('--release-notes-reviewed'))", /emergency pause and revoke/],
  ['promotion errors fail fast', 'publish-update-control.mjs', 'catch (error) { add(platform, name, url, reason(error)); return undefined }', 'catch (error) { throw error }', /promotion readiness aggregates missing/],
  ['routing terminal events omitted', 'report-routing.mjs', "'no_progress_30s','slow_download','integrity_failed','download_failed'", "'no_progress_30s','integrity_failed'", /local upgrade report/],
]
for (const [name, filename, before, after, expected] of mutations) {
  const folder = mkdtempSync(join(tmpdir(), 'tianshu-control-defects-'))
  try {
    for (const file of ['anonymous-download.mjs', 'pinned-oss-catalog.mjs', 'update-control.mjs', 'catalog.mjs', 'update-control.test.mjs', 'publish-update-control.mjs', 'report-routing.mjs', 'guard-stable-publication.mjs']) copyFileSync(new URL(file, import.meta.url), join(folder, file))
    const shellName = join(folder, 'upload-update-to-oss.sh')
    const legacyPublisher = new URL('../upload-update-to-oss.sh', import.meta.url)
    if (existsSync(legacyPublisher)) copyFileSync(legacyPublisher, shellName)
    const testPath = join(folder, 'update-control.test.mjs')
    writeFileSync(testPath, readFileSync(testPath, 'utf8').replace('../upload-update-to-oss.sh', './upload-update-to-oss.sh'))
    const file = join(folder, filename), source = readFileSync(file, 'utf8')
    assert.ok(source.includes(before), `Missing mutation: ${name}`)
    writeFileSync(file, source.replace(before, after))
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(folder, 'update-control.test.mjs')], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.notEqual(result.status, 0, `Restored defect remained green: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.includes('not ok'), `Must fail an assertion, not a syntax error: ${name}`)
    assert.match(result.stdout, expected, `Wrong or missing behavioral assertion: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/, `Mutation broke compilation instead of behavior: ${name}`)
    console.log(`RED confirmed: ${name}`)
  } finally { rmSync(folder, { recursive: true, force: true }) }
}
