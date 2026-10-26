import type { SwitchModelResult } from '../bootstrap.js'

/** A switch is a one-time confirmation, never a persistent status-line warning. */
export function formatModelSwitchFeedback(result: SwitchModelResult, effort?: string): string {
  const action = result.changed === false ? '当前模型保持不变：' : 'Model → '
  const cache = result.changed === false ? '' : '（后续请求使用所选模型/服务商，缓存命中率可能变化）'
  return [`${action}${result.modelName}${cache}${effort ? `（effort → ${effort}，仅本会话）` : ''}`, ...result.warnings ?? []].join('\n')
}
