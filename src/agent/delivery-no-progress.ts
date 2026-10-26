import type { TaskLedgerEvent } from './task-ledger.js'
import type { ToolResult } from '../tools/types.js'
import type { CandidateDiagnostics } from './delivery-candidate-diagnostics.js'

export function deliveryNextAction(reason: string, diagnostic?: CandidateDiagnostics): string {
  if (reason === 'git-index-lock') return '确认占用 .git/index.lock 的 Git 进程已结束，再用原参数重试 deliver_task。'
  if (reason === 'git-index-changed') return '核对暂存区冲突，再用原参数重试 deliver_task；同候选测试仍有效。'
  if (reason === 'git-head-changed') return 'HEAD 已变，候选与证据需重建：重新调用 deliver_task（旧验证不再适用），不要只重试提交。'
  if (reason === 'git-files-changed') return '候选文件内容已变，重新调用 deliver_task 取新基准后再提交。'
  if (reason === 'git-baseline-unavailable') return '读取提交基准失败：按上方 Baseline diagnostics 处理（敏感命名文件 / 仓库外路径 / Git 环境）；这不是 HEAD 变化，重试无效。'
  if (reason === 'git-commit-failed') return '按上方 Git 错误修复提交冲突，再用原参数重试 deliver_task。'
  if (reason === 'missing-commit-message') return '补充提交 message，再调用 deliver_task。'
  if (reason === 'cross-session-claim') return '先解决交付文件的跨会话归属冲突。'
  if (reason === 'cohesion') return '缩小本次交付文件集合，使其成为一个内聚提交。'
  if (reason === 'candidate-changed') return '重新调用 deliver_task 构造当前候选并按新计划验证。'
  if (diagnostic?.currentFailure && reason.startsWith('delivery:')) return `修复并重测 ${diagnostic.currentFailure}`
  return diagnostic?.nextRun ?? (diagnostic?.currentFailure ? `修复并重测 ${diagnostic.currentFailure}` : '检查 verificationPlan.pendingReasons 并对当前候选采证')
}

/** A failed commit attempt cannot silently loop on the same evidence. */
export function createDeliveryNoProgressTracker() {
  const latest = new Map<string, { key: string; count: number }>()
  return {
    rejected(taskId: string, ref: string | undefined, reason: string, events: readonly TaskLedgerEvent[], nextAction: string, result: ToolResult): ToolResult {
      if (!ref) return result
      const proofs = events.filter(event => event.type === 'verification' && event.meta?.snapshotRef === ref && event.meta?.stale !== true)
      const key = JSON.stringify([ref, reason, proofs.map((event, index) => [index, event.command, event.status, event.meta?.executionId, event.meta?.timestamp])])
      const previous = latest.get(taskId)
      const count = previous?.key === key ? previous.count + 1 : 1
      latest.set(taskId, { key, count })
      if (count < 3) return result
      return { ...result, endTurn: true, content: `${result.content}\n\n无进展：同一候选、同一阻断及证明已连续出现 ${count} 次；停止本轮自动重试。唯一下一步：${nextAction}` }
    },
    clear(taskId: string): void { latest.delete(taskId) },
  }
}
