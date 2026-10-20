import type { ProviderConfig } from '../config/schema.js'
import { findModelInKey, findModelOwner } from '../config/provider-keys.js'
import { resolveApiKey, resolveCredentialKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import type { ProviderNetwork } from '../api/provider-network.js'

/** Serializable identity only; credentials never cross the worker protocol. */
export interface ModelBindingRef {
  provider: string
  model: string
  keyId?: string
  baseUrl?: string
  credentialPrincipal?: string
}

export type ModelUnavailableReason = 'provider_deleted' | 'model_deleted' | 'route_deleted' | 'missing_credentials' | 'oauth_not_authenticated'

export class ModelBindingUnavailable extends Error {
  constructor(readonly reason: ModelUnavailableReason) { super(reason); this.name = 'ModelBindingUnavailable' }
}

export function sessionProviderKey(providers: Record<string, ProviderConfig>, provider: ProviderConfig): string {
  const entries = Object.entries(providers)
  const identities = entries.filter(([, configured]) => configured === provider)
  const sameCredentials = (left: Pick<ProviderConfig, 'keyRef' | 'apiKey' | 'apiKeyEnv'>, right: Pick<ProviderConfig, 'keyRef' | 'apiKey' | 'apiKeyEnv'>) =>
    left.keyRef === right.keyRef && left.apiKey === right.apiKey && left.apiKeyEnv === right.apiKeyEnv
  const sameAuth = (left: ProviderConfig['auth'], right: ProviderConfig['auth']) => left?.type === right?.type
    && (left?.type === 'oauth' ? right?.type === 'oauth' && left.provider === right.provider
      : left?.type === 'api-key' ? right?.type === 'api-key' && left.keyEnv === right.keyEnv : true)
  const candidates = identities.length ? identities : entries.filter(([, configured]) =>
    configured.name === provider.name && configured.baseUrl === provider.baseUrl && configured.protocol === provider.protocol
    && sameAuth(configured.auth, provider.auth)
    && (provider.keys?.length
      ? provider.keys.every(selected => configured.keys?.some(key => key.id === selected.id && sameCredentials(key, selected)
        && ((selected.keyRef || selected.apiKey || selected.apiKeyEnv) ? true : sameCredentials(configured, provider))))
      : sameCredentials(configured, provider)))
  if (candidates.length !== 1) throw new ModelBindingUnavailable('provider_deleted')
  return candidates[0]![0]
}

/** Exact lookup, with the same model-owner and credential rules as main sessions. */
export function resolveModelBinding(providers: Record<string, ProviderConfig>, target: ModelBindingRef, network?: ProviderNetwork) {
  const configured = providers[target.provider]
  if (!configured) throw new ModelBindingUnavailable('provider_deleted')
  const found = target.keyId
    ? findModelInKey(configured, target.keyId, target.model)
    : findModelOwner(configured, target.model)
  if (!found) throw new ModelBindingUnavailable('model_deleted')
  const provider = { ...configured, ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}) }
  let apiKey = ''
  let auth: ReturnType<typeof createAuthProvider> | undefined
  if (provider.auth?.type === 'oauth') {
    try {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey, { ...network, proxy: provider.proxy ?? network?.proxy })
      if (!auth.isAuthenticated()) throw new ModelBindingUnavailable('oauth_not_authenticated')
    } catch { throw new ModelBindingUnavailable('oauth_not_authenticated') }
  } else {
    const owner = found.owner
    try {
      apiKey = owner && (owner.keyRef || owner.apiKey || owner.apiKeyEnv)
        ? resolveCredentialKey({ name: provider.name, keyRef: owner.keyRef, apiKey: owner.apiKey, apiKeyEnv: owner.apiKeyEnv })
        : resolveApiKey(provider)
    } catch { throw new ModelBindingUnavailable('missing_credentials') }
  }
  return { provider, apiKey, auth, spec: found.model, ref: {
    provider: target.provider, model: found.model.id,
    ...(found.owner?.id ? { keyId: found.owner.id } : {}), baseUrl: provider.baseUrl,
  } satisfies ModelBindingRef }
}

export function modelBindingAvailability(providers: Record<string, ProviderConfig>, target: ModelBindingRef): ModelBindingRef & { available: boolean; reason?: ModelUnavailableReason } {
  try { resolveModelBinding(providers, target); return { ...target, available: true } }
  catch (error) {
    return { ...target, available: false, reason: error instanceof ModelBindingUnavailable ? error.reason : 'missing_credentials' as const }
  }
}

/** Identify the key already used by the root user session, including duplicate model IDs. */
export function snapshotSessionBinding(provider: ProviderConfig, model: string, apiKey: string, providerKey = provider.name): ModelBindingRef {
  const owner = provider.keys?.find(key => {
    if (!findModelInKey(provider, key.id, model)) return false
    try {
      return (key.keyRef || key.apiKey || key.apiKeyEnv
        ? resolveCredentialKey({ name: provider.name, keyRef: key.keyRef, apiKey: key.apiKey, apiKeyEnv: key.apiKeyEnv })
        : resolveApiKey(provider)) === apiKey
    } catch { return false }
  })
  if (provider.auth?.type !== 'oauth' && provider.keys?.length && !owner) throw new ModelBindingUnavailable('missing_credentials')
  return { provider: providerKey, model, ...(owner ? { keyId: owner.id } : {}), baseUrl: provider.baseUrl }
}
