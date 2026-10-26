import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sha256 } from './generate-catalog.mjs'
import { validateCatalog } from './catalog.mjs'
import { assertAnonymousProof, atomgitDownloadURL, probeAtomgitTag, verifyAnonymousDownload } from './anonymous-download.mjs'

const BASE = 'https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness'
export const downloadURL = atomgitDownloadURL

/** 给脚本自造的失败打阶段标记：顶层 catch 只对它打印 message（文案只含阶段名与 HTTP 状态码，不含预签名 URL）。 */
const staged = (message, pubStage) => Object.assign(new Error(message), { pubStage })

export function atomgitSource(version, artifact, proof) {
  const url = downloadURL(`v${version}`, artifact.fileName)
  assertAnonymousProof(proof, { url, size: artifact.size, sha256: artifact.sha256 })
  return { url, verified: true, anonymous: true, verifiedAt: proof.verifiedAt, sha256: artifact.sha256, size: artifact.size }
}
export function atomgitManifest(catalog) {
  validateCatalog(catalog)
  const updates = catalog.artifacts.filter(a => a.purpose === 'update')
  if (!updates.length || updates.some(a => !a.sources.atomgit?.verified)) throw staged('All update platforms must have AtomGit sources before publishing immutable metadata', 'metadata-readiness')
  return { version: catalog.version, notes: catalog.notes ?? '', pub_date: catalog.publishedAt, platforms: Object.fromEntries(updates.map(a => [a.platform, { url: a.sources.atomgit.url, signature: a.signature }])) }
}
export async function publishMetadata(api, tag, assets, catalog, request = fetch, catalogBytes = Buffer.from(JSON.stringify(catalog,null,2)+'\n')) {
  const manifest = atomgitManifest(catalog)
  if (catalogBytes.length > 256*1024 || JSON.stringify(JSON.parse(catalogBytes)) !== JSON.stringify(catalog)) throw staged('Catalog bytes must match the validated catalog and fit the metadata limit', 'metadata-readiness')
  for (const [name, value] of [['latest.json', manifest], ['release-catalog.json', catalog]]) {
    const path = join(assets, name); writeFileSync(path, name === 'release-catalog.json' ? catalogBytes : JSON.stringify(value,null,2)+'\n')
    await uploadImmutable(api, tag, path, { size: statSync(path).size, sha256: await sha256(path) }, request)
  }
}

function credential() {
  if (process.env.ATOMGIT_ACCESS_TOKEN) return process.env.ATOMGIT_ACCESS_TOKEN
  for (const host of ['atomgit.com','api.atomgit.com']) {
    try {
      const text = execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe','pipe','ignore'], timeout: 5000, windowsHide: true }).toString()
      const password = text.split('\n').find(line => line.startsWith('password='))?.slice(9)
      if (password) return password
    } catch { /* try the API host without opening an interactive login */ }
  }
}
export function atomgitClient(token, request = fetch) {
  return async (path, options = {}) => {
    const url = new URL(`${BASE}${path}`); url.searchParams.set('access_token', token)
    const response = await request(url, { ...options, signal: AbortSignal.timeout(30000) })
    if (!response.ok) { const e = new Error(`AtomGit API failed: HTTP ${response.status}`); e.status = response.status; throw e }
    return response.json()
  }
}

/**
 * Release 缺则自建——镜像仓只同步 git ref，不同步 release 对象（2026-10-24 实测：
 * 创建接口可用，但 body 为空被 400「body不能为空」拒收，故 notes 缺省时用 GitHub
 * 链接兜底）。tag 必须已镜像到位，否则拒绝——绝不把 release 钉到无关的 main HEAD。
 */
export async function ensureRelease(api, tag, notes, probeTag = probeAtomgitTag) {
  try { return await api(`/releases/tags/${tag}`) } catch (e) {
    if (e.status !== 404) throw e
    if (!probeTag(tag).trim()) throw new Error('Version tag must be mirrored to AtomGit before publishing attachments')
    const body = notes?.trim() || `完整清单见 GitHub Release：https://github.com/huiliyi37/Tianshu-harness/releases/tag/${tag}`
    return api('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, name: tag, body, release_status: 'latest' }) })
  }
}

/**
 * 发布完成后把「最新版本」徽章钉到当前版本——release_status 是服务端单值语义，
 * 只读 GET 不含它；手工补建/部分重跑过的 release 缺省是 none，徽章会停在旧版
 * （2026-10-24 事故：v3.36.1 发布一天后仓页仍显示 v3.35.0）。PATCH 必须带回
 * name+body（缺省 400 must not be blank），先读后改保持原文。幂等：已是 latest 零写入。
 */
export async function markLatest(api, tag) {
  const release = await api(`/releases/tags/${tag}`)
  if (release.release_status === 'latest') return false
  await api(`/releases/${tag}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: release.name || tag, body: release.body?.trim() || `完整清单见 GitHub Release：https://github.com/huiliyi37/Tianshu-harness/releases/tag/${tag}`, release_status: 'latest' }) })
  return true
}
/** Existing and newly uploaded immutable attachments must both pass anonymous byte verification. */
export async function uploadImmutable(api, tag, file, expected, request = fetch) {
  const name = basename(file), entry = downloadURL(tag, name)
  expected ??= { size: statSync(file).size, sha256: await sha256(file) }
  let probe
  try {
    probe = await request(entry, { headers: { Range: 'bytes=0-0', 'Cache-Control': 'no-store' }, redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) })
  } catch {
    throw staged('Cannot establish attachment absence: anonymous probe failed', 'attachment-probe')
  }
  const probeOk = probe.status === 200 || probe.status === 206
  try { await probe.body?.cancel() } catch { /* 已消费/已关闭 */ }
  if (probeOk) {
    try { return await verifyAnonymousDownload({ url: entry, expected, request }) }
    catch (error) { throw staged(`Existing immutable attachment verification failed: ${error.message}`, 'attachment-verify') }
  }
  if (probe.status !== 404) throw staged(`Cannot establish attachment absence: HTTP ${probe.status}`, 'attachment-probe')
  const info = await api(`/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`)
  const target = new URL(info.url)
  if (target.protocol !== 'https:' || target.username || target.password) throw staged('Unsafe upload address', 'upload-address')
  // 预签名端点对无 Content-Length 的 chunked PUT 返回 411；长度必须与本地正文一致。
  const response = await request(target, {
    method: 'PUT',
    headers: { ...info.headers, 'Content-Length': String(statSync(file).size) },
    body: createReadStream(file),
    duplex: 'half',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  if (!response.ok) throw staged(`Attachment upload failed: HTTP ${response.status}`, 'attachment-upload')
  try { await response.body?.cancel() } catch { /* 已消费/已关闭 */ }
  try { return await verifyAnonymousDownload({ url: entry, expected, request, notFoundRetries: 19 }) }
  catch (error) { throw staged(`Uploaded attachment verification failed: ${error.message}`, 'attachment-verify') }
}
async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i+1] }
  const assets = resolve(arg('--assets') ?? 'release')
  const catalogPath = arg('--catalog') ?? 'release-catalog.json'
  const catalog = validateCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')))
  if (process.argv.includes('--metadata-only')) {
    if (process.argv.includes('--assets-only')) throw staged('Choose assets-only or metadata-only', 'arguments')
    const manifest = atomgitManifest(catalog)
    if (!process.argv.includes('--publish')) { console.log(`Dry run: v${catalog.version} complete AtomGit metadata (${Object.keys(manifest.platforms).join(', ')}); package bytes will not be uploaded`); return }
    const token = credential(); if (!token) { const error = new Error('AtomGit credential unavailable'); error.code='CREDENTIAL_UNAVAILABLE'; throw error }
    const api = atomgitClient(token)
    await ensureRelease(api, `v${catalog.version}`, catalog.notes)
    await publishMetadata(api, `v${catalog.version}`, assets, catalog, fetch, readFileSync(catalogPath))
    await markLatest(api, `v${catalog.version}`)
    console.log(`Published AtomGit metadata: v${catalog.version}`); return
  }
  const target = catalog.artifacts.find(a => a.platform === (arg('--platform') ?? 'windows-x86_64') && a.purpose === (arg('--purpose') ?? 'update'))
  if (!target) throw new Error('Missing platform artifact')
  const file = join(assets, target.fileName)
  if (statSync(file).size !== target.size || await sha256(file) !== target.sha256) throw new Error('Local artifact differs from catalog')
  // install 用途（macOS DMG）不参与 updater 签名，catalog 里没有 signature 字段：只在有签名时校验。
  if (target.signature && readFileSync(file + '.sig', 'utf8').trim() !== target.signature.trim()) throw new Error('Local signature differs from catalog')
  if (!process.argv.includes('--publish')) {
    console.log(`Dry run: v${catalog.version}, ${target.fileName}, ${target.size} bytes; use --publish to upload`)
    return
  }
  const token = credential(); if (!token) { const error = new Error('AtomGit credential unavailable'); error.code='CREDENTIAL_UNAVAILABLE'; throw error }
  const api = atomgitClient(token), tag = `v${catalog.version}`
  await ensureRelease(api, tag, catalog.notes)
  await uploadImmutable(api, tag, file, target)
  const extra = async path => uploadImmutable(api, tag, path)
  // 安装包（macOS DMG）不参与 updater 签名，没有 .sig 文件：缺了跳过，不是错误。
  if (existsSync(file + '.sig')) await extra(file + '.sig')
  const checksumPath = join(assets,`${target.fileName}.sha256`)
  writeFileSync(checksumPath,`${target.sha256}  ${target.fileName}\n`); await extra(checksumPath)
  if (await markLatest(api, tag)) console.log(`Marked ${tag} as latest release on AtomGit`)
  console.log(`Uploaded ${target.platform} assets to AtomGit: ${target.fileName}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  // HTTP errors can contain credential-bearing upload URLs. Never echo raw transport errors.
  // 例外：脚本自造的错误（带 pubStage）与 API 状态错误（message 只有 "AtomGit API failed: HTTP nnn"）
  // ——文案不含 URL 与 token，是唯一可诊断信号；否则失败永远是同一句黑盒提示。
  if (error.code === 'CREDENTIAL_UNAVAILABLE') console.error('AtomGit credential unavailable. Configure ATOMGIT_ACCESS_TOKEN or the system Git credential helper; do not paste credentials into chat.')
  else if (error.pubStage) console.error(`AtomGit publication did not complete [stage=${error.pubStage}]: ${error.message}`)
  else if (typeof error.status === 'number') console.error(`AtomGit publication did not complete [stage=api ${error.status}]: ${error.message}`)
  else console.error('AtomGit publication did not complete; no remote URL or credential details are printed. Check local artifact and catalog validation, then retry.')
  process.exitCode = 1
})
