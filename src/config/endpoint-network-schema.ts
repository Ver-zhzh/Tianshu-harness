import { z } from 'zod'

const origin = z.string().url().refine(raw => {
  const url = new URL(raw)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && raw === url.origin
}, 'Network permissions must bind to a canonical HTTP(S) origin')
export const endpointNetworkPolicySchema = z.object({
  origin, allowPrivateNetwork: z.boolean().optional(),
  proxyDns: z.enum(['local-check', 'trusted-proxy']).optional(), proxyOrigin: origin.optional(),
}).refine(policy => policy.proxyDns !== 'trusted-proxy' || !!policy.proxyOrigin, 'A trusted proxy resolver needs a bound proxy origin')

export function boundEndpointPolicy(value: unknown, baseUrl: string) {
  if (value === undefined) return undefined
  const policy = endpointNetworkPolicySchema.parse(value)
  if (policy.origin !== new URL(baseUrl).origin) throw new Error('endpoint_policy_mismatch: endpoint permission belongs to another origin')
  return policy
}

/** Keep authority from the user layer, even when trusted projects or session overlays replace providers. */
export function userEndpointPolicies(raw: Record<string, unknown>): Map<string, unknown> {
  const providers = (raw.provider as { providers?: Record<string, Record<string, unknown>> })?.providers ?? {}
  return new Map(Object.entries(providers).flatMap(([name, provider]) => provider?.endpointNetworkPolicy ? [[name, structuredClone(provider.endpointNetworkPolicy)] as const] : []))
}
export function restoreUserEndpointPolicies(raw: Record<string, unknown>, policies: Map<string, unknown>): Record<string, unknown> {
  const provider = raw.provider as { providers?: Record<string, Record<string, unknown>> } | undefined
  if (!provider?.providers) return raw
  const providers = Object.fromEntries(Object.entries(provider.providers).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [name, value]
    const { endpointNetworkPolicy: _ignored, ...rest } = value
    return [name, { ...rest, ...(policies.has(name) ? { endpointNetworkPolicy: structuredClone(policies.get(name)) } : {}) }]
  }))
  return { ...raw, provider: { ...provider, providers } }
}
