import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sha256 } from './generate-catalog.mjs'
import { validateCatalog } from './catalog.mjs'
import { writeCatalog } from './check-workspace-metadata.mjs'

const BASE = 'https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness'
export const downloadURL = (tag, name) => `${BASE}/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(name)}/download`

/** 给脚本自造的失败打阶段标记：顶层 catch 只对它打印 message（文案只含阶段名与 HTTP 状态码，不含预签名 URL）。 */
const staged = (message, pubStage) => Object.assign(new Error(message), { pubStage })

/**
 * PUT 返回 2xx 与附件「匿名可见」之间可能有一个**秒级登记窗口**（2026-10-08 实测：
 * 95B 附件流式 PUT 后立即 HEAD 得 404，约 10s 后才转 200）。上传后需要附件可下载时
 * 给一个有界等待：**只在 404 上重试**（最多 20 次 × 3s），其他状态码立即失败。
 */
export async function openAttachment(url, request) {
  for (let attempt = 0; ; attempt++) {
    const response = await request(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) })
    if (response.ok && response.body) return response
    try { await response.body?.cancel() } catch { /* 已消费/已关闭 */ }
    if (response.status !== 404 || attempt >= 19) return response
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

/** 上传后记录到 catalog 的源条目——与 GitHub/OSS 源同级，不再有资格验证链。 */
export function atomgitSource(version, artifact) {
  return { url: downloadURL(`v${version}`, artifact.fileName), verified: true, anonymous: true, verifiedAt: new Date().toISOString(), sha256: artifact.sha256, size: artifact.size }
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
/** Existing attachments are never re-uploaded; a different immutable file is never overwritten. */
export async function uploadImmutable(api, tag, file, expected, request = fetch) {
  const name = basename(file), entry = downloadURL(tag, name)
  // 存在性探测不能走 HEAD：AtomGit 的附件入口对 HEAD 恒返回 404（2026-10-08 实测，
  // 同一 URL 的 GET/Range 正常 206、全量下载也正常）。用 1 字节 Range GET 判存，
  // 否则每次重跑都会把已上传的几百 MB 原样重传一遍。
  const probe = await request(entry, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
  const probeOk = probe.ok || probe.status === 206
  try { await probe.body?.cancel() } catch { /* 已消费/已关闭 */ }
  if (probeOk) return
  if (probe.status !== 404) throw staged(`Cannot establish attachment absence: HTTP ${probe.status}`, 'attachment-probe')
  const info = await api(`/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`)
  const target = new URL(info.url)
  if (target.protocol !== 'https:' || target.username || target.password) throw staged('Unsafe upload address', 'upload-address')
  // 预签名端点对**无 Content-Length 的 chunked PUT 返回 411 Length Required**（2026-10-08
  // 实测：流式 body 不带长度时平台直接拒收，首次启用 AtomGit 源时每个平台都卡在这里）。
  // 带上真实长度后同一路径立即 200 且附件匿名可见；长度取自本地文件，与实际正文一致。
  const response = await request(target, {
    method: 'PUT',
    headers: { ...info.headers, 'Content-Length': String(statSync(file).size) },
    body: createReadStream(file),
    duplex: 'half',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  if (!response.ok) throw staged(`Attachment upload failed: HTTP ${response.status}`, 'attachment-upload')
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
    await publishMetadata(atomgitClient(token), `v${catalog.version}`, assets, catalog, fetch, readFileSync(catalogPath))
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
  try { await api(`/releases/tags/${tag}`) } catch (e) {
    if (e.status !== 404) throw e
    // Existing signed version/tag is required; never silently tag unrelated main HEAD.
    const tags = execFileSync('git', ['ls-remote', '--tags', 'https://atomgit.com/huiliyi37/Tianshu-harness.git', `refs/tags/${tag}`], { env: { ...process.env, GIT_TERMINAL_PROMPT:'0' }, stdio:['ignore','pipe','ignore'], timeout:30000, windowsHide: true }).toString()
    if (!tags.trim()) throw new Error('Version tag must be mirrored to AtomGit before publishing attachments')
    await api('/releases', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tag_name: tag, name: tag, body: catalog.notes ?? '', release_status:'latest' }) })
  }
  await uploadImmutable(api, tag, file, target)
  const extra = async path => uploadImmutable(api, tag, path)
  // 安装包（macOS DMG）不参与 updater 签名，没有 .sig 文件：缺了跳过，不是错误。
  if (existsSync(file + '.sig')) await extra(file + '.sig')
  const checksumPath = join(assets,`${target.fileName}.sha256`)
  writeFileSync(checksumPath,`${target.sha256}  ${target.fileName}\n`); await extra(checksumPath)
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
