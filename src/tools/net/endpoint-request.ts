import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { endpointUrl, resolveEndpointTarget, EndpointNetworkError, type EndpointLookup, type EndpointNetworkPolicy } from './endpoint-policy.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from './proxy-resolver.js'

export interface EndpointRequestOptions {
  endpointNetworkPolicy?: EndpointNetworkPolicy
  proxy?: ProxyResolverOptions
  trustProxyFakeIp?: boolean
  signal?: AbortSignal
  deadline?: number
  timeoutMs?: number
  maxBytes?: number
  lookupImpl?: EndpointLookup
  fetchImpl?: typeof fetch
}
const headerLatency = new WeakMap<Response, number>()
export function inheritEndpointHeaderLatency(source: Response, target: Response): Response { const latency = headerLatency.get(source); if (latency !== undefined) headerLatency.set(target, latency); return target }
export const endpointHeaderLatency = (response: Response): number | undefined => headerLatency.get(response)

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

/** Consume the bounded body before releasing the dispatcher or deadline. */
async function requestHop(raw: string, init: RequestInit, options: EndpointRequestOptions, download = false): Promise<Response> {
  const url = endpointUrl(raw), began = Date.now()
  const remaining = (options.deadline ?? began + (options.timeoutMs ?? 15_000)) - began
  if (remaining <= 0) throw new EndpointNetworkError('endpoint_timeout', url.origin)
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new EndpointNetworkError('endpoint_timeout', url.origin)), remaining)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let dispatcher: Agent | ProxyAgent | undefined, response: Response | undefined
  try {
    signal.throwIfAborted()
    const proxyUrl = options.fetchImpl ? undefined : resolveProxyForUrl(url.href, options.proxy)
    const addresses = await bounded(resolveEndpointTarget(url, { policy: options.endpointNetworkPolicy, proxyUrl, trustProxyFakeIp: options.trustProxyFakeIp, lookup: options.lookupImpl }), signal)
    if (!options.fetchImpl) {
      dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : new Agent({ connect: { lookup: (_hostname, lookupOptions, callback) => {
        const all = typeof lookupOptions === 'object' && lookupOptions !== null && 'all' in lookupOptions && lookupOptions.all
        if (all) callback(null, addresses as never)
        else { const answer = addresses[0]!; callback(null, answer.address, answer.family) }
      } } })
    }
    const request = { ...init, redirect: 'manual' as const, signal, ...(dispatcher ? { dispatcher } : {}) }
    response = await bounded((options.fetchImpl ?? undiciFetch as unknown as typeof fetch)(url.href, request as unknown as RequestInit), signal)
    const latency = Date.now() - began
    if (response.status >= 300 && response.status < 400) {
      if (!download) throw new EndpointNetworkError('endpoint_redirect_blocked', url.origin)
      return new Response(null, { status: response.status, headers: response.headers })
    }
    const max = options.maxBytes ?? 2 * 1024 * 1024, chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body?.getReader()
    try {
      if (reader) while (true) {
        const item = await bounded(reader.read(), signal)
        if (item.done) break
        size += item.value.byteLength
        if (size > max) throw new EndpointNetworkError('endpoint_response_too_large', url.origin)
        chunks.push(item.value)
      }
    } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() } }
    const result = new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks, size), { status: response.status, statusText: response.statusText, headers: response.headers })
    headerLatency.set(result, latency)
    return result
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof EndpointNetworkError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new EndpointNetworkError('endpoint_timeout', url.origin)
    throw networkFailure(error, url.href)
  } finally {
    clearTimeout(timer)
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    if (dispatcher) await dispatcher.destroy().catch(() => {})
  }
}

export const endpointRequest = (raw: string, init: RequestInit, options: EndpointRequestOptions = {}): Promise<Response> => requestHop(raw, init, options)

/** Image GET has no provider credentials, and only same-origin local permission. */
export async function endpointDownload(raw: string, options: EndpointRequestOptions & { maxBytes: number }): Promise<{ bytes: Uint8Array; finalUrl: string; status: number }> {
  const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? 15_000)
  let url = endpointUrl(raw)
  for (let hop = 0; hop <= 5; hop++) {
    // Request redirects are intentionally blocked. Downloads inspect one GET hop at a time.
    const sameOrigin = options.endpointNetworkPolicy?.origin === url.origin
    const policy = sameOrigin ? options.endpointNetworkPolicy : undefined
    try {
      const response = await requestHop(url.href, { method: 'GET' }, { ...options, deadline, endpointNetworkPolicy: policy }, true)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new EndpointNetworkError('endpoint_redirect_blocked', url.origin)
        try { url = endpointUrl(new URL(location, url).href) } catch { throw new EndpointNetworkError('endpoint_invalid_url', url.origin) }
        continue
      }
      return { bytes: new Uint8Array(await response.arrayBuffer()), finalUrl: url.href, status: response.status }
    } catch (error) {
      if (!sameOrigin && error instanceof EndpointNetworkError && error.code === 'endpoint_private_network_denied') throw new EndpointNetworkError('endpoint_download_origin_denied', url.origin)
      throw error
    }
  }
  throw new EndpointNetworkError('endpoint_redirect_blocked', url.origin)
}

function networkFailure(error: unknown, url: string): Error {
  const codes = new Set<string>()
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 4) return
    const e = value as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (typeof e.code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(e.code)) codes.add(e.code)
    visit(e.cause, depth + 1)
    if (Array.isArray(e.errors)) e.errors.forEach(child => visit(child, depth + 1))
  }
  visit(error)
  return new Error(`Endpoint network request failed (${new URL(url).hostname}; ${[...codes].join(', ') || 'NETWORK_ERROR'}). Check the network, proxy and certificate configuration.`)
}
