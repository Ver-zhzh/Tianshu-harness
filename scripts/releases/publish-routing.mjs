import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { validateCatalog, assertCatalogUpdate, CATALOG_URLS } from './catalog.mjs'
import { validateReleaseNotes } from './release-notes.mjs'
import { guardStablePublication } from './guard-stable-publication.mjs'
import { readRemote } from './publish-update-control.mjs'
import { ensurePinnedOssCatalog } from './pinned-oss-catalog.mjs'

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const publish = argv.includes('--publish')
  const fetcher = dependencies.fetch ?? fetch
  const read = dependencies.read ?? (url => readRemote(url, fetcher))
  const run = dependencies.run ?? ((cmd, args, options = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, windowsHide: true }))
  const log = dependencies.log ?? console.log
  const catalogBytes = readFileSync('release-catalog.json')
  const catalog = validateCatalog(JSON.parse(catalogBytes))
  await guardStablePublication(catalog.version, catalogBytes, fetcher)
  const manifest = JSON.parse(readFileSync('latest.json', 'utf8'))
  if (catalog.version !== manifest.version) throw new Error('Manifest/catalog versions differ')
  if (!catalog.artifacts.every(a => a.sources.github?.verified)) throw new Error('GitHub artifacts must be verified before publishing the catalog')
  if (argv.includes('--enable-legacy-atomgit')) {
    const windows = catalog.artifacts.find(a => a.platform === 'windows-x86_64' && a.purpose === 'update')
    if (!windows?.sources.atomgit?.verified || windows.sources.atomgit.anonymous !== true) throw new Error('Windows anonymous download must pass before redirecting old clients')
    if (windows.signature !== manifest.platforms['windows-x86_64']?.signature) throw new Error('Legacy signature differs from catalog')
  }
  async function existingCatalog(url) {
    const body = await read(url)
    if (body === undefined) return
    const old = validateCatalog(JSON.parse(body))
    assertCatalogUpdate(old, catalog)
  }
  const github = `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${catalog.version}/release-catalog.json`
  await existingCatalog(github)
  await existingCatalog(CATALOG_URLS[0])
  const pinned = await ensurePinnedOssCatalog({
    version: catalog.version,
    catalogBytes,
    publish,
    read,
    upload: ({ object }) => run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', 'release-catalog.json', object, '--meta', 'Cache-Control:no-cache', '-f']),
  })
  if (!publish) {
    log(`Dry run: publish v${catalog.version} catalog to GitHub/OSS and dispatch website refresh. Version-pinned OSS catalog: ${pinned.status}. Legacy endpoint remains unchanged unless --enable-legacy-atomgit is supplied.`)
    return pinned
  }
  const work = mkdtempSync(join(tmpdir(), 'tianshu-routing-'))
  try {
    if (catalog.releaseNotesUrl) {
      if (!argv.includes('--release-notes-reviewed')) throw new Error('Release notes require publisher review before upload')
      const notes = validateReleaseNotes(JSON.parse(readFileSync(`docs/releases/summaries/${catalog.version}.json`, 'utf8')), catalog.version)
      const file = join(work, 'release-notes.json'); writeFileSync(file, JSON.stringify(notes, null, 2) + '\n')
      const existing = await read(catalog.releaseNotesUrl)
      if (existing !== undefined && JSON.stringify(validateReleaseNotes(JSON.parse(existing), catalog.version)) !== JSON.stringify(notes)) throw new Error('Immutable release notes changed')
      if (existing === undefined) run('gh', ['release', 'upload', `v${catalog.version}`, file, '--repo', 'huiliyi37/Tianshu-harness'])
      run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', file, `oss://tianshu-update/tianshu/v${catalog.version}/release-notes.json`, '-f'])
    }
    run('gh', ['release', 'upload', `v${catalog.version}`, 'release-catalog.json', '--repo', 'huiliyi37/Tianshu-harness', '--clobber'])
    run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', 'release-catalog.json', 'oss://tianshu-update/tianshu/release-catalog.json', '--meta', 'Cache-Control:no-cache', '-f'])
    if (argv.includes('--enable-legacy-atomgit')) {
      const legacy = structuredClone(manifest)
      for (const [platform, p] of Object.entries(legacy.platforms)) {
        const a = catalog.artifacts.find(a => a.platform === platform && a.purpose === 'update')
        const atomgit = a.sources.atomgit
        p.url = atomgit?.verified ? atomgit.url : a.sources.oss?.url ?? p.url
      }
      const file = join(work, 'latest.json'); writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n')
      run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', file, 'oss://tianshu-update/tianshu/latest.json', '--meta', 'Cache-Control:no-cache', '-f'])
    }
    const arg = argv.indexOf('--website')
    const website = resolve(arg >= 0 ? argv[arg + 1] : process.env.TIANSHU_WEBSITE_DIR ?? '../tianshu-website')
    const remote = run('git', ['-C', website, 'remote', 'get-url', 'origin']).toString().trim()
    const repo = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    if (!repo) throw new Error('Website GitHub repository cannot be resolved')
    const body = join(work, 'dispatch.json'); writeFileSync(body, JSON.stringify({ event_type: 'tianshu-release', client_payload: { version: catalog.version, revision: catalog.revision } }))
    run('gh', ['api', `repos/${repo}/dispatches`, '--method', 'POST', '--input', body])
    log(`Published v${catalog.version} catalog and requested website refresh`)
    return pinned
  } finally { rmSync(work, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(`Routing publication incomplete; retry checks existing metadata first. ${error.message}`)
  process.exitCode = 1
})
