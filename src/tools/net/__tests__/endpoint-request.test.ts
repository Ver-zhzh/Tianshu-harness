import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { endpointRequest, endpointDownload } from '../endpoint-request.js'
import { endpointAddressClass, endpointUrl, proxyOrigin, EndpointNetworkError } from '../endpoint-policy.js'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const reply = () => new Response('{}', { headers: { 'content-type': 'application/json' } })
const denied = (code: string) => (error: unknown) => error instanceof EndpointNetworkError && error.code === code

for (const target of ['http://127.0.0.1', 'http://10.1.2.3', 'http://[::1]', 'http://[fd00::1]', 'http://2130706433']) {
  test(`default private rejection before fetch: ${target}`, async () => {
    let calls = 0
    await assert.rejects(endpointRequest(target, {}, { fetchImpl: async () => { calls++; return reply() } }), denied('endpoint_private_network_denied'))
    assert.equal(calls, 0)
  })
}
for (const address of ['169.254.169.254', '100.100.100.200', '0.0.0.0', '198.18.0.1', '224.0.0.1', '[fe80::1]', '[::ffff:169.254.169.254]', '[64:ff9b::a9fe:a9fe]']) {
  test(`local permission never grants reserved address: ${address}`, async () => {
    const raw = `http://${address}/`, origin = endpointUrl(raw).origin
    let calls = 0
    await assert.rejects(endpointRequest(raw, {}, { endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, fetchImpl: async () => { calls++; return reply() } }), denied('endpoint_reserved_address_denied'))
    assert.equal(calls, 0)
  })
}
test('all DNS answers are validated and failures never silently allow fetch', async () => {
  for (const lookupImpl of [async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }], async () => { throw new Error('DNS unavailable') }]) {
    let calls = 0
    await assert.rejects(endpointRequest('https://endpoint.example', {}, { lookupImpl, fetchImpl: async () => { calls++; return reply() } }), EndpointNetworkError)
    assert.equal(calls, 0)
  }
  assert.equal(endpointAddressClass('fd00::1'), 'local')
  assert.equal(endpointAddressClass('garbage'), 'reserved')
  assert.throws(() => endpointUrl('https://user:password@example.com'), denied('endpoint_invalid_url'))
})

test('real local request pins the validated DNS address and preserves Host', async t => {
  const previousPin = process.env.RIVET_FETCH_PIN; process.env.RIVET_FETCH_PIN = '0'
  t.after(() => { if (previousPin === undefined) delete process.env.RIVET_FETCH_PIN; else process.env.RIVET_FETCH_PIN = previousPin })
  let hits = 0, host = ''
  const server = createServer((req, res) => { hits++; host = req.headers.host ?? ''; res.end('{}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as { port: number }).port, origin = `http://endpoint.invalid:${port}`
  let lookups = 0
  const response = await endpointRequest(origin + '/models', {}, { proxy: { noProxy: '*' }, endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, lookupImpl: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] } })
  assert.equal(response.status, 200); assert.equal(hits, 1); assert.equal(lookups, 1)
  assert.equal(host, `endpoint.invalid:${port}`)
  await assert.rejects(endpointRequest(origin, {}, { endpointNetworkPolicy: { origin: `http://endpoint.invalid:${port + 1}`, allowPrivateNetwork: true } }), denied('endpoint_policy_mismatch'))
})

for (const status of [301, 302, 303, 307, 308]) test(`endpoint ${status} never forwards a request`, async () => {
  let calls = 0
  await assert.rejects(endpointRequest('https://public.example', { method: 'POST', body: 'fixture' }, {
    lookupImpl: publicLookup, fetchImpl: async (_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status, headers: { location: 'http://127.0.0.1/sink' } }) },
  }), denied('endpoint_redirect_blocked'))
  assert.equal(calls, 1)
})

test('download local grant is same-origin only and carries no provider authorization', async () => {
  const origin = 'http://127.0.0.1:8123'
  const options = { endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, maxBytes: 100,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => { assert.equal(init?.method, 'GET'); assert.equal(init?.headers, undefined); return new Response('image') } }
  assert.equal((await endpointDownload(origin + '/image', options)).bytes.length, 5)
  await assert.rejects(endpointDownload('http://127.0.0.1:8124/image', options), denied('endpoint_download_origin_denied'))
})

test('download redirects revalidate each target and cannot expand local permission', async () => {
  let calls = 0
  const options = { lookupImpl: publicLookup, maxBytes: 100, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/image' } }) : new Response('unexpected')
  } }
  await assert.rejects(endpointDownload('https://cdn.example/image', options), denied('endpoint_reserved_address_denied'))
  assert.equal(calls, 1)
})

test('deadline covers DNS and slow body; byte limits fail closed', async t => {
  let calls = 0
  await assert.rejects(endpointRequest('https://slow.example', {}, { timeoutMs: 20, lookupImpl: () => new Promise(resolve => setTimeout(() => resolve([{ address: '93.184.216.34' }]), 80)), fetchImpl: async () => { calls++; return reply() } }), denied('endpoint_timeout'))
  assert.equal(calls, 0)
  const server = createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); const timer = setTimeout(() => res.end('{}'), 200); res.once('close', () => clearTimeout(timer)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await assert.rejects(endpointRequest(origin, {}, { endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, proxy: { noProxy: '*' }, timeoutMs: 50 }), denied('endpoint_timeout'))
  await assert.rejects(endpointRequest('https://large.example', {}, { lookupImpl: publicLookup, fetchImpl: async () => new Response('too large'), maxBytes: 2 }), denied('endpoint_response_too_large'))
})

test('trusted proxy DNS is bound to the actual proxy and cannot apply on NO_PROXY', async t => {
  const proxy = createServer((_req, res) => res.end('{}'))
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, origin = 'http://proxy-only.invalid'
  const options = { endpointNetworkPolicy: { origin, proxyDns: 'trusted-proxy' as const, proxyOrigin: proxyOrigin(proxyUrl) }, proxy: { proxyUrl, noProxy: '' }, lookupImpl: async () => { throw new Error('proxy-only DNS') } }
  assert.equal((await endpointRequest(origin, {}, options)).status, 200)
  await assert.rejects(endpointRequest(origin, {}, { ...options, proxy: { proxyUrl, noProxy: '*' } }), denied('endpoint_policy_mismatch'))
  await assert.rejects(endpointRequest(origin, {}, { ...options, endpointNetworkPolicy: { ...options.endpointNetworkPolicy, proxyOrigin: 'http://localhost:1234' } }), denied('endpoint_policy_mismatch'))
})

test('RIVET_FETCH_PIN=0 cannot disable endpoint pinning; cancellation during DNS prevents a later send', async t => {
  const previous = process.env.RIVET_FETCH_PIN; process.env.RIVET_FETCH_PIN = '0'
  t.after(() => { if (previous === undefined) delete process.env.RIVET_FETCH_PIN; else process.env.RIVET_FETCH_PIN = previous })
  const controller = new AbortController(); let calls = 0
  const pending = endpointRequest('http://cancel.invalid', {}, { signal: controller.signal, lookupImpl: () => new Promise(resolve => setTimeout(() => resolve([{ address: '93.184.216.34' }]), 30)), fetchImpl: async () => { calls++; return reply() } })
  controller.abort(new Error('cancelled during DNS'))
  await assert.rejects(pending, /cancelled during DNS/)
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, 0)
  await assert.rejects(endpointRequest('http://127.0.0.1', {}), denied('endpoint_private_network_denied'))
})

test('fake-IP exception needs an actual proxy and never authorizes a literal or known reserved answer', async t => {
  let hits = 0
  const proxy = createServer((_req, res) => { hits++; res.end('{}') })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const options = { proxy: { proxyUrl, noProxy: '' }, trustProxyFakeIp: true, lookupImpl: async () => [{ address: '198.18.0.1' }] }
  assert.equal((await endpointRequest('http://fake.invalid', {}, options)).status, 200)
  await assert.rejects(endpointRequest('http://fake.invalid', {}, { ...options, proxy: { noProxy: '*' } }), denied('endpoint_reserved_address_denied'))
  await assert.rejects(endpointRequest('http://198.18.0.1', {}, options), denied('endpoint_reserved_address_denied'))
  await assert.rejects(endpointRequest('http://metadata.invalid', {}, { ...options, lookupImpl: async () => [{ address: '169.254.169.254' }] }), denied('endpoint_reserved_address_denied'))
  assert.equal(hits, 1)
})
