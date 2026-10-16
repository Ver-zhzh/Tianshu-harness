import type { RouteHandler } from './index.js'
import type { PromptRouteDeps } from './prompt-route.js'
import { buildPromptHandler } from './prompt-route.js'
import { buildTaskRoutes, type TaskRoutesDeps } from './task-routes.js'
import { isAuthorizedRequest } from './auth.js'
import { renewLease } from './parent-watchdog.js'
import { requestShutdown } from './shutdown-registry.js'
import { denyRuntimeProAuthorization } from '../config/pro-license.js'

export interface BanditStatusEntry {
  source: string
  mode: string
  enabled: boolean
  reason: string
  totalShadowSamples: number
}

export interface ServerState {
  running: boolean
  sessionId?: string
  abort?: () => void
  /** Shared Bearer token for all server routes. Missing token means fail-closed. */
  apiToken?: string
  /** T5: bandit promotion state for /status observability. */
  banditState?: BanditStatusEntry[]
}

function unauthorized() {
  return { status: 401, body: { error: 'Unauthorized' } }
}

/** 共享 Bearer 认证包装。账号路由（account-routes.ts）复用同一份——
 *  认证规则改动漏掉任何一份都是安全洞。
 *
 *  流量续租（2026-09-19 复审 ②补丁）：每个认证通过的请求顺手续租
 *  watchdog 租约（120s）。语义从「attach 时刻一次性续租」变为「空闲
 *  超时」——连接方活跃（桌面壳的 SSE/轮询/REST 持续在打）期间 serve
 *  永不死，停止交互后才进入宽限。所有客户端（壳/CLI/插件）自动受益，
 *  无需各自的 keepalive 通道。未认证请求不续租（fail-closed 的边界
 *  一致性）。 */
export function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()
    renewLease(120_000)
    return handler(body, params, headers, res)
  }
}

export function createRoutes(state: ServerState, deps?: PromptRouteDeps, taskDeps?: TaskRoutesDeps): Record<string, RouteHandler> {
  const apiToken = state.apiToken ?? taskDeps?.apiToken
  const routes: Record<string, RouteHandler> = {
    'POST /runtime/pro-deny': withAuth(async () => {
      try { await denyRuntimeProAuthorization() }
      catch { return { status: 503, body: { error: 'Managed Pro denial is not confirmed' } } }
      return { status: 200, body: { denied: true } }
    }, apiToken),
    'GET /status': withAuth(() => ({
      status: 200,
      body: {
        running: state.running,
        sessionId: state.sessionId ?? null,
        ...(state.banditState ? { bandit: state.banditState } : {}),
      },
    }), apiToken),

    'POST /abort': withAuth(() => {
      state.abort?.()
      state.running = false
      return { status: 200, body: { aborted: true } }
    }, apiToken),

    // WSL 热附着续租（2026-09-19 审查 ②）：桌面壳重连（attached:true）时
    // 经此端点为 parent watchdog 的租约续期——断开杀 relay 后 serve 的
    // 宽限倒计时被冻结，重连期间不误杀。ms 默认 120s（长于任何合理握手
    // +交互间隙；下一次断开会重新起算宽限）。
    'POST /lease': withAuth((body) => {
      const ms = typeof body === 'object' && body !== null && typeof (body as { ms?: unknown }).ms === 'number'
        ? (body as { ms: number }).ms
        : 120_000
      renewLease(Math.max(0, ms))
      return { status: 200, body: { leased: true } }
    }, apiToken),

    // 主动关停（2026-09-21）：壳在杀 relay **之前**调本端点，请 serve 走完整
    // 优雅退出链。时机是全部关键——WSL 发行版在最后一个客户端消失后 ~17s 被
    // 平台回收（instanceIdleTimeout=15000），serve 的宽限还没计满就被断电带走，
    // close 链一行不跑（发现文件残留、无 breadcrumb、会话写链滞留行丢失）。
    // 而在杀 relay 前调用时 relay 还活着、REST 走 localhost 转发不经 relay，
    // 这是唯一能拿到完整清理的窗口。
    // 503 = 无登记的关停入口（壳据此降级为直接杀 relay，不假装成功）。
    // 认证必需——否则成任意本地进程可用的 DoS 面。
    'POST /shutdown': withAuth(() => {
      if (!requestShutdown()) {
        return { status: 503, body: { error: 'Shutdown handler not registered' } }
      }
      return { status: 200, body: { shuttingDown: true } }
    }, apiToken),
  }

  if (deps) {
    routes['POST /prompt'] = withAuth(buildPromptHandler(deps), apiToken)
  }

  if (taskDeps) {
    Object.assign(routes, buildTaskRoutes({ ...taskDeps, apiToken: taskDeps.apiToken ?? apiToken }))
  }

  return routes
}
