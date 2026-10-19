import type { ToolResult } from './types.js'

export function completionPreparationBlocked(command: string, reason: string, timedOut = false): ToolResult {
  const content = timedOut ? '命令超时：采证准备已耗尽总预算，未启动命令。' : `测试采证准备受阻：${reason}；未启动命令。`
  return { content, isError: true, ...(timedOut ? { errorKind: 'timeout' as const } : {}), verification: {
    command, kind: 'test', scope: 'unknown', status: 'blocked', countsReliable: false, userGuidance: content,
    blockedReason: timedOut ? 'timeout' : 'unknown_runner', ...(timedOut ? { failureKind: 'timeout' as const } : {}), timestamp: Date.now(),
  } }
}
