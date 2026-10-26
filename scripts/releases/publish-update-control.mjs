import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { validateCatalog, CATALOG_URLS } from './catalog.mjs'
import { CONTROL_URLS, CONTROL_LIMIT, digest, canonical, validateControl, chooseControl, transition } from './update-control.mjs'
import { ATOMGIT_GIT_URL, assertAnonymousProof, atomgitDownloadURL, probeAtomgitTag, verifyAnonymousDownload } from './anonymous-download.mjs'
import { ensurePinnedOssCatalog } from './pinned-oss-catalog.mjs'

const REPO = 'huiliyi37/Tianshu-harness'
const githubAssetURL = (version, name) => `https://github.com/${REPO}/releases/download/v${version}/${name}`
const ossAssetURL = (version, name) => `https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${version}/${name}`
const catalogURL = version => githubAssetURL(version, 'release-catalog.json')
const FETCH_TIMEOUT_MS = Number(process.env.RELEASE_FETCH_TIMEOUT_MS ?? 15000)
// Node fetch 对 github.com 下载域在部分代理/直连链路上偶发 UND_ERR_CONNECT_TIMEOUT，
// curl 走系统网络栈（含 env 代理）常能通。仅网络层失败时回落；HTTP 错误语义不变。
// windowsHide：Windows 上不给 curl 开控制台窗口（architecture-guards 的 spawn 守卫基线为 0）。
function curlReadRemote(url) {
  const max = String(Math.ceil(FETCH_TIMEOUT_MS / 1000))
  try {
    const buf = execFileSync('curl', ['-sS', '-L', '--fail', '--max-time', max, '-H', 'Cache-Control: no-store', url], { encoding: 'buffer', maxBuffer: CONTROL_LIMIT * 4, windowsHide: true })
    if (buf.length > CONTROL_LIMIT) throw new Error('Metadata exceeds 256 KiB')
    return buf
  } catch (error) {
    if (error?.status === 22) {
      const code = execFileSync('curl', ['-sS', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', max, url], { encoding: 'utf8', windowsHide: true }).trim()
      if (code === '404') return undefined
      throw new Error(`Cannot read ${url}: HTTP ${code}`)
    }
    throw error
  }
}
export async function readRemote(url, fetcher = fetch) {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
    if (r.status === 404) return undefined
    if (!r.ok) throw new Error(`Cannot read ${url}: HTTP ${r.status}`)
    const chunks = []; let size = 0
    for await (const chunk of r.body) { size += chunk.length; if (size > CONTROL_LIMIT) throw new Error('Metadata exceeds 256 KiB'); chunks.push(chunk) }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.cause?.code || String(error?.message).includes('fetch failed')) return curlReadRemote(url)
    throw error
  }
}
export async function publishTransaction(transaction, io) {
  // A saved transaction is retried verbatim; no new revision is allocated on retry.
  const bytes = Buffer.from(canonical(transaction.next) + '\n')
  for (const source of ['github', 'oss']) {
    const found = await io.read(source)
    if (found) chooseControl([transaction.next], validateControl(JSON.parse(found)))
    if (!found || digest(found) !== digest(bytes)) await io.upload(source, bytes)
    const confirmed = await io.read(source)
    if (!confirmed || digest(confirmed) !== digest(bytes)) throw new Error(`Control readback mismatch: ${source}`)
    transaction.completed[source] = true
    await io.save(transaction)
  }
  // Recheck both after writes: publication may overlap another publisher.
  for (const source of ['github', 'oss']) if (digest(await io.read(source) ?? Buffer.alloc(0)) !== digest(bytes)) throw new Error('Control sources are not consistent')
}
function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')) }
async function verifyPinned(release, fetcher = fetch) {
  const bytes = await readRemote(catalogURL(release.version), fetcher)
  if (!bytes || digest(bytes) !== release.catalogSha256) throw new Error('Pinned catalog hash mismatch')
  const c = validateCatalog(JSON.parse(bytes)); if (c.version !== release.version) throw new Error('Pinned catalog version mismatch')
  if (c.artifacts.some(a => !a.sources.github?.verified)) throw new Error('GitHub artifacts must be verified')
  return { catalog: c, bytes }
}

function readinessError(issues) {
  const detail = issues.map(issue => `- ${issue.platform} | ${issue.check} | ${issue.url} | ${issue.reason}`).join('\n')
  return Object.assign(new Error(`Promotion readiness failed (${issues.length} checks):\n${detail}`), { issues })
}

export async function verifyPromotionReadiness(release, { catalogBytes, request = fetch, verifyDownload = verifyAnonymousDownload, probeTag = probeAtomgitTag } = {}) {
  const catalog = validateCatalog(JSON.parse(catalogBytes))
  if (catalog.version !== release.version || digest(catalogBytes) !== release.catalogSha256) throw new Error('Promotion release does not match the local pinned catalog')
  const updates = catalog.artifacts.filter(asset => asset.purpose === 'update')
  if (!updates.length) throw new Error('Promotion requires update platforms')
  const issues = []
  const add = (platform, check, url, reason) => issues.push({ platform, check, url, reason })
  const reason = error => String(error?.message ?? 'verification failed').replace(/https?:\/\/\S+/gi, '[remote URL]')
  const check = async (platform, name, url, run) => {
    try { return await run() } catch (error) { add(platform, name, url, reason(error)); return undefined }
  }
  const tag = `v${catalog.version}`, tagEndpoint = `${ATOMGIT_GIT_URL}#refs/tags/${tag}`
  try {
    const hit = await probeTag(tag)
    if (!String(hit).trim()) add('all', 'atomgit-tag', tagEndpoint, 'version tag is missing')
  } catch { add('all', 'atomgit-tag', tagEndpoint, 'anonymous tag probe failed') }

  for (const asset of updates) for (const source of ['atomgit', 'github', 'oss']) {
    const fallback = source === 'atomgit' ? atomgitDownloadURL(tag, asset.fileName) : source === 'github' ? githubAssetURL(catalog.version, asset.fileName) : ossAssetURL(catalog.version, asset.fileName)
    const entry = asset.sources[source]
    if (!entry) { add(asset.platform, `${source}-package`, fallback, 'source is missing from the catalog'); continue }
    if (entry.url !== fallback) add(asset.platform, `${source}-package`, entry.url, 'package URL differs from the fixed release URL')
    if (source !== 'oss' && (!entry.verified || (source === 'atomgit' && entry.anonymous !== true))) add(asset.platform, `${source}-package`, entry.url, 'catalog source is not enabled as verified anonymous routing')
    await check(asset.platform, `${source}-package`, entry.url, async () => {
      const proof = await verifyDownload({ url: entry.url, expected: { size: asset.size, sha256: asset.sha256 }, request })
      assertAnonymousProof(proof, { url: entry.url, size: asset.size, sha256: asset.sha256 })
    })
  }

  const readBytes = async (url, expected) => {
    const proof = await verifyDownload({ url, ...(expected ? { expected } : {}), request, collect: true })
    assertAnonymousProof(proof, { url, ...expected })
    if (!Buffer.isBuffer(proof.bytes)) throw new Error('metadata verifier did not return bounded bytes')
    return proof.bytes
  }
  for (const [source, url] of [
    ['atomgit-catalog', atomgitDownloadURL(tag, 'release-catalog.json')],
    ['github-catalog', catalogURL(catalog.version)],
    ['oss-catalog', ossAssetURL(catalog.version, 'release-catalog.json')],
  ]) await check('all', source, url, async () => {
    const bytes = await readBytes(url, { size: catalogBytes.length, sha256: release.catalogSha256 })
    if (!bytes.equals(catalogBytes)) throw new Error('pinned catalog raw bytes differ')
  })

  for (const source of ['atomgit', 'github']) {
    const url = source === 'atomgit' ? atomgitDownloadURL(tag, 'latest.json') : githubAssetURL(catalog.version, 'latest.json')
    await check('all', `${source}-manifest`, url, async () => {
      const manifest = JSON.parse(await readBytes(url))
      if (manifest.version !== catalog.version || !manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) throw new Error('manifest version or platform map is invalid')
      const platforms = new Set([...updates.map(asset => asset.platform), ...Object.keys(manifest.platforms)])
      for (const platform of platforms) {
        const asset = updates.find(item => item.platform === platform), entry = manifest.platforms[platform]
        if (!asset) { add(platform, `${source}-manifest`, url, 'unexpected manifest platform'); continue }
        if (!entry) { add(platform, `${source}-manifest`, url, 'missing manifest platform'); continue }
        const expectedURL = asset.sources[source]?.url ?? (source === 'atomgit' ? atomgitDownloadURL(tag, asset.fileName) : githubAssetURL(catalog.version, asset.fileName))
        if (entry.url !== expectedURL) add(platform, `${source}-manifest`, url, 'manifest download URL differs from the catalog')
        if (entry.signature !== asset.signature) add(platform, `${source}-manifest`, url, 'manifest updater signature differs from the catalog')
      }
    })
  }
  if (issues.length) throw readinessError(issues)
  return { catalog, verifiedPlatforms: updates.map(asset => asset.platform) }
}

export function buildLegacyOssManifest(manifest, catalog) {
  const validated = validateCatalog(catalog)
  const updates = validated.artifacts.filter(asset => asset.purpose === 'update')
  if (manifest?.version !== validated.version || !manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) throw new Error('Legacy OSS manifest version or platforms differ from the controlled catalog')
  const platforms = Object.keys(manifest.platforms)
  if (platforms.length !== updates.length || platforms.some(platform => !updates.some(asset => asset.platform === platform))) throw new Error('Legacy OSS manifest platform coverage differs from the controlled catalog')
  const oss = structuredClone(manifest)
  for (const asset of updates) {
    const entry = oss.platforms[asset.platform]
    const github = asset.sources.github?.url, backup = asset.sources.oss?.url
    if (!entry || entry.signature !== asset.signature || entry.url !== github || backup !== ossAssetURL(validated.version, asset.fileName)) throw new Error(`Legacy OSS manifest identity differs: ${asset.platform}`)
    entry.url = backup
  }
  return Buffer.from(JSON.stringify(oss, null, 2) + '\n')
}

async function releaseInfo(version, fetcher = fetch) {
  // api.github.com 匿名额度按出口 IP 计，共享 IP 极易 403——有 token 就带上
  // （CI 的 GITHUB_TOKEN / 本地 gh auth token 均可）；release 资产读取仍匿名。
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const r = await fetcher(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'tianshu-update-control', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (!r.ok) throw new Error(`GitHub release metadata unavailable (HTTP ${r.status}${token ? '' : '，无 token——匿名额度按出口 IP 计，可用 GH_TOKEN 环境变量提供'}${r.status === 403 ? '；403 多为匿名限额' : ''})`)
  return r.json()
}
function saveFile(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, canonical(value) + '\n') }
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const arg = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1] }
  const operation = argv[0], publish = argv.includes('--publish')
  const fetcher = dependencies.fetch ?? fetch
  const run = dependencies.run ?? ((command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
  const readiness = dependencies.verifyPromotionReadiness ?? verifyPromotionReadiness
  if (!['init', 'stage', 'set-percentage', 'pause', 'resume', 'revoke', 'promote'].includes(operation)) throw new Error('Usage: publish-update-control.mjs <init|stage|set-percentage|pause|resume|revoke|promote> [--publish] [--catalog FILE] [--acceptance FILE] [--platforms LIST] [--percentage N]')
  const controlPath = arg('--control') ?? 'update-control.json', txPath = arg('--transaction') ?? 'release/update-control-transaction.json'
  const remote = await Promise.all(CONTROL_URLS.map(url => readRemote(url, fetcher)))
  if (remote.every(b => !b) && operation !== 'init') throw new Error('Update control is unavailable on both sources')
  const controls = remote.filter(Boolean).map(b => validateControl(JSON.parse(b)))
  const local = existsSync(controlPath) ? validateControl(jsonFile(controlPath)) : undefined
  let current = controls.length ? chooseControl(controls, local) : local
  const catalogPath = arg('--catalog') ?? 'release-catalog.json', catalogBytes = readFileSync(catalogPath), catalog = validateCatalog(JSON.parse(catalogBytes))
  const evidence = arg('--acceptance') ? jsonFile(arg('--acceptance')) : undefined
  const platforms = arg('--platforms')?.split(',').filter(Boolean)
  const request = { operation, catalogSha256: digest(catalogBytes), evidence, platforms, percentage: arg('--percentage') === undefined ? 0 : Number(arg('--percentage')) }
  const oldTx = existsSync(txPath) ? jsonFile(txPath) : undefined
  const resume = oldTx && canonical(oldTx.request) === canonical(request) && (current?.revision === oldTx.previousRevision || canonical(current) === canonical(oldTx.next))
  let next
  if (resume) next = validateControl(oldTx.next)
  else if (operation === 'init') {
    if (current) throw new Error('Control is already initialized')
    next = validateControl({ schemaVersion: 1, revision: 1, stable: { version: catalog.version, catalogSha256: digest(catalogBytes) }, revokedVersions: [] })
  } else {
    if (!current) throw new Error('Initialize the stable control first')
    if (operation !== 'stage' && current.candidate && (catalog.version !== current.candidate.version || digest(catalogBytes) !== current.candidate.catalogSha256)) throw new Error('Candidate catalog bytes changed')
    next = transition(current, operation, { catalog, catalogSha256: digest(catalogBytes), evidence, platforms, percentage: request.percentage })
  }
  await verifyPinned(next.stable, fetcher)
  if (next.candidate) await verifyPinned(next.candidate, fetcher)
  const info = await releaseInfo(catalog.version, fetcher)
  if (info.draft || (operation !== 'init' && !resume && !info.prerelease)) throw new Error('Candidate must be a published prerelease')
  if (operation === 'init' && info.prerelease) throw new Error('Initial stable release cannot be a prerelease')
  let legacyOssBytes
  if (operation === 'promote') {
    if (!argv.includes('--release-notes-reviewed')) throw new Error('Promotion requires reviewed release notes')
    if (digest(readFileSync('release-catalog.json')) !== digest(catalogBytes) || jsonFile('latest.json').version !== catalog.version) throw new Error('Promotion requires matching root catalog and latest manifest')
    legacyOssBytes = buildLegacyOssManifest(jsonFile('latest.json'), catalog)
    await readiness(next.stable, { catalogBytes, request: fetcher, verifyDownload: dependencies.verifyDownload, probeTag: dependencies.probeTag })
  }
  const before = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url, fetcher)))
  if (operation !== 'init' && operation !== 'promote' && before.some(b => !b)) throw new Error('Legacy stable entries must be reachable before rollout changes')
  if (operation !== 'init' && operation !== 'promote' && before.filter(Boolean).some(b => JSON.parse(b).version !== current.stable.version)) throw new Error('Legacy or website entry does not match the stable release')
  const transaction = resume ? oldTx : { request, previousRevision: current?.revision ?? 0, next, completed: {}, stableEntryHashes: before.map(b => b ? digest(b) : null) }
  console.log(JSON.stringify({ mode: publish ? 'publish' : 'dry-run', operation, previous: current, next, affectedPlatforms: platforms ?? Object.keys(next.candidate?.platforms ?? {}) }, null, 2))
  if (!publish) return
  saveFile(txPath, transaction)
  // A fixed prerelease tag keeps control metadata outside releases/latest.
  try { run('gh', ['release', 'view', 'update-control', '--repo', REPO]) }
  catch { run('gh', ['release', 'create', 'update-control', '--prerelease', '--title', 'Update control', '--repo', REPO]) }
  const controlRelease = JSON.parse(run('gh', ['release', 'view', 'update-control', '--repo', REPO, '--json', 'isPrerelease,isDraft']).toString())
  if (!controlRelease.isPrerelease || controlRelease.isDraft) throw new Error('Control release must remain a published prerelease')
  // Fixed filename is required by both endpoints.
  const uploadPath = resolve(dirname(txPath), 'update-control.json')
  writeFileSync(uploadPath, canonical(next) + '\n')
  const pinnedPath=resolve(dirname(txPath),'release-catalog.json')
  writeFileSync(pinnedPath,catalogBytes)
  await ensurePinnedOssCatalog({
    version: catalog.version,
    catalogBytes,
    publish: true,
    read: url => readRemote(url, fetcher),
    upload: ({ object }) => run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', pinnedPath, object, '--meta', 'Cache-Control:no-cache', '-f']),
  })
  await publishTransaction(transaction, {
    read: source => readRemote(CONTROL_URLS[source === 'github' ? 1 : 0], fetcher),
    upload: async source => {
      if (source === 'github') run('gh', ['release', 'upload', 'update-control', uploadPath, '--clobber', '--repo', REPO])
      else run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', uploadPath, 'oss://tianshu-update/tianshu/update-control.json', '--meta', 'Cache-Control:no-cache', '-f'])
    }, save: async tx => saveFile(txPath, tx),
  })
  if (operation === 'promote' && !transaction.completed.promotion) {
    run('gh', ['release', 'edit', `v${catalog.version}`, '--prerelease=false', '--latest=true', '--repo', REPO])
    const website = arg('--website')
    run(process.execPath, ['scripts/releases/publish-routing.mjs', '--publish', '--release-notes-reviewed', ...(website ? ['--website', website] : [])])
    const legacyPath = resolve(dirname(txPath), 'latest-oss.json')
    writeFileSync(legacyPath, legacyOssBytes)
    run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', legacyPath, 'oss://tianshu-update/tianshu/latest.json', '--meta', 'Cache-Control:no-cache', '-f'])
    const entries = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url, fetcher)))
    if (entries.some(b => !b || JSON.parse(b).version !== catalog.version)) throw new Error('Promotion entries have not converged')
    if (digest(entries[3]) !== digest(legacyOssBytes)) throw new Error('Legacy OSS manifest readback differs from the verified package routes')
    transaction.completed.promotion = true; saveFile(txPath, transaction)
  } else if (operation !== 'promote') {
    const after = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url, fetcher)))
    if (after.some((b, i) => (b ? digest(b) : null) !== transaction.stableEntryHashes[i])) throw new Error('Stable entry changed during candidate publication')
  }
  saveFile(controlPath, next)
  console.log(`Confirmed control revision ${next.revision} on both sources`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
