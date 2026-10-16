/**
 * sidecar LSP 装配（2026-10-16 从 serve-agent.ts 沿接缝拆出，issue #500 配套）：
 * per-cwd LSP manager entry 的取/建 + late-init 订阅（attachLspTools）。
 * serve-agent 是点名巨石（行数棘轮只降不升），而 LSP 装配与 agent 主装配逻辑
 * 内聚低——entry 生命周期与注册/闸门订阅独立成线，拆出后各自可测。
 */
import { createMultiLspManager } from '../lsp/multi-manager.js'
import type { LspManager } from '../lsp/manager.js'
import { registerLspTools } from '../lsp/tools.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import type { RuntimeRefs } from '../bootstrap.js'
import type { SharedRuntime } from './serve-agent.js'

/** 按 cwd 取/建 LSP manager entry。首个触达某 cwd 的会话触发 initialize()
 *  （异步，不阻塞会话创建）；后续会话复用同一 entry。ready resolve 为
 *  isReady()——false 表示该 cwd 没有可用的语言服务器（工具不注册）。 */
export function getOrCreateLspEntry(
  shared: SharedRuntime,
  cwd: string,
): { manager: LspManager; ready: Promise<boolean> } {
  const existing = shared.lspManagers.get(cwd)
  if (existing) return existing
  const manager = createMultiLspManager(cwd)
  const ready = manager
    .initialize()
    .then(() => manager.isReady())
    .catch(() => false)
  const entry = { manager, ready }
  shared.lspManagers.set(cwd, entry)
  return entry
}

/** Wave G: LSP late-init 订阅（照 TUI bootstrap.ts initializeLsp 的 .then 语义）。
 *  设计约束（switchModel 安全性）：每次 assembleAgentLoop 调用时挂载——捕获
 *  当次的新 agent。Promise 已 resolve 时晚订阅立即触发，所以 switchModel
 *  重建的 agent 照样收到 updateTools()；重复 register 无害（ToolRegistry.register
 *  是 Map.set 幂等覆盖）。老 agent 的旧回调对废弃对象空刷一次，无害。
 *
 *  晚到注册闸门（2026-10-16，issue #500 配套修复）：LSP 初始化登记进
 *  beginExtraRegistration——首个 run() 入口的 awaitExtraRegistrations 把
 *  「就绪发生在 user 边界内」的注册吸收掉（≤8s 超时放行），首请求不再撞
 *  「LSP 尚未注册」窗口（该窗口的 tools 漂移会触发守卫 fail-closed 拒发）。
 *  与 MCP/插件闸门（bootstrap.ts:2407/2413/2434）同构；此前仅本路径遗漏。
 *  exported for tests（注入 mock entry，不真实 spawn 语言服务器）。 */
export function attachLspTools(
  entry: { manager: LspManager; ready: Promise<boolean> },
  toolRegistry: Pick<ReturnType<typeof createDefaultToolRegistry>, 'register' | 'beginExtraRegistration' | 'endExtraRegistration'>,
  refs: Pick<RuntimeRefs, 'lspManager'>,
  updateTools: () => void,
): Promise<void> {
  toolRegistry.beginExtraRegistration()
  let released = false
  const release = () => {
    if (released) return
    released = true
    toolRegistry.endExtraRegistration()
  }
  // 兜底释放：initialize 挂死（spawn 无响应）时有界收场——防 pending 计数永久
  // 占住闸门、让后续每条消息白等 8s。正常路径由 ready.finally 释放。
  const failsafe = setTimeout(release, 10_000)
  failsafe.unref?.()
  return entry.ready.then((ok) => {
    if (!ok) return
    registerLspTools(entry.manager, toolRegistry)
    refs.lspManager = entry.manager
    updateTools()
  }).finally(() => {
    clearTimeout(failsafe)
    release()
  })
}
