import { loadConfig } from './manager.js'
import { endpointNetworkPolicySchema } from './endpoint-network-schema.js'
import { endpointUrl, proxyOrigin, EndpointNetworkError, type EndpointNetworkPolicy } from '../tools/net/endpoint-policy.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from '../tools/net/proxy-resolver.js'

export interface EndpointAccessInput { allowPrivateNetwork?: boolean; proxyDns?: 'local-check' | 'trusted-proxy' }

/** Bind explicit input to the actual endpoint and proxy, never to a caller-supplied origin. */
export function endpointPolicyInput(input: unknown, baseUrl: string, proxy?: ProxyResolverOptions): EndpointNetworkPolicy | undefined {
  const value = (input ?? {}) as Record<string, unknown>
  if (value.allowPrivateNetwork !== undefined && typeof value.allowPrivateNetwork !== 'boolean') throw new Error('allowPrivateNetwork must be a boolean')
  if (value.proxyDns !== undefined && !['local-check', 'trusted-proxy'].includes(value.proxyDns as string)) throw new Error('proxyDns must be local-check or trusted-proxy')
  const url = endpointUrl(baseUrl)
  if (value.allowPrivateNetwork === undefined && value.proxyDns === undefined) return undefined
  const selected = value.proxyDns === 'trusted-proxy' ? resolveProxyForUrl(url.href, proxy) : undefined
  if (value.proxyDns === 'trusted-proxy' && !selected) throw new EndpointNetworkError('endpoint_policy_mismatch', url.origin)
  return endpointNetworkPolicySchema.parse({ origin: url.origin, allowPrivateNetwork: value.allowPrivateNetwork,
    proxyDns: value.proxyDns, ...(selected ? { proxyOrigin: proxyOrigin(selected) } : {}) })
}

export function savedEndpointPolicy(provider: string | undefined, baseUrl: string): EndpointNetworkPolicy | undefined {
  if (!provider) return undefined
  const policy = loadConfig({ skipProfileOverlay: true }).provider.providers[provider]?.endpointNetworkPolicy
  return policy?.origin === endpointUrl(baseUrl).origin ? policy : undefined
}

export function configuredEndpointNetwork(input: EndpointAccessInput, baseUrl: string, provider?: string) {
  const config = loadConfig(), proxy = { proxyUrl: (provider ? config.provider.providers[provider]?.proxy : undefined) ?? config.network.proxy, noProxy: config.network.noProxy }
  return { proxy, trustProxyFakeIp: config.network.trustProxyFakeIp,
    endpointNetworkPolicy: endpointPolicyInput(input, baseUrl, proxy) ?? savedEndpointPolicy(provider, baseUrl) }
}
