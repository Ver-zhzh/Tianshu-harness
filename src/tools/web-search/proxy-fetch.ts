import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { ProxyResolverOptions } from '../../tools/net/proxy-resolver.js'
import { effectiveUrlPort, resolveProxyForUrl, shouldBypassProxy } from '../../tools/net/proxy-resolver.js'
import { boundedSearchFetch } from './bounded-fetch.js'
import type { SearchFetch } from './types.js'

/**
 * cn.bing.com 仅服务中国大陆出口：经任何代理（尤其是海外出口）都会被 301 到
 * www.bing.com 的验证页（issue #483），为翻墙配置的代理会反过来打死这个国内
 * 可达后端。该域名无条件直连——不可被 proxy 配置覆盖；用户的 noProxy 配置
 * 仍可正常追加其他绕过项。
 */
const BUILTIN_DIRECT_HOSTS = 'cn.bing.com'

/**
 * Build a proxy-aware fetch for search backends. Reuses the shared
 * `resolveProxyForUrl` (config.network.proxy > HTTPS_PROXY/HTTP_PROXY env)
 * so a single proxy resolution path serves web_fetch, updater, and web_search.
 *
 * Without a proxy the underlying fetch is called verbatim — zero behavior
 * change for the existing direct-connect path. With a proxy a fresh
 * `ProxyAgent` is constructed per request; `ProxyAgent` keeps its own
 * connection pool keyed by target origin, and search traffic is low-volume,
 * so the per-request construction cost is negligible.
 *
 * The body-size cap (`boundedSearchFetch`) is layered on top so a single
 * wrapped fetch gives backends bounded-buffer + proxy behavior together —
 * no need to double-wrap at every call site.
 */
export function createProxyAwareFetch(
  proxyOpts?: ProxyResolverOptions,
  fetchImpl: SearchFetch = undiciFetch as unknown as SearchFetch,
): SearchFetch {
  const bounded = boundedSearchFetch(fetchImpl)
  return async (url, init) => {
    const parsed = new URL(url)
    if (shouldBypassProxy(parsed.hostname, BUILTIN_DIRECT_HOSTS, effectiveUrlPort(parsed))) return bounded(url, init)
    const proxyUrl = resolveProxyForUrl(url, proxyOpts)
    if (!proxyUrl) return bounded(url, init)
    // Merge dispatcher without clobbering caller-supplied init (e.g. headers,
    // signal, redirect). A new ProxyAgent per call is cheap and avoids the
    // lifecycle/leak concerns of caching agents across proxy config changes.
    // `dispatcher` is an undici extension not on the WHATWG RequestInit type,
    // and the npm undici / builtin undici-types Dispatcher variants conflict
    // (same root cause as the v24 handler-protocol fix in commit 31da608c) —
    // cast through unknown and assign post-spread, mirroring
    // net/http-fetch.ts:155-156.
    const merged = { ...init } as { dispatcher?: unknown }
    merged.dispatcher = new ProxyAgent({ uri: proxyUrl })
    return bounded(url, merged as RequestInit)
  }
}
