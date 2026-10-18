import type { ManagedAgent } from './session-manager.js'

export async function manageContinuityRecovery(session: { running: boolean }, build: () => Promise<ManagedAgent>, current: () => boolean, recoveryId?: string) {
  if (session.running) throw new Error('会话正在运行，请等待结束后修复前缀')
  const agent = await build()
  if (session.running || !current()) throw new Error('会话状态已变化，请重新预览')
  const plan = recoveryId ? await agent.applyContinuityRecovery?.(recoveryId) : await agent.previewContinuityRecovery?.()
  if (!plan) throw new Error('当前运行时未适配前缀恢复')
  return plan
}
