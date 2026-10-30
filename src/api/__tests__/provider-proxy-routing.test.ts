import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { createProviderClient } from '../factory.js'
import { cloneProviderPreset } from '../../config/provider-presets.js'
import { resolveCapabilities } from '../provider.js'
import { providerDispatcher } from '../provider-network.js'

test('default-port bypass returns the explicit direct dispatcher at the provider boundary', () => {
  const proxy = 'http://127.0.0.1:1'
  const direct = providerDispatcher('http://127.0.0.1:8787/', { proxy, noProxy: '127.0.0.1:8787' })
  assert.ok(direct)
  assert.equal(
    providerDispatcher('https://default-port.fixture.invalid/', {
      proxy,
      noProxy: 'default-port.fixture.invalid:443',
    }),
    direct,
  )
})

const text = 'routed-ok'
const events = {
  openai: [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }],
  'openai-responses': [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {} }],
  anthropic: [{ type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
  gemini: [{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }],
}

for (const protocol of ['openai', 'openai-responses', 'anthropic', 'gemini'] as const) {
  for (const source of ['provider', 'network', 'empty-provider', 'environment', 'provider-bypass', 'network-bypass', 'empty-bypass-env'] as const) {
    test(`${protocol}: actual factory request respects ${source}`, async () => {
      const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
      const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
      for (const key of keys) delete process.env[key]
      process.env.RIVET_NO_SYSTEM_PROXY = '1'
      const sockets = new Set<Socket>()
      const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
      const target = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(events[protocol].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      })
      let tunnels = 0
      const proxy = createServer((req, res) => {
        tunnels++
        const upstream = request({ hostname: '127.0.0.1', port: targetPort, path: new URL(req.url!).pathname, method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode!, response.headers); response.pipe(res)
        })
        upstream.on('error', () => { res.writeHead(502); res.end() })
        req.pipe(upstream)
      })
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
        const bypass = source.includes('bypass')
        // Invalid global/env proxies prove provider settings take precedence.
        process.env.HTTP_PROXY = source === 'environment' ? proxyUrl : 'http://127.0.0.1:1'
        if (source === 'empty-bypass-env') process.env.NO_PROXY = '127.0.0.1'
        const provider = { ...cloneProviderPreset('deepseek'), name: `fixture-${protocol}`, protocol, maxRetries: 0,
          baseUrl: `http://${bypass ? '127.0.0.1' : 'model.fixture.invalid'}:${targetPort}`,
          ...(source === 'empty-provider' ? { proxy: ' ' } : source === 'provider' || source === 'provider-bypass' ? { proxy: proxyUrl } : {}) }
        const network = { proxy: source === 'network' || source === 'network-bypass' || source === 'empty-provider' ? proxyUrl
          : source === 'provider' ? 'http://127.0.0.1:1' : undefined,
          noProxy: source === 'empty-bypass-env' ? '' : bypass ? '127.0.0.1' : undefined }
        const client = createProviderClient(provider, resolveCapabilities('deepseek'), {
          apiKey: 'fixture', model: provider.models[0]!.id, maxTokens: 128, network,
        })
        let output = ''
        await client.stream({ model: provider.models[0]!.id, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 128 }, {
          onTextDelta: delta => { output += delta }, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {},
          onError(error) { throw error },
        }, AbortSignal.timeout(3000))
        assert.equal(output, text)
        assert.equal(tunnels, bypass ? 0 : 1)
      } finally {
        for (const socket of sockets) socket.destroy()
        await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
      }
    })
  }
}
