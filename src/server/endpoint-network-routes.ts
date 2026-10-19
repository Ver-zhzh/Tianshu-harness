import { loadConfig, saveConfig } from '../config/manager.js'
import { endpointPolicyInput } from '../config/endpoint-network-policy.js'
import { withAuth } from './route-auth.js'
import { endpointFailure } from './endpoint-network-input.js'
import type { RouteHandler } from './index.js'

export function buildEndpointNetworkRoutes(apiToken?: string): Record<string, RouteHandler> {
  return { 'PUT /config/providers/:name/network-policy': withAuth((body, params) => {
    try {
      const name = decodeURIComponent(params!.name!), config = loadConfig({ skipProfileOverlay: true }), provider = config.provider.providers[name]
      if (!provider) return { status: 404, body: { error: 'Provider not found' } }
      const policy = endpointPolicyInput(body, provider.baseUrl, { proxyUrl: provider.proxy ?? config.network.proxy, noProxy: config.network.noProxy })
      if (!policy) return { status: 400, body: { error: 'Choose an endpoint network policy explicitly' } }
      provider.endpointNetworkPolicy = policy
      saveConfig(config)
      return { status: 200, body: { endpointNetworkPolicy: policy } }
    } catch (error) { return endpointFailure(error) }
  }, apiToken) }
}
