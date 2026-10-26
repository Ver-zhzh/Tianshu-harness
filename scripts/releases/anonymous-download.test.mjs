import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyAnonymousDownload } from './anonymous-download.mjs'

const BODY = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 251))
const SHA256 = createHash('sha256').update(BODY).digest('hex')
const URL = 'https://downloads.fixture.test/release.bin'
const expected = { size: BODY.length, sha256: SHA256 }

function harness({ fullBody = BODY, fullStatus = 200, rangeBody, rangeStatus = 206, contentRange, fullHeaders = {}, rangeHeaders = {}, rejectFull = false, rejectRange = false } = {}) {
  const calls = []
  const request = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (options.headers?.Range) {
      if (rejectRange) throw new Error('offline')
      const end = Number(options.headers.Range.split('-')[1])
      const body = rangeBody ?? BODY.subarray(0, end + 1)
      return new Response(body, { status: rangeStatus, headers: { 'content-range': contentRange ?? `bytes 0-${end}/${fullBody.length}`, ...rangeHeaders } })
    }
    if (rejectFull) throw new Error('offline')
    return new Response(fullBody, { status: fullStatus, headers: fullHeaders })
  }
  return { request, calls }
}

test('anonymous full stream and exact Range produce a proof without retaining package bytes or sending credentials', async () => {
  const { request, calls } = harness()
  const proof = await verifyAnonymousDownload({ url: URL, expected, request })
  assert.equal(proof.verified, true)
  assert.equal(proof.anonymous, true)
  assert.equal(proof.size, BODY.length)
  assert.equal(proof.sha256, SHA256)
  assert.equal(proof.bytes, undefined)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.headers.Range, 'bytes=0-1023')
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.headers.Authorization, undefined)
    assert.equal(call.options.headers.Cookie, undefined)
  }
})

test('small metadata can be collected after the same full-byte and Range checks', async () => {
  const body = Buffer.from('{"version":"1.2.3"}\n')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const { request } = harness({ fullBody: body, rangeBody: body })
  const proof = await verifyAnonymousDownload({ url: URL, expected: { size: body.length, sha256 }, request, collect: true })
  assert.deepEqual(proof.bytes, body)
})

test('anonymous network failure, login page, truncation and wrong digest never verify', async t => {
  const cases = [
    ['anonymous failure', { rejectFull: true }, /anonymous request failed/],
    ['login page', { fullBody: Buffer.from('<html>login</html>') }, /size/],
    ['truncated body', { fullBody: BODY.subarray(0, BODY.length - 1) }, /size/],
    ['wrong digest', {}, /sha256/],
  ]
  for (const [name, options, error] of cases) await t.test(name, async () => {
    const { request, calls } = harness(options)
    await assert.rejects(verifyAnonymousDownload({ url: URL, expected: name === 'wrong digest' ? { size: BODY.length, sha256: '0'.repeat(64) } : expected, request }), error)
    assert.equal(calls.length, 1, 'failed full-byte validation must not issue a Range request')
  })
})

test('ignored, incorrect, truncated and byte-mismatched Range responses never verify', async t => {
  const cases = [
    ['ignored Range', { rangeStatus: 200, rangeBody: BODY }, /HTTP 206/],
    ['wrong interval', { contentRange: `bytes 1-1024/${BODY.length}` }, /Content-Range/],
    ['wrong total', { contentRange: `bytes 0-1023/${BODY.length + 1}` }, /Content-Range/],
    ['truncated Range', { rangeBody: BODY.subarray(0, 100) }, /Range bytes|invalid or truncated/],
    ['wrong Range bytes', { rangeBody: Buffer.alloc(1024, 7) }, /Range bytes/],
    ['anonymous Range failure', { rejectRange: true }, /Range request failed/],
  ]
  for (const [name, options, error] of cases) await t.test(name, async () => {
    const { request } = harness(options)
    await assert.rejects(verifyAnonymousDownload({ url: URL, expected, request }), error)
  })
})

test('credential-bearing or temporary URLs are rejected before any request', async () => {
  let calls = 0
  const request = async () => { calls++; throw new Error('must not fetch') }
  for (const url of ['https://user:pass@downloads.fixture.test/release.bin', 'https://downloads.fixture.test/release.bin?token=private']) {
    await assert.rejects(verifyAnonymousDownload({ url, expected, request }), /stable public HTTPS/)
  }
  assert.equal(calls, 0)
})
