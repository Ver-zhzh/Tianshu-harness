import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthAuth } from '../oauth-auth.js'
import { TokenStore } from '../token-store.js'
import { codexCliAuthPath } from '../codex-cli-auth.js'
import { cloneProviderPreset } from '../../config/provider-presets.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'

const jwt = (account: string) => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`

test('Codex CLI import respects CODEX_HOME without overriding an explicit import path', () => {
  assert.equal(codexCliAuthPath({ CODEX_HOME: join(tmpdir(), 'custom-codex') }), join(tmpdir(), 'custom-codex', 'auth.json'))
  assert.equal(codexCliAuthPath({ CODEX_HOME: 'ignored', RIVET_CODEX_CLI_AUTH: 'explicit.json' }), 'explicit.json')
})

test('OAuth requests retain the selected account across refresh and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-routing-'))
  try {
    const store = new TokenStore(dir, 'codex')
    store.save({ accessToken: 'fixture-access', accountId: 'fixture-account', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 1000 })
    const auth = new OAuthAuth({ clientId: 'fixture', tokenEndpoint: 'https://example.test/refresh', importCliAuth: false,
      fetch: async () => new Response(JSON.stringify({ access_token: jwt('fixture-default-account'), expires_in: 3600 })) }, dir)
    assert.equal((await auth.getHeaders())['ChatGPT-Account-ID'], 'fixture-account')
    assert.equal(store.load()?.accountId, 'fixture-account')
    const restarted = new OAuthAuth({ clientId: 'fixture', tokenEndpoint: 'https://example.test/refresh', importCliAuth: false }, dir)
    assert.equal((await restarted.getHeaders())['ChatGPT-Account-ID'], 'fixture-account')
    auth.dispose(); restarted.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('OAuth derives missing account metadata from the signed credential claims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-account-'))
  try {
    new TokenStore(dir, 'codex').save({ accessToken: jwt('fixture-claimed-account'), expiresAt: Date.now() + 3600_000 })
    const auth = new OAuthAuth({ clientId: 'fixture', tokenEndpoint: 'https://example.test/refresh', importCliAuth: false }, dir)
    assert.equal((await auth.getHeaders())['ChatGPT-Account-ID'], 'fixture-claimed-account')
    auth.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('expired access credentials with a refresh credential remain eligible for renewal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-renewal-'))
  try {
    new TokenStore(dir, 'codex').save({ accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAt: Date.now() - 1000 })
    const auth = new OAuthAuth({ clientId: 'fixture', tokenEndpoint: 'https://example.test/refresh', importCliAuth: false }, dir)
    assert.equal(auth.isAuthenticated(), true)
    auth.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('renamed Codex OAuth providers use Responses rather than chat completions', async () => {
  const original = globalThis.fetch
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
  const originalProxy = proxyKeys.map(key => process.env[key])
  proxyKeys.forEach(key => { delete process.env[key] })
  process.env.RIVET_NO_SYSTEM_PROXY = '1'
  let sentUrl = ''
  let sentBody: Record<string, unknown> = {}
  globalThis.fetch = async (url, init) => {
    sentUrl = String(url); sentBody = JSON.parse(String(init?.body))
    throw Error('fixture-stop')
  }
  try {
    const provider = { ...cloneProviderPreset('codex'), name: 'my-codex-account', maxRetries: 0 }
    const client = createProviderClient(provider, resolveCapabilities('codex'), {
      apiKey: '', model: provider.models[0]!.id, maxTokens: 128,
      auth: { isAuthenticated: () => true, getHeaders: async () => ({ Authorization: 'Bearer fixture' }), authenticate: async () => {}, dispose: () => {} },
    })
    await assert.rejects(client.stream({ model: provider.models[0]!.id, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 128 }, {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {},
    }), /fixture-stop/)
    assert.equal(sentUrl, `${provider.baseUrl}/responses`)
    assert.equal(sentBody.store, false)
  } finally {
    globalThis.fetch = original
    proxyKeys.forEach((key, index) => {
      if (originalProxy[index] === undefined) delete process.env[key]
      else process.env[key] = originalProxy[index]
    })
  }
})
