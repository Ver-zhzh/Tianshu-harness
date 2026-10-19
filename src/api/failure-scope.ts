/**
 * 失败呈现层：把 `classifyApiError` 的分类结果收敛成**面向用户**的「哪一层坏了 +
 * 哪一类故障」，供 UI/诊断分别呈现（PLAN §3：分离本机连接与外网提供商错误）。
 *
 * 为什么单独一层而不是改 `ErrorCategory`：那个联合是 config `retry.overrides` 的
 * 单一真源（schema 键枚举 + 穷尽性检查），扩它等于改协议面；本模块只做**只读映射**，
 * 零副作用、可独立演进。
 */
import { classifyApiError, type ErrorCategory } from './error-classifier.js'
import { UserInstructionsError } from '../prompt/user-instructions.js'

/** 故障归属：本机链路（断网/DNS/代理/TLS） vs 外网提供商（鉴权/限流/服务端）。 */
export type FailureScope = 'local' | 'provider'

/** 面向用户的六类（PLAN §3 列举的呈现粒度）。 */
export type FailureKind = 'offline' | 'dns_proxy_tls' | 'auth' | 'rate_limit' | 'server' | 'other'

export interface FailurePresentation {
  scope: FailureScope
  kind: FailureKind
  /** 底层分类（用于日志/诊断，不直接展示）。 */
  category: ErrorCategory
  retryable: boolean
  shouldReconnect: boolean
}

const DNS_RE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|nodename nor servname/i
const PROXY_RE = /\bproxy\b|\btunnel\b|407|proxy authentication|proxy connect/i
const OFFLINE_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT|fetch failed|other side closed|socket hang up|network is unreachable/i

/** 沿 cause 链收集文本（Node 的 fetch 把真实原因埋在 `cause`）。 */
function failureText(error: unknown, depth = 0): string {
  if (error == null || depth > 5) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    return `${error.name} ${error.message} ${failureText(cause, depth + 1)}`
  }
  if (typeof error === 'object') {
    const o = error as Record<string, unknown>
    return [o.code, o.name, o.message, o.error, failureText(o.cause, depth + 1)]
      .filter((v) => typeof v === 'string')
      .join(' ')
  }
  return String(error)
}

/**
 * 映射到呈现层。规则：
 * - `tls_intercept` → dns_proxy_tls（本地代理/中间人）。
 * - 连接类错误码（拒绝/不可达/DNS/代理）→ offline 或 dns_proxy_tls，scope=local。
 * - 鉴权 / 限流 / 服务端 → scope=provider（本机链路是通的，问题在上游）。
 * - 其余落 other（不假装知道）。
 */
export function describeFailure(error: unknown): FailurePresentation {
  if (error instanceof UserInstructionsError) return { scope: 'local', kind: 'other', category: 'client_error', retryable: false, shouldReconnect: false }
  const c = classifyApiError(error)
  const text = failureText(error)

  let scope: FailureScope = 'provider'
  let kind: FailureKind

  switch (c.category) {
    case 'tls_intercept': scope = 'local'; kind = 'dns_proxy_tls'; break
    case 'auth_error': kind = 'auth'; break
    case 'rate_limit':
    case 'overloaded': kind = 'rate_limit'; break
    case 'server_error':
    case 'timeout': kind = 'server'; break
    default: kind = 'other'
  }

  // 连接级原因优先于「服务端沉默」：本机链路不通时不该报成上游 5xx。
  if (kind === 'other' || kind === 'server') {
    if (DNS_RE.test(text) || PROXY_RE.test(text)) { scope = 'local'; kind = 'dns_proxy_tls' }
    else if (OFFLINE_RE.test(text)) { scope = 'local'; kind = 'offline' }
    // 连接原因都不匹配时保持原判（other 就是 other，不假装成 server）。
  }

  return { scope, kind, category: c.category, retryable: c.retryable, shouldReconnect: c.shouldReconnect }
}
