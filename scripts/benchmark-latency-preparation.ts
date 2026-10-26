import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, arch, platform } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { createVisionImagePreview } from '../src/utils/vision-image-core.js'
import { imageBudgetSignature, prepareImageBudgetCandidate } from '../src/agent/image-budget.js'
import { ResponsesClient } from '../src/api/responses-client.js'
import { readCallAudit } from '../src/api/call-audit.js'
import { TokenBucket } from '../src/api/rate-limiter.js'
import type { ArtifactStore } from '../src/artifact/store.js'
import type { OaiMessage } from '../src/api/oai-types.js'

const { values } = parseArgs({ options: { 'baseline-ref': { type: 'string' }, output: { type: 'string' }, rounds: { type: 'string', default: '7' } } })
if (!values['baseline-ref'] || !values.output) throw new Error('--baseline-ref and --output are required')
const rounds = Number(values.rounds)
if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 30) throw new Error('--rounds must be 3..30')
const root = mkdtempSync(join(tmpdir(), 'latency-preparation-bench-')), baseline = join(root, 'baseline')
mkdirSync(join(baseline, 'src'), { recursive: true })
writeFileSync(join(baseline, 'package.json'), '{"type":"module"}')
symlinkSync(resolve('node_modules'), join(baseline, 'node_modules'), 'dir')
for (const entry of readdirSync(resolve('src'), { withFileTypes: true })) {
  const target = join(baseline, 'src', entry.name)
  if (!['api', 'agent', 'utils'].includes(entry.name)) symlinkSync(resolve('src', entry.name), target, entry.isDirectory() ? 'dir' : 'file')
  else {
    mkdirSync(target)
    for (const child of readdirSync(resolve('src', entry.name))) symlinkSync(resolve('src', entry.name, child), join(target, child))
  }
}
for (const file of ['src/utils/vision-image-core.ts', 'src/utils/image-bytes.ts', 'src/agent/image-budget.ts',
  'src/api/responses-client.ts', 'src/api/fetch-timeout.ts', 'src/api/call-audit.ts', 'src/api/request-observability.ts']) {
  const target = join(baseline, file)
  unlinkSync(target)
  writeFileSync(target, execFileSync('rtk', ['proxy', 'git', 'show', `${values['baseline-ref']}:${file}`], { windowsHide: true }))
}
const oldVision: typeof import('../src/utils/vision-image-core.js') = await import(pathToFileURL(join(baseline, 'src/utils/vision-image-core.ts')).href)
const oldBudget: typeof import('../src/agent/image-budget.js') = await import(pathToFileURL(join(baseline, 'src/agent/image-budget.ts')).href)
const oldResponses: typeof import('../src/api/responses-client.js') = await import(pathToFileURL(join(baseline, 'src/api/responses-client.ts')).href)

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)]!, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! }
}
async function paired(before: () => unknown, after: () => unknown) {
  await before(); await after() // Exclude module/WASM startup from steady CPU work.
  const a: number[] = [], b: number[] = []
  for (let round = 0; round < rounds; round++) for (const arm of round % 2 ? [1, 0] : [0, 1]) {
    globalThis.gc?.()
    const start = performance.now()
    await (arm ? after() : before())
    ;(arm ? b : a).push(performance.now() - start)
  }
  const baseline = stats(a), candidate = stats(b)
  return { baseline, candidate, medianReduction: 1 - candidate.medianMs / baseline.medianMs }
}
function fixtureImage(kind: string): string {
  const image = new PNG({ width: kind === 'noise' ? 2001 : 2400, height: kind === 'noise' ? 1000 : 160 })
  let seed = 7
  for (let i = 0; i < image.data.length; i += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    image.data[i] = kind === 'noise' ? seed & 255 : 240
    image.data[i + 1] = kind === 'noise' ? (seed >>> 8) & 255 : 240
    image.data[i + 2] = kind === 'noise' ? (seed >>> 16) & 255 : 240
    image.data[i + 3] = kind === 'transparent' && i % 8 === 0 ? 0 : 255
  }
  return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`
}
const imageResults = []
for (const kind of ['opaque', 'noise', 'transparent']) {
  const image = fixtureImage(kind)
  const count = async (process: typeof createVisionImagePreview) => {
    const original = PhotonImage.prototype.get_bytes_jpeg, qualities: number[] = []
    PhotonImage.prototype.get_bytes_jpeg = function (quality) { qualities.push(quality); return original.call(this, quality) }
    try { return { result: await process(image), jpegEncodes: qualities } } finally { PhotonImage.prototype.get_bytes_jpeg = original }
  }
  const a = await count(oldVision.createVisionImagePreview), b = await count(createVisionImagePreview)
  assert.deepEqual(b.result, a.result, `${kind}: output bytes or dimensions changed`)
  imageResults.push({ fixture: kind, inputBytes: Buffer.byteLength(image), outputBytes: Buffer.byteLength(b.result.dataUrl),
    identical: true, jpegEncodesBefore: a.jpegEncodes, jpegEncodesAfter: b.jpegEncodes,
    timing: await paired(() => oldVision.createVisionImagePreview(image), () => createVisionImagePreview(image)) })
}

const historyResults = []
for (const [megabytes, count] of [[17, 10], [34, 23], [52, 22]]) {
  const urls = Array.from({ length: count! }, (_, index) => `data:image/png;base64,${String(index % 10).repeat(Math.floor(megabytes! * 1_000_000 / count!))}`)
  const messages: OaiMessage[] = urls.map((url, index) => ({ role: 'user', content: [{ type: 'text', text: `Frame ${index} 中文` }, { type: 'image_url', image_url: { url } }] }))
  const active: OaiMessage = { role: 'user', content: 'Keep current requirements' }; messages.push(active)
  const raw = new Map(urls.map(url => [`context-image:${createHash('sha256').update(url).digest('hex')}`, url]))
  const store = { listByTarget: (target: string) => raw.has(target) ? [{ tool: 'context-image', id: target }] : [],
    readRaw: async (id: string) => raw.get(id), confirmDurable: async () => {}, saveDurable: async () => { throw new Error('fixture must already be archived') } } as unknown as ArtifactStore
  const sourceBytes = Buffer.byteLength(JSON.stringify(messages))
  const options = { protectedUser: active, wireBytes: sourceBytes + 1000, sourceBytes,
    prepare: async (_store: ArtifactStore | undefined, images: string[]) => ({ images, notice: '', refs: [] }) }
  const before = () => oldBudget.prepareImageBudgetCandidate(store, messages, options)
  const after = () => prepareImageBudgetCandidate(store, messages, options)
  assert.deepEqual(await after(), await before(), 'history candidate must remain byte-identical')
  historyResults.push({ inputBytes: sourceBytes, identical: true,
    candidateTiming: await paired(before, after), signatureTiming: await paired(() => oldBudget.imageBudgetSignature(messages, active), () => imageBudgetSignature(messages, active)) })
}

// Controlled local waits measure missing observability, not a provider speedup.
const home = process.env.RIVET_HOME, realFetch = globalThis.fetch, acquire = TokenBucket.prototype.acquire
const nativeResults = []
try {
  process.env.RIVET_HOME = join(root, 'home')
  globalThis.fetch = async () => { await delay(3); return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }
  TokenBucket.prototype.acquire = async () => { await delay(18) }
  for (const [arm, Client] of [['baseline', oldResponses.ResponsesClient], ['candidate', ResponsesClient]] as const) {
    const samples = []
    const seen = new Set(readCallAudit().calls.map(row => row.operationId))
    for (let trial = 0; trial < rounds; trial++) {
      const client = new Client({ baseUrl: 'https://local.fixture.invalid', apiKey: '', model: 'fixture', maxTokens: 64, maxRetries: 0,
        retry: { rateLimit: { requestsPerSecond: 1 } }, auth: { getHeaders: async () => { await delay(12); return {} }, isAuthenticated: () => true, authenticate: async () => {}, dispose() {} } })
      const start = performance.now()
      await client.stream({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 },
        { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } })
      const totalMs = performance.now() - start
      const row = readCallAudit().calls.find(row => !seen.has(row.operationId))!
      seen.add(row.operationId)
      samples.push({ totalMs, preparationMs: row.requestPreparationMs!, authMs: row.authenticationMs, queueMs: row.rateLimitWaitMs })
    }
    nativeResults.push({ arm, total: stats(samples.map(s => s.totalMs)), reportedPreparation: stats(samples.map(s => s.preparationMs)), samples })
  }
} finally {
  globalThis.fetch = realFetch; TokenBucket.prototype.acquire = acquire
  if (home === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = home
}
const report = { baselineRef: values['baseline-ref'], rounds, node: process.version, platform: platform(), arch: arch(),
  limitations: ['synthetic image/history fixtures; in-memory confirmed archives exclude disk durability cost', 'warm WASM; timings depend on host load', 'native waits are controlled local fixtures, not model/network speed gains'],
  images: imageResults, histories: historyResults, native: nativeResults }
mkdirSync(dirname(resolve(values.output)), { recursive: true })
writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + '\n')
rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
