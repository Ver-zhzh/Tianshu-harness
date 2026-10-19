import { probeForTestKey } from '../provider-probe-adapter.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { buildImageGenerationRoutes } from '../image-generation-routes.js'
import { loadConfig, saveConfig, registerProvider, setupProvider } from '../../config/manager.js'
import { configSchema } from '../../config/schema.js'
import { generateImage } from '../../api/image-gen-client.js'
import { discoverVisionModels, validateVisionModel } from '../../api/vision-model-onboarding.js'
import { probeProvider } from '../../api/provider-probe.js'
import { ImageGenerationService } from '../../api/image-generation-service.js'
import { createGenerateImageTool } from '../../tools/generate-image.js'
import { executeVisionOnboarding } from '../../tui/vision-onboarding-executor.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const auth = { authorization: 'Bearer fixture' }
const denied = (code: string) => (error: unknown) => (error as { code?: string }).code === code

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'endpoint-policy-'))
  const env = ['RIVET_CONFIG_PATH', 'RIVET_TRUST_PROJECT', 'RIVET_NO_SYSTEM_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_FETCH_PIN']
  const previous = env.map(key => process.env[key])
  for (const key of env) delete process.env[key]
  process.env.RIVET_CONFIG_PATH = join(root, 'config.json'); process.env.RIVET_NO_SYSTEM_PROXY = '1'
  t.after(async () => { env.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }); await rm(root, { recursive: true, force: true }) })
  let hits = 0, mode = 'normal'
  const server = createServer(async (req, res) => {
    hits++
    let body = ''; for await (const chunk of req) body += String(chunk)
    res.setHeader('content-type', 'application/json')
    if (mode === 'fallback-slow') { const timer = setTimeout(() => { if (req.url?.endsWith('/models')) { res.statusCode = 404; res.end('{}') } else { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n') } }, 70); res.once('close', () => clearTimeout(timer)); return }
    if (mode === 'redirect') { res.writeHead(307, { location: '/sink' }); res.end(); return }
    if (mode === 'slow') { res.flushHeaders(); const timer = setTimeout(() => res.end('{"data":[{"id":"vision"}]}'), 180); res.once('close', () => clearTimeout(timer)); return }
    if (req.url?.endsWith('/models')) res.end('{"data":[{"id":"vision"}]}')
    else if (req.url?.endsWith('/images/generations')) res.end(JSON.stringify({ data: [{ b64_json: png }] }))
    else if (body && JSON.parse(body).stream) { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n') }
    else res.end('{"choices":[{"message":{"content":"red square"}}]}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, baseUrl = origin + '/v1'
  return { root, baseUrl, origin, hits: () => hits, mode: (value: string) => { mode = value }, policy: { origin, allowPrivateNetwork: true } }
}

test('real image, vision and provider callers default to zero requests; explicit local permission succeeds', async t => {
  const f = await fixture(t), image = { baseUrl: f.baseUrl, model: 'image', prompt: 'garden' }
  await assert.rejects(generateImage(image), denied('endpoint_private_network_denied'))
  await assert.rejects(discoverVisionModels({ baseUrl: f.baseUrl }), denied('endpoint_private_network_denied'))
  await assert.rejects(validateVisionModel({ baseUrl: f.baseUrl, modelId: 'vision' }), denied('endpoint_private_network_denied'))
  await assert.rejects(probeProvider({ baseUrl: f.baseUrl }), denied('endpoint_private_network_denied'))
  assert.equal(f.hits(), 0)
  assert.equal((await generateImage({ ...image, endpointNetworkPolicy: f.policy })).bytes.length, Buffer.from(png, 'base64').length)
  assert.equal((await discoverVisionModels({ baseUrl: f.baseUrl, endpointNetworkPolicy: f.policy })).candidates[0]?.id, 'vision')
  assert.equal((await validateVisionModel({ baseUrl: f.baseUrl, modelId: 'vision', endpointNetworkPolicy: f.policy })).answer, 'red square')
  assert.equal((await probeProvider({ baseUrl: f.baseUrl, endpointNetworkPolicy: f.policy })).completionOk, true)
  f.mode('redirect')
  const before = f.hits()
  await assert.rejects(generateImage({ ...image, endpointNetworkPolicy: f.policy }), denied('endpoint_redirect_blocked'))
  assert.equal(f.hits(), before + 1, 'Paid POST must not be redirected')
})

test('actual vision discovery body stays inside its deadline; abort does not retry', async t => {
  const f = await fixture(t); f.mode('slow')
  await assert.rejects(discoverVisionModels({ baseUrl: f.baseUrl, endpointNetworkPolicy: f.policy, timeoutMs: 35 }), denied('endpoint_timeout'))
  assert.equal(f.hits(), 1)
  const controller = new AbortController(); controller.abort(new Error('user cancelled'))
  await assert.rejects(discoverVisionModels({ baseUrl: f.baseUrl, endpointNetworkPolicy: f.policy, signal: controller.signal }), /user cancelled/)
  assert.equal(f.hits(), 1)
})

test('provider policy save, reload, revoke and origin edit; project/session layers never create authority', async t => {
  const f = await fixture(t), router = createRouter(buildConfigRoutes('fixture'))
  registerProvider({ providerName: 'local-fixture', baseUrl: f.baseUrl, models: [{ id: 'image', supportsImageGen: true }] })
  assert.equal((await router('PUT', '/config/providers/local-fixture/network-policy', { allowPrivateNetwork: true }, {})).status, 401)
  for (const value of ['true', 1, null]) assert.equal((await router('PUT', '/config/providers/local-fixture/network-policy', { allowPrivateNetwork: value }, auth)).status, 400)
  assert.equal((await router('PUT', '/config/providers/local-fixture/network-policy', { allowPrivateNetwork: true }, auth)).status, 200)
  assert.deepEqual(loadConfig().provider.providers['local-fixture']!.endpointNetworkPolicy, f.policy)
  const project = join(f.root, 'project'); await mkdir(project)
  const overlay = { provider: { providers: { 'local-fixture': { endpointNetworkPolicy: f.policy }, intruder: { name: 'intruder', baseUrl: f.baseUrl, endpointNetworkPolicy: f.policy } } } }
  await writeFile(join(project, '.rivet-config.json'), JSON.stringify(overlay)); process.env.RIVET_TRUST_PROJECT = '1'
  assert.equal(loadConfig({ cwd: project }).provider.providers.intruder!.endpointNetworkPolicy, undefined)
  assert.equal((await router('PUT', '/config/providers/local-fixture/network-policy', { allowPrivateNetwork: false, proxyDns: 'local-check' }, auth)).status, 200)
  assert.equal(loadConfig({ cwd: project, sessionOverlay: overlay }).provider.providers['local-fixture']!.endpointNetworkPolicy?.allowPrivateNetwork, false)
  setupProvider({ providerName: 'local-fixture', baseUrl: 'http://localhost:12345/v1' })
  assert.equal(loadConfig().provider.providers['local-fixture']!.endpointNetworkPolicy, undefined)
})

test('draft permission remains transient; configured service and tool consume only saved policy; idempotent success never regenerates', async t => {
  const f = await fixture(t), service = new ImageGenerationService(), router = createRouter(buildImageGenerationRoutes('fixture', () => [f.root], service))
  const draft = { baseUrl: f.baseUrl, modelId: 'image', allowPrivateNetwork: true }
  const input = { cwd: f.root, requestId: randomUUID(), origin: 'test', draft }
  const first = await router('POST', '/image-generations', input, auth)
  const id = (first.body as { id: string }).id
  assert.equal((await service.wait(f.root, id))?.state, 'succeeded')
  assert.equal(f.hits(), 1)
  assert.equal((await router('POST', '/image-generations', { ...input, draft: { ...draft, allowPrivateNetwork: false } }, auth)).status, 202)
  assert.equal(f.hits(), 1, 'Network permission is not part of paid operation identity')
  saveConfig(configSchema.parse({ provider: { default: 'fixture', providers: { fixture: { name: 'fixture', baseUrl: f.baseUrl, models: [{ id: 'image', supportsImageGen: true }] } } }, agent: { imageGenModel: { provider: 'fixture', model: 'image' } } }))
  const tool = createGenerateImageTool({ cwd: f.root, resolveApiKey: () => '', generateImage })
  const run = () => tool.execute({ input: { prompt: 'garden', allowPrivateNetwork: true }, cwd: f.root } as never)
  assert.equal((await run()).isError, true); assert.equal(f.hits(), 1)
  const cfg = loadConfig(); cfg.provider.providers.fixture!.endpointNetworkPolicy = f.policy; saveConfig(cfg)
  assert.equal((await run()).isError, undefined); assert.equal(f.hits(), 2)
})

test('TUI vision executor persists and consumes consent at the actual request', async t => {
  const f = await fixture(t)
  const body = { baseUrl: f.baseUrl, providerName: 'tui-vision-fixture', apiKey: 'fixture' }
  await assert.rejects(executeVisionOnboarding({ kind: 'discover', body }), denied('endpoint_private_network_denied'))
  assert.equal(f.hits(), 0)
  await executeVisionOnboarding({ kind: 'onboard', body: { ...body, modelId: 'vision', allowPrivateNetwork: true } })
  assert.deepEqual(loadConfig().provider.providers['tui-vision-fixture']!.endpointNetworkPolicy, f.policy)
  await executeVisionOnboarding({ kind: 'discover', body })
  assert.equal(f.hits(), 3)
})

test('models-to-completion fallback shares one operation deadline', async t => {
  const f = await fixture(t); f.mode('fallback-slow')
  await assert.rejects(probeForTestKey({ baseUrl: f.baseUrl, probeModel: 'fixture', timeoutMs: 110, endpointNetworkPolicy: f.policy }), denied('endpoint_timeout'))
  assert.equal(f.hits(), 2)
})
