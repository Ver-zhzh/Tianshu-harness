import { Agent, ProxyAgent } from 'undici'
import { effectiveUrlPort, resolveProxyForUrl, shouldBypassProxy } from '../tools/net/proxy-resolver.js'

export interface ProviderNetwork { proxy?: string; noProxy?: string }

const direct = new Agent()
const proxies = new Map<string, ProxyAgent>()

/** Explicit direct routing also prevents a global dispatcher bypassing NO_PROXY. */
export function providerDispatcher(url: string, network?: ProviderNetwork): Agent | ProxyAgent | undefined {
  const proxy = resolveProxyForUrl(url, { proxyUrl: network?.proxy, noProxy: network?.noProxy })
  if (!proxy) {
    let parsed: URL
    try { parsed = new URL(url) } catch { return undefined }
    return shouldBypassProxy(parsed.hostname, network?.noProxy, effectiveUrlPort(parsed))
      ? direct
      : undefined
  }
  let dispatcher = proxies.get(proxy)
  if (!dispatcher) { dispatcher = new ProxyAgent({ uri: proxy }); proxies.set(proxy, dispatcher) }
  return dispatcher
}
