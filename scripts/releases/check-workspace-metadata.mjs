import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersion, validateCatalog } from './catalog.mjs'
import { assertPinnedCatalog, canonical, validateControl } from './update-control.mjs'

/** Root metadata describes the stable channel; development packages may be ahead. */
export function validateWorkspaceMetadata({ packageVersion, manifest, catalogBytes, control }) {
  validateControl(control)
  const catalog = validateCatalog(JSON.parse(catalogBytes))
  if (catalog.version !== control.stable.version) throw new Error('Root catalog must describe the controlled stable release')
  assertPinnedCatalog(control, catalogBytes)
  if (manifest.version !== catalog.version) throw new Error('Stable manifest/catalog versions differ; keep candidates outside the root')
  if (compareVersion(packageVersion, catalog.version) < 0) throw new Error('Package version is behind the stable release')
  const updates = catalog.artifacts.filter(a => a.purpose === 'update')
  if (!manifest.platforms || Object.keys(manifest.platforms).length !== updates.length) throw new Error('Stable manifest must cover all catalog update platforms')
  for (const asset of updates) {
    const entry = manifest.platforms[asset.platform]
    if (!entry || entry.signature !== asset.signature) throw new Error(`Stable signature differs: ${asset.platform}`)
    if (!Object.values(asset.sources).some(source => source.verified && source.url === entry.url)) throw new Error(`Stable source is not verified: ${asset.platform}`)
  }
  return { stableVersion: catalog.version, packageVersion, platforms: updates.length }
}

export function checkWorkspaceMetadata(root = process.cwd()) {
  const json = file => JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  return validateWorkspaceMetadata({
    packageVersion: json('package.json').version,
    manifest: json('latest.json'),
    catalogBytes: readFileSync(resolve(root, 'release-catalog.json')),
    control: json('update-control.json'),
  })
}

/** Preserve pinned bytes; source qualification and candidate output use explicit draft paths. */
export function writeCatalog(file, catalog, root = process.cwd()) {
  validateCatalog(catalog)
  let bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n')
  const controlPath = resolve(root, 'update-control.json')
  if (resolve(file) === resolve(root, 'release-catalog.json') && existsSync(controlPath)) {
    const control = validateControl(JSON.parse(readFileSync(controlPath)))
    if (catalog.version !== control.stable.version) throw new Error('Candidate catalog requires an explicit output path outside the stable root')
    if (existsSync(file)) {
      const existing = readFileSync(file)
      if (canonical(JSON.parse(existing)) === canonical(catalog)) bytes = existing
    }
    assertPinnedCatalog(control, bytes)
  }
  writeFileSync(file, bytes)
  return bytes
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(checkWorkspaceMetadata(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
