import { endpointPolicyInput, savedEndpointPolicy } from '../config/endpoint-network-policy.js'
import { loadConfig } from '../config/manager.js'
import { endpointUrl, EndpointNetworkError } from '../tools/net/endpoint-policy.js'

export function endpointNetworkInput(body: unknown, baseUrl: string, provider?: string) {
  const config = loadConfig(), proxy = { proxyUrl: (provider ? config.provider.providers[provider]?.proxy : undefined) ?? config.network.proxy, noProxy: config.network.noProxy }
  return { proxy, trustProxyFakeIp: config.network.trustProxyFakeIp,
    endpointNetworkPolicy: endpointPolicyInput(body, baseUrl, proxy) ?? savedEndpointPolicy(provider, baseUrl) }
}
export function endpointFailure(error: unknown) {
  return { status: 400, body: { error: error instanceof Error ? error.message : 'Endpoint request failed',
    ...(error instanceof EndpointNetworkError ? { code: error.code, origin: error.origin } : {}) } }
}
/** Environment credentials are usable only at a user-saved endpoint declaring that name. */
export function assertEnvironmentOrigin(name: string, baseUrl: string): void {
  const providers = Object.values(loadConfig({ skipProfileOverlay: true }).provider.providers)
  if (!providers.some(provider => endpointUrl(provider.baseUrl).origin === endpointUrl(baseUrl).origin &&
    (provider.apiKeyEnv === name || provider.keys?.some(key => key.apiKeyEnv === name)))) {
    throw new EndpointNetworkError('endpoint_policy_mismatch', endpointUrl(baseUrl).origin)
  }
}
/** A stored credential is scoped to its origin; an override must supply its own key. */
export function assertCredentialOrigin(provider: { baseUrl: string } | undefined, baseUrl: string, explicitKey?: string): void {
  if (provider && !explicitKey && endpointUrl(provider.baseUrl).origin !== endpointUrl(baseUrl).origin) throw new EndpointNetworkError('endpoint_policy_mismatch', endpointUrl(baseUrl).origin)
}
