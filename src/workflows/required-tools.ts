/** Shared explicit-intent activation. Never upgrades a preset or asks again. */
export interface ToolMountResult { status: string; cacheImpact: string }
export function toolMountNotice(name: string, result: ToolMountResult): string {
  return `已按显式指令启用 ${name}` + (result.cacheImpact === 'prefix-invalidated' ? '；下一请求前缀缓存一次性失效，后续按新工具面缓存。' : '。')
}
function inspectMount(name: string, result: ToolMountResult | undefined, notify?: (message: string) => void): string | undefined {
  if (result?.status === 'busy') return `本次指令未执行：当前任务仍在运行，工具 ${name} 未启用；请在任务结束后重试该显式指令。`
  if (result?.status === 'mounted') notify?.(toolMountNotice(name, result))
  if (!result || !['mounted','already-active','gating-off','not-extended'].includes(result.status)) return `本次指令未执行：工具 ${name} 无法启用（${result?.status ?? 'unavailable'}）。请检查显式禁用／白名单；未注册的编排能力可在新会话选择 orchestration 档。`
}
export function activateRequiredToolsNow(names: readonly string[] | undefined, enable: (name: string) => ToolMountResult | undefined, notify?: (message: string) => void): { ok: true } | { ok: false; error: string } {
  for (const name of new Set(names ?? [])) {
    const error = inspectMount(name, enable(name), notify)
    if (error) return { ok: false, error }
  }
  return { ok: true }
}
export async function activateRequiredTools(names: readonly string[] | undefined, enable: (name: string) => ToolMountResult | undefined | Promise<ToolMountResult | undefined>, notify?: (message: string) => void): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const name of new Set(names ?? [])) {
    const error = inspectMount(name, await enable(name), notify)
    if (error) return { ok: false, error }
  }
  return { ok: true }
}
