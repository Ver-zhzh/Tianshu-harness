/**
 * AtomGit 发布回归：预签名 PUT 长度、Range 判存、不可变冲突，以及上传前后统一的匿名全量验证。
 * 所有网络均由 request 注入，测试不会访问真实发布端点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadImmutable, atomgitManifest, publishMetadata, downloadURL, atomgitSource, ensureRelease, markLatest } from './publish-atomgit.mjs'

const BODY = Buffer.from('atomgit attachment body\n')
const EXPECTED = { size: BODY.length, sha256: createHash('sha256').update(BODY).digest('hex') }

/** 假平台：existing 控制附件是否已存在，PUT 后的字节才允许匿名下载。 */
function makeHarness({ existing, remoteBody = BODY } = {}) {
  const calls = { put: 0, probe: 0, download: 0, range: 0, putHeaders: undefined, probeMethod: undefined }
  let stored = existing ? remoteBody : undefined
  const request = async (_url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const range = opts.headers?.Range
    if (method === 'PUT') {
      calls.put += 1
      calls.putHeaders = opts.headers
      const chunks = []
      for await (const chunk of opts.body) chunks.push(Buffer.from(chunk))
      stored = Buffer.concat(chunks)
      return new Response('success', { status: 200 })
    }
    if (range) {
      const end = Number(range.split('-')[1])
      if (range === 'bytes=0-0') { calls.probe += 1; calls.probeMethod = method } else calls.range += 1
      return stored
        ? new Response(stored.subarray(0, end + 1), { status: 206, headers: { 'content-range': `bytes 0-${Math.min(end, stored.length - 1)}/${stored.length}` } })
        : new Response(null, { status: 404 })
    }
    calls.download += 1
    return stored ? new Response(stored, { status: 200 }) : new Response(null, { status: 404 })
  }
  return { request, calls }
}

function makeFile() {
  const dir = mkdtempSync(join(tmpdir(), 'atomgit-publish-'))
  const file = join(dir, 'artifact.bin')
  writeFileSync(file, BODY)
  return file
}

test('上传显式带 Content-Length（chunked PUT 会被预签名端点以 411 拒收）', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: false })
  const api = async () => ({ url: 'https://upload.example.test/put', headers: { 'Content-Type': 'application/octet-stream' } })

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.put, 1, '应当发生一次上传')
  assert.equal(
    calls.putHeaders?.['Content-Length'],
    String(BODY.length),
    'PUT 必须携带真实长度——缺了就是 411',
  )
  assert.equal(calls.download, 1, '刚上传的附件必须匿名全量回读')
  assert.equal(calls.range, 1, '刚上传的附件必须验证精确 Range')
})

test('已存在附件零上传，但仍须匿名全量回读和精确 Range', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: true })
  const api = async () => { throw new Error('附件已存在，不应再取 upload_url') }

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.probe, 1, '存在性探测应发生一次')
  assert.equal(calls.probeMethod, 'GET', '探测方法必须是 GET（HEAD 恒 404）')
  assert.equal(calls.put, 0, '已存在时不得重复上传')
  assert.equal(calls.download, 1, '已存在不能退化为判存即完成')
  assert.equal(calls.range, 1)
})

test('同名不同字节是不可变冲突：拒绝且绝不覆盖或重新上传', async () => {
  const file = makeFile(), different = Buffer.from(BODY)
  different[0] ^= 1
  const { request, calls } = makeHarness({ existing: true, remoteBody: different })
  let apiCalls = 0
  const api = async () => { apiCalls++; return { url: 'https://upload.example.test/put' } }
  await assert.rejects(uploadImmutable(api, 'v0.0.0', file, EXPECTED, request), /sha256/)
  assert.equal(apiCalls, 0)
  assert.equal(calls.put, 0)
  assert.equal(calls.download, 1)
  assert.equal(calls.range, 0, '摘要不同时不得用 Range 结果掩盖冲突')
})

function metadataFixture() {
  const version = '3.30.0'
  return { schemaVersion:1, revision:1, version, publishedAt:'2026-10-09T00:00:00Z', artifacts:['windows-x86_64','darwin-aarch64'].map(platform => {
    const fileName = `Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : 'aarch64.app.tar.gz'}`
    return { platform, purpose:'update', fileName, ...EXPECTED, signature:'signed', sources:{atomgit:{...EXPECTED,url:downloadURL(`v${version}`,fileName),verified:true,anonymous:true,verifiedAt:'2026-10-09T00:00:00Z'}} }
  }) }
}
test('atomgitSource 只接受与当前包完全匹配的匿名验证证明', () => {
  const artifact = metadataFixture().artifacts[0]
  const url = downloadURL('v3.30.0', artifact.fileName)
  const proof = { ...EXPECTED, url, verified: true, anonymous: true, verifiedAt: '2026-10-09T00:00:00Z' }
  const source = atomgitSource('3.30.0', artifact, proof)
  assert.equal(source.verified, true)
  assert.equal(source.anonymous, true)
  assert.equal(source.url, url)
  assert.equal(source.sha256, artifact.sha256)
  assert.equal(source.size, artifact.size)
  assert.throws(() => atomgitSource('3.30.0', artifact), /valid proof/)
  assert.throws(() => atomgitSource('3.30.0', artifact, { ...proof, sha256: '0'.repeat(64) }), /sha256 mismatch/)
})
test('metadata-only 默认 dry run 展示全部平台且不要求本地安装包、不写文件', () => {
  const dir=mkdtempSync(join(tmpdir(),'atomgit-dry-run-'))
  try {
    const path=join(dir,'catalog.json');writeFileSync(path,JSON.stringify(metadataFixture()))
    const result=spawnSync(process.execPath,[join(import.meta.dirname,'publish-atomgit.mjs'),'--metadata-only','--catalog',path,'--assets',join(dir,'missing-assets')],{encoding:'utf8',timeout:5000,windowsHide:true})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/Dry run:.*windows-x86_64, darwin-aarch64/)
    assert.deepEqual(readdirSync(dir),['catalog.json'])
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('不可变清单覆盖全部平台；单个平台未准备好时禁止任何远端写入', async () => {
  const catalog = metadataFixture()
  assert.deepEqual(Object.keys(atomgitManifest(catalog).platforms), ['windows-x86_64','darwin-aarch64'])
  catalog.artifacts[1].sources.atomgit.verified = false
  let calls = 0
  await assert.rejects(publishMetadata(async () => { calls++ }, 'v3.30.0', tmpdir(), catalog, async () => { calls++ }), /All update platforms/)
  assert.equal(calls, 0)
})
test('仅补齐元数据，不再传安装包；读回 latest 和目录均为完整版本', async () => {
  const dir = mkdtempSync(join(tmpdir(),'atomgit-metadata-')), catalog = metadataFixture(), files = new Map(), uploads = []
  const api = async path => { const name = new URL(`https://fixture.test${path}`).searchParams.get('file_name'); uploads.push(name); return {url:`https://upload.example.test/${name}`} }
  const request = async (url, options = {}) => {
    const parsed = new URL(url), name = decodeURIComponent(parsed.hostname.startsWith('upload') ? parsed.pathname.slice(1) : parsed.pathname.split('/').at(-2))
    if (options.method === 'PUT') { const chunks=[]; for await (const chunk of options.body) chunks.push(chunk); files.set(name,Buffer.concat(chunks)); return new Response(null,{status:200}) }
    const body=files.get(name)
    if (!body) return new Response(null,{status:404})
    if (options.headers?.Range) { const part=body.subarray(0,options.headers.Range==='bytes=0-0'?1:1024); return new Response(part,{status:206,headers:{'content-range':`bytes 0-${part.length-1}/${body.length}`}}) }
    return new Response(body)
  }
  const original = Buffer.from(JSON.stringify(catalog))
  await publishMetadata(api,'v3.30.0',dir,catalog,request,original)
  await publishMetadata(api,'v3.30.0',dir,catalog,request,original)
  assert.deepEqual(uploads,['latest.json','release-catalog.json'])
  assert.deepEqual(Object.keys(JSON.parse(files.get('latest.json')).platforms),['windows-x86_64','darwin-aarch64'])
  assert.deepEqual(JSON.parse(files.get('release-catalog.json')),catalog)
  assert.deepEqual(files.get('release-catalog.json'),original,'mirror must preserve the policy-pinned raw bytes including formatting')
})

test('markLatest：已是 latest 零写入；否则 PATCH 钉版且保留原 name/body', async () => {
  const calls = []
  const mk = status => async (path, options = {}) => { calls.push({ path, options }); return { name: 'v3.36.1 标题', body: '正文', release_status: status } }
  assert.equal(await markLatest(mk('latest'), 'v3.36.1'), false)
  assert.equal(calls.length, 1, '已是最新时只读一次，不写')
  assert.equal(await markLatest(mk('none'), 'v3.36.1'), true)
  const patch = calls.find(c => c.options.method === 'PATCH')
  assert.equal(patch.path, '/releases/v3.36.1')
  const payload = JSON.parse(patch.options.body)
  assert.equal(payload.release_status, 'latest')
  assert.equal(payload.name, 'v3.36.1 标题', 'PATCH 必须带回 name（缺省 400）')
  assert.equal(payload.body, '正文', 'PATCH 必须带回 body（缺省 400）')
})

test('markLatest：原 body 为空时用 GitHub 链接兜底（平台拒空 body）', async () => {
  let patched
  const api = async (path, options = {}) => { if (options.method === 'PATCH') patched = JSON.parse(options.body); return { name: '', body: '', release_status: 'none' } }
  await markLatest(api, 'v3.36.1')
  assert.equal(patched.name, 'v3.36.1')
  assert.match(patched.body, /github\.com\/huiliyi37\/Tianshu-harness\/releases\/tag\/v3\.36\.1/)
})

test('ensureRelease：release 存在时零写入；404 且 tag 已镜像时自建且 notes 空走兜底', async () => {
  const writes = []
  const existing = async path => { if (path === '/releases') writes.push(path); return { tag_name: 'v3.36.1' } }
  const release = await ensureRelease(existing, 'v3.36.1', 'anything', () => 'unused')
  assert.equal(release.tag_name, 'v3.36.1')
  assert.equal(writes.length, 0, '已存在时不得 POST')

  let created
  const missing = async (path, options = {}) => {
    if (options.method === 'POST') { created = JSON.parse(options.body); return created }
    const e = new Error('not found'); e.status = 404; throw e
  }
  await ensureRelease(missing, 'v3.36.1', '  ', () => 'abc123\trefs/tags/v3.36.1')
  assert.equal(created.tag_name, 'v3.36.1')
  assert.equal(created.release_status, 'latest', '自建即钉最新')
  assert.ok(created.body.trim().length > 0, '空 notes 必须兜底成非空 body')

  await assert.rejects(ensureRelease(missing, 'v3.36.1', '', () => ''), /tag must be mirrored/, 'tag 未镜像时拒绝自建')
})
