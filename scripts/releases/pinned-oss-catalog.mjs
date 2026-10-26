import { digest } from './update-control.mjs'

export const pinnedOssCatalogURL = version => `https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${version}/release-catalog.json`
export const pinnedOssCatalogObject = version => `oss://tianshu-update/tianshu/v${version}/release-catalog.json`

export async function ensurePinnedOssCatalog({ version, catalogBytes, publish = false, read, upload }) {
  const url = pinnedOssCatalogURL(version), object = pinnedOssCatalogObject(version)
  const existing = await read(url)
  if (existing) {
    if (digest(existing) !== digest(catalogBytes)) throw new Error('Pinned OSS catalog cannot be replaced')
    return { status: 'unchanged', url, object }
  }
  if (!publish) return { status: 'missing', url, object }
  if (!upload) throw new Error('Pinned OSS catalog upload is not configured')
  await upload({ url, object })
  const confirmed = await read(url)
  if (!confirmed || digest(confirmed) !== digest(catalogBytes)) throw new Error('Pinned OSS catalog readback mismatch')
  return { status: 'uploaded', url, object }
}
