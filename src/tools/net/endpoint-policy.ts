import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { isPrivateIP, isProxyFakeIPv4, type ResolvedAddress } from './ssrf.js'

export interface EndpointNetworkPolicy {
  origin: string
  allowPrivateNetwork?: boolean
  proxyDns?: 'local-check' | 'trusted-proxy'
  proxyOrigin?: string
}
export type EndpointLookup = (hostname: string) => Promise<ResolvedAddress | ResolvedAddress[]>
export type EndpointErrorCode = 'endpoint_private_network_denied' | 'endpoint_reserved_address_denied'
  | 'endpoint_dns_unverified' | 'endpoint_redirect_blocked' | 'endpoint_policy_mismatch'
  | 'endpoint_download_origin_denied' | 'endpoint_timeout' | 'endpoint_response_too_large' | 'endpoint_invalid_url'

export class EndpointNetworkError extends Error {
  constructor(readonly code: EndpointErrorCode, readonly origin?: string) {
    super(`${code}${origin ? ` (${origin})` : ''}. ${code === 'endpoint_private_network_denied'
      ? 'Explicitly allow this endpoint to access the local network in its settings.'
      : code === 'endpoint_timeout' ? 'The endpoint request timed out within its operation budget.'
      : code === 'endpoint_redirect_blocked' ? 'Use the final endpoint URL; the request was not forwarded.'
        : code === 'endpoint_dns_unverified' ? 'Check DNS or explicitly configure a trusted proxy resolver for this endpoint.'
          : 'The endpoint request was stopped; check its network policy.'}`)
    this.name = 'EndpointNetworkError'
  }
}

export function endpointUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new EndpointNetworkError('endpoint_invalid_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new EndpointNetworkError('endpoint_invalid_url')
  return url
}

const local = new BlockList()
for (const [address, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) local.addSubnet(address, bits, 'ipv4')
local.addSubnet('::1', 128, 'ipv6')
local.addSubnet('fc00::', 7, 'ipv6')
export function endpointAddressClass(address: string): 'public' | 'local' | 'reserved' {
  const family = isIP(address)
  if (!family) return 'reserved'
  if (local.check(address, family === 6 ? 'ipv6' : 'ipv4')) return 'local'
  return isPrivateIP(address) ? 'reserved' : 'public'
}

/** Validate every DNS answer; callers must connect only to this returned set. */
export async function resolveEndpointTarget(url: URL, options: {
  policy?: EndpointNetworkPolicy; proxyUrl?: string; trustProxyFakeIp?: boolean; lookup?: EndpointLookup
}): Promise<ResolvedAddress[]> {
  const { policy, proxyUrl } = options
  if (policy && policy.origin !== url.origin) throw new EndpointNetworkError('endpoint_policy_mismatch', url.origin)
  if (policy?.proxyDns === 'trusted-proxy' && (!proxyUrl || policy.proxyOrigin !== proxyOrigin(proxyUrl))) throw new EndpointNetworkError('endpoint_policy_mismatch', url.origin)
  const host = url.hostname.replace(/^\[|\]$/g, ''), literal = isIP(host)
  const validate = (address: string) => {
    const kind = endpointAddressClass(address)
    if (kind === 'local' && policy?.allowPrivateNetwork !== true) throw new EndpointNetworkError('endpoint_private_network_denied', url.origin)
    const fake = !literal && !!proxyUrl && options.trustProxyFakeIp === true && isProxyFakeIPv4(address)
    if (kind === 'reserved' && !fake) throw new EndpointNetworkError('endpoint_reserved_address_denied', url.origin)
  }
  if (literal) { validate(host); return [{ address: host, family: literal }] }
  let answers: ResolvedAddress[]
  try {
    const result = await (options.lookup ?? (hostname => lookup(hostname, { all: true, verbatim: true })))(host)
    answers = Array.isArray(result) ? result : [result]
    if (!answers.length || answers.some(answer => !isIP(answer.address))) throw new Error('unverified DNS')
  } catch {
    if (policy?.proxyDns === 'trusted-proxy' && proxyUrl && policy.proxyOrigin === proxyOrigin(proxyUrl)) return []
    throw new EndpointNetworkError('endpoint_dns_unverified', url.origin)
  }
  for (const answer of answers) validate(answer.address)
  return answers.map(answer => ({ address: answer.address, family: isIP(answer.address) }))
}

/** Proxy credentials never participate in a persisted origin binding. */
export function proxyOrigin(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new EndpointNetworkError('endpoint_invalid_url') }
  url.username = ''; url.password = ''; url.hash = ''
  return endpointUrl(url.href).origin
}
