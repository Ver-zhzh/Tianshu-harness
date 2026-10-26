import assert from 'node:assert/strict'
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const defaultTests = ['anonymous-download.test.mjs', 'catalog.test.mjs', 'publish-atomgit.test.mjs']
const wrapperTests = ['publish-release-catalog.test.mjs']
const routingTests = ['publish-routing.test.mjs']
const mutations = [
  ['automatic OSS', 'catalog.mjs', "['atomgit', 'github'] : [mode]", "['atomgit', 'github', 'oss'] : [mode]", /auto uses verified AtomGit/],
  ['unverified AtomGit', 'catalog.mjs', 'asset.sources[source]?.verified', 'asset.sources[source]', /auto uses verified AtomGit/],
  ['conflicting signatures', 'catalog.mjs', ' || same.signature !== asset.signature', '', /select highest stable version/],
  ['unsigned anonymous bytes', 'anonymous-download.mjs', 'if (expected && sha256 !== expected.sha256)', 'if (false)', /wrong digest/, defaultTests, [["{ url, ...(expected ? { size: expected.size, sha256: expected.sha256 } : {}) }", '{ url }']]],
  ['local artifact mismatch', 'generate-catalog.mjs', 'if (remote && (remote.size !== size || remote.digest !== `sha256:${digest}`))', 'if (false)', /generator validates local bytes/],
  ['existing attachment only probed', 'publish-atomgit.mjs', "    try { return await verifyAnonymousDownload({ url: entry, expected, request }) }\n    catch (error) { throw staged(`Existing immutable attachment verification failed: ${error.message}`, 'attachment-verify') }", '    return undefined', /已存在附件零上传/],
  ['false Content-Range acceptance', 'anonymous-download.mjs', "range.headers.get('content-range') !== expectedContentRange", 'false', /wrong interval|wrong total/],
  ['Range bytes not compared', 'anonymous-download.mjs', 'if (rangeSize !== expectedPrefix.length || !Buffer.concat(rangeChunks, rangeSize).equals(expectedPrefix))', 'if (false)', /wrong Range bytes|truncated Range/],
  ['partial platform manifest', 'publish-atomgit.mjs', 'updates.some(a => !a.sources.atomgit?.verified)', 'updates.some(() => false)', /不可变清单覆盖全部平台/],
  ['pinned catalog reformatted', 'publish-atomgit.mjs', "name === 'release-catalog.json' ? catalogBytes : JSON.stringify(value,null,2)+'\\n'", "JSON.stringify(value,null,2)+'\\n'", /仅补齐元数据/],
  ['catalog generator trusts AtomGit flag', 'generate-catalog.mjs', 'const proof = await verifyAtomgit({ url, expected: { size, sha256: digest } })', "const proof = { url, size, sha256: digest, verified: true, anonymous: true, verifiedAt: new Date().toISOString() }", /--atomgit marks verified/],
  ['catalog generator ignores invalid proof', 'generate-catalog.mjs', '      assertAnonymousProof(proof, { url, size, sha256: digest })', '', /--atomgit marks verified/],
  ['uploaded attachment not read back', 'publish-atomgit.mjs', "  try { return await verifyAnonymousDownload({ url: entry, expected, request, notFoundRetries: 19 }) }\n  catch (error) { throw staged(`Uploaded attachment verification failed: ${error.message}`, 'attachment-verify') }", '  return undefined', /上传显式带 Content-Length/],
  ['missing AtomGit tag auto-skipped', 'publish-release-catalog.sh', '[ -n "$HIT" ] || fail "AtomGit 仓库没有 v$VER tag——先完成镜像；不得跳过 AtomGit 继续发布"', 'SKIP_ATOMGIT=1', /AtomGit 缺 tag/, wrapperTests],
  ['AtomGit probe failure hidden', 'publish-release-catalog.sh', '"refs/tags/v$VER" 2>/dev/null)"; then', '"refs/tags/v$VER" 2>/dev/null || true)"; then', /AtomGit tag 探测失败/, wrapperTests],
  ['explicit AtomGit skip allowed', 'publish-release-catalog.sh', '[ "$SKIP_ATOMGIT" != 1 ] || fail "--skip-atomgit 不允许用于稳定发布：必须完成 AtomGit 双源验证与元数据发布"', ':', /显式 --skip-atomgit/, wrapperTests],
  ['AtomGit metadata stage removed', 'publish-release-catalog.sh', 'node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release --publish', ':', /临时仓库完整模拟/, wrapperTests],
  ['versioned OSS publication removed', 'publish-routing.mjs', "  const pinned = await ensurePinnedOssCatalog({\n    version: catalog.version,\n    catalogBytes,\n    publish,\n    read,\n    upload: ({ object }) => run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', 'release-catalog.json', object, '--meta', 'Cache-Control:no-cache', '-f']),\n  })", "  const pinned = { status: 'skipped' }", /publish-routing publishes and reads back version-pinned OSS/, routingTests],
  ['versioned OSS readback removed', 'pinned-oss-catalog.mjs', '  const confirmed = await read(url)', '  const confirmed = catalogBytes', /version-pinned OSS upload requires anonymous readback/, routingTests],
  ['versioned OSS conflict accepted', 'pinned-oss-catalog.mjs', "if (digest(existing) !== digest(catalogBytes)) throw new Error('Pinned OSS catalog cannot be replaced')", "if (false) throw new Error('Pinned OSS catalog cannot be replaced')", /conflicting version-pinned OSS bytes reject/, routingTests],
  ['versioned OSS identical bytes reuploaded', 'pinned-oss-catalog.mjs', "    return { status: 'unchanged', url, object }", "    if (!publish) return { status: 'unchanged', url, object }", /existing identical version-pinned OSS catalog is reused/, routingTests],
]
const repoRoot = join(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'latest.json'), 'utf8'))
for (const [name, file, before, after, expected, tests = defaultTests, extraEdits = []] of mutations) {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-routing-mutation-'))
  try {
    const releases = join(dir, 'scripts/releases')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    cpSync(import.meta.dirname, releases, { recursive: true })
    copyFileSync(join(repoRoot, 'latest.json'), join(dir, 'latest.json'))
    copyFileSync(join(repoRoot, 'update-control.json'), join(dir, 'update-control.json'))
    const summary = `docs/releases/summaries/${manifest.version}.json`, target = join(dir, summary)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repoRoot, summary), target)
    const path = join(releases, file)
    let source = readFileSync(path, 'utf8')
    for (const [anchor, replacement] of [[before, after], ...extraEdits]) {
      assert.ok(source.includes(anchor), `Mutation anchor: ${name}`)
      source = source.replace(anchor, replacement)
    }
    writeFileSync(path, source)
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map(test => join(releases, test))], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true })
    assert.notEqual(result.status, 0, `Restored defect remained green: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.includes('not ok'), `Must fail an assertion, not a syntax error: ${name}`)
    assert.match(result.stdout, expected, `Wrong or missing behavioral assertion: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/, `Mutation broke compilation instead of behavior: ${name}`)
    console.log(`RED confirmed: ${name}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
