import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthAuth } from '../../auth/oauth-auth.js'
import { TokenStore } from '../../auth/token-store.js'
import { createProviderClient } from '../factory.js'
import { cloneProviderPreset } from '../../config/provider-presets.js'
import { resolveCapabilities } from '../provider.js'

for (const source of ['provider', 'network', 'environment', 'bypass'] as const) {
  test(`Codex transport respects ${source} proxy routing without an interactive bootstrap`, async () => {
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
    const sockets = new Set<Socket>()
    const authDir = mkdtempSync(join(tmpdir(), 'codex-proxy-auth-'))
    const target = createServer((req, res) => {
      if (req.url === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'fixture-renewed', expires_in: 3600 }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"type":"response.output_text.delta","delta":"proxy-fixture-ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
    })
    const proxy = createServer((req, res) => {
      tunnels++
      const forwarded = request({ hostname: '127.0.0.1', port: targetPort, path: new URL(req.url!).pathname, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode!, response.headers); response.pipe(res)
      })
      forwarded.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(forwarded)
    })
    let tunnels = 0
    const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
    target.on('connection', track); proxy.on('connection', track)
    target.listen(0, '127.0.0.1'); await once(target, 'listening')
    const targetPort = (target.address() as { port: number }).port
    proxy.on('connect', (_req, client, head) => {
      tunnels++
      const upstream = connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      track(upstream)
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
    })
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
    try {
      if (source === 'environment' || source === 'bypass') process.env.HTTPS_PROXY = proxyUrl
      if (source === 'bypass') process.env.NO_PROXY = '127.0.0.1'
      const provider = { ...cloneProviderPreset('codex'), name: 'codex-fixture', maxRetries: 0,
        baseUrl: `http://${source === 'bypass' ? '127.0.0.1' : 'codex.fixture.invalid'}:${targetPort}`,
        ...(source === 'provider' ? { proxy: proxyUrl } : {}) }
      const client = createProviderClient(provider, resolveCapabilities('codex'), {
        apiKey: '', model: provider.models[0]!.id, maxTokens: 128,
        network: source === 'network' ? { proxy: proxyUrl } : undefined,
        auth: { isAuthenticated: () => true, getHeaders: async () => ({ Authorization: 'Bearer fixture' }), authenticate: async () => {}, dispose: () => {} },
      })
      let text = ''
      await client.stream({ model: provider.models[0]!.id, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 128 }, {
        onTextDelta: delta => { text += delta }, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {},
      }, AbortSignal.timeout(3000))
      assert.equal(text, 'proxy-fixture-ok')
      assert.equal(tunnels, source === 'bypass' ? 0 : 1)
      new TokenStore(authDir, 'codex').save({ accessToken: 'fixture-expiring', refreshToken: 'fixture-refresh', accountId: 'fixture-account', expiresAt: Date.now() + 1000 })
      const auth = new OAuthAuth({ clientId: 'fixture', tokenEndpoint: `${provider.baseUrl}/oauth/token`, importCliAuth: false,
        network: source === 'provider' || source === 'network' ? { proxy: proxyUrl } : undefined }, authDir)
      try {
        assert.equal((await auth.getHeaders()).Authorization, 'Bearer fixture-renewed')
        assert.equal(tunnels, source === 'bypass' ? 0 : 2)
      } finally { auth.dispose() }
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
      rmSync(authDir, { recursive: true, force: true })
    }
  })
}
