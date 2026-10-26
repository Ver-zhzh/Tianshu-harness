import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const ATOMGIT_GIT_URL = 'https://atomgit.com/huiliyi37/Tianshu-harness.git'
const ATOMGIT_API_BASE = 'https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness'
const RANGE_LIMIT = 1024
const COLLECT_LIMIT = 256 * 1024

export const atomgitDownloadURL = (tag, name) => `${ATOMGIT_API_BASE}/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(name)}/download`

export function probeAtomgitTag(tag) {
  return execFileSync('git', ['ls-remote', '--tags', ATOMGIT_GIT_URL, `refs/tags/${tag}`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true }).toString()
}

function stableURL(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Anonymous verification requires a stable public HTTPS endpoint without credentials or query parameters')
  return url.href
}

function failed(url, stage, detail) {
  return Object.assign(new Error(`Anonymous download verification failed [${stage}] ${url}: ${detail}`), { code: 'ANONYMOUS_DOWNLOAD_INVALID', url, stage })
}

function declaredLength(response, url, stage) {
  const raw = response.headers.get('content-length')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw failed(url, stage, 'invalid Content-Length')
  return Number(raw)
}

async function discard(response) {
  try { await response.body?.cancel() } catch {}
}

function checkExpected(expected) {
  if (expected === undefined) return
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Anonymous verification requires a positive size and lowercase SHA-256')
}

export function assertAnonymousProof(proof, expected = {}) {
  if (!proof || proof.verified !== true || proof.anonymous !== true || !Number.isSafeInteger(proof.size) || proof.size <= 0 || !/^[a-f0-9]{64}$/.test(proof.sha256) || !Number.isFinite(Date.parse(proof.verifiedAt))) throw new Error('Anonymous verifier did not produce a valid proof')
  for (const key of ['url', 'size', 'sha256']) if (expected[key] !== undefined && proof[key] !== expected[key]) throw new Error(`Anonymous proof ${key} mismatch`)
  return proof
}

export async function verifyAnonymousDownload({ url: rawURL, expected, request = fetch, collect = false, timeoutMs = 30 * 60 * 1000, notFoundRetries = 0, retryDelayMs = 3000, now = () => new Date() }) {
  const url = stableURL(rawURL)
  checkExpected(expected)
  if (collect && expected && expected.size > COLLECT_LIMIT) throw failed(url, 'full-read', 'metadata exceeds 256 KiB')
  const common = { redirect: 'follow', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }
  let response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await request(url, { ...common, headers: { Accept: 'application/octet-stream', 'Cache-Control': 'no-store' }, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw failed(url, 'full-read', 'anonymous request failed')
    }
    if (response.status !== 404 || attempt >= notFoundRetries) break
    await discard(response)
    await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
  if (response.status !== 200 || !response.body) {
    await discard(response)
    throw failed(url, 'full-read', `expected HTTP 200, received ${response.status}`)
  }
  const fullLength = declaredLength(response, url, 'full-read')
  if ((expected && fullLength !== undefined && fullLength !== expected.size) || (collect && fullLength > COLLECT_LIMIT)) {
    await discard(response)
    throw failed(url, 'size', `Content-Length ${fullLength} does not match the expected size`)
  }
  const hash = createHash('sha256')
  const prefix = []
  const collected = []
  let prefixLength = 0
  let size = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      size += chunk.length
      if ((expected && size > expected.size) || (collect && size > COLLECT_LIMIT)) throw new Error('too large')
      hash.update(chunk)
      if (prefixLength < RANGE_LIMIT) {
        const part = chunk.subarray(0, RANGE_LIMIT - prefixLength)
        prefix.push(part)
        prefixLength += part.length
      }
      if (collect) collected.push(chunk)
    }
  } catch {
    throw failed(url, 'full-read', 'response stream ended early or exceeded its limit')
  }
  const sha256 = hash.digest('hex')
  if (fullLength !== undefined && size !== fullLength) throw failed(url, 'size', `received ${size} bytes, Content-Length declared ${fullLength}`)
  if (expected && size !== expected.size) throw failed(url, 'size', `expected ${expected.size}, received ${size}`)
  if (expected && sha256 !== expected.sha256) throw failed(url, 'sha256', `expected ${expected.sha256}, received ${sha256}`)
  if (size <= 0) throw failed(url, 'full-read', 'empty response body')
  const expectedPrefix = Buffer.concat(prefix, prefixLength)
  const rangeEnd = expectedPrefix.length - 1
  let range
  try {
    range = await request(url, { ...common, headers: { Range: `bytes=0-${rangeEnd}`, 'Cache-Control': 'no-store' }, signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)) })
  } catch {
    throw failed(url, 'range', 'anonymous Range request failed')
  }
  const expectedContentRange = `bytes 0-${rangeEnd}/${size}`
  if (range.status !== 206 || !range.body || range.headers.get('content-range') !== expectedContentRange) {
    await discard(range)
    throw failed(url, 'range', `expected HTTP 206 with Content-Range ${expectedContentRange}`)
  }
  const rangeLength = declaredLength(range, url, 'range')
  if (rangeLength !== undefined && rangeLength !== expectedPrefix.length) {
    await discard(range)
    throw failed(url, 'range', `expected ${expectedPrefix.length} bytes, Content-Length declared ${rangeLength}`)
  }
  const rangeChunks = []
  let rangeSize = 0
  try {
    for await (const value of range.body) {
      const chunk = Buffer.from(value)
      rangeSize += chunk.length
      if (rangeSize > expectedPrefix.length) throw new Error('too large')
      rangeChunks.push(chunk)
    }
  } catch {
    throw failed(url, 'range', 'invalid or truncated Range response')
  }
  if (rangeSize !== expectedPrefix.length || !Buffer.concat(rangeChunks, rangeSize).equals(expectedPrefix)) throw failed(url, 'range', 'Range bytes do not match the full download prefix')
  const proof = assertAnonymousProof({ url, verified: true, anonymous: true, verifiedAt: now().toISOString(), size, sha256 }, { url, ...(expected ? { size: expected.size, sha256: expected.sha256 } : {}) })
  return collect ? { ...proof, bytes: Buffer.concat(collected, size) } : proof
}
