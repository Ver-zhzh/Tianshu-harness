import type { AgentFactory, ManagedAgent } from './session-manager.js'

/** 环境开关：唯一的灰度入口。未设 / 非 'isolated' 一律保持今天的进程内行为，
 *  所以隔离灰度可以在不改协议的前提下开关与回退。 */
export const EXECUTION_BACKEND_ENV = 'RIVET_EXECUTION_BACKEND'

export interface ExecutionBackend {
  readonly kind: 'in-process' | 'isolated'
  createAgent: AgentFactory
  close(): Promise<void>
}

export function inProcessBackend(createAgent: AgentFactory): ExecutionBackend {
  const agents = new Set<ManagedAgent>()
  return {
    kind: 'in-process',
    createAgent: async (...args) => {
      const agent = await createAgent(...args)
      const shutdown = agent.shutdown?.bind(agent)
      let settlement: Promise<void | boolean> | undefined
      agent.shutdown = () => {
        settlement ??= Promise.resolve().then(() => shutdown?.()).finally(() => agents.delete(agent))
        return settlement
      }
      agents.add(agent)
      return agent
    },
    async close() { await Promise.allSettled([...agents].map(agent => agent.shutdown?.())); agents.clear() },
  }
}

export interface ResolveExecutionBackendOptions {
  /** 显式指定后端（测试 / 受控装配）；缺省读 `RIVET_EXECUTION_BACKEND`。 */
  kind?: string
  hookBinding?: (cwd: string, sessionId: string) => import('../hooks/external-hook-types.js').HookRuntimeBinding
  externalHookHost?: import('../hooks/external-hook-types.js').ExternalHookHostPort
}

/**
 * 选择执行后端。隔离适配器住在闭源目录，因此用**变量路径**动态 import（同
 * pro-registry 的 loadProModule）：开源构建没有该产物时静默回退进程内，
 * 绝不因为闭源目录缺席而启动失败。任何一步异常都回退，不让「灰度开关」
 * 变成「启动开关」。
 */
export async function resolveExecutionBackend(
  createAgent: AgentFactory,
  opts: ResolveExecutionBackendOptions = {},
): Promise<ExecutionBackend> {
  const requested = (opts.kind ?? process.env[EXECUTION_BACKEND_ENV] ?? 'in-process').trim().toLowerCase()
  if (requested !== 'isolated') return inProcessBackend(createAgent)
  const candidates = [
    new URL('../pro/runtime/backend.js', import.meta.url).href, // src 形态（tsx / dev）
    new URL('./pro/runtime/backend.js', import.meta.url).href,  // dist 形态（bundle）
  ]
  for (const path of candidates) {
    try {
      const mod = (await import(path)) as { createIsolatedBackend?: (options: Pick<ResolveExecutionBackendOptions, 'externalHookHost' | 'hookBinding'>) => ExecutionBackend }
      if (typeof mod.createIsolatedBackend === 'function') return mod.createIsolatedBackend({ externalHookHost: opts.externalHookHost, hookBinding: opts.hookBinding })
    } catch { /* 试下一个候选 */ }
  }
  console.error('[execution-backend] RIVET_EXECUTION_BACKEND=isolated 但隔离适配器不可用，回退进程内执行')
  return inProcessBackend(createAgent)
}
