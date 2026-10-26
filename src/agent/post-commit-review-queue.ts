/**
 * post-commit-review-queue — 后台提交后审查的结果待投递队列
 *
 * deliver_task 的系统触发审查（auto / typecheck 升级 / goal-achieved L3）不再
 * 同步阻塞工具调用：审查在后台跑完后把结论推进本队列，由
 * post-commit-review-hook（postTool / preTurn 相位）排水并经 AdvisoryBus
 * 注入后续对话。显式 review_level 同样后台执行并走这条归属通道。
 *
 * 每条结果必须绑定 sessionId，消费者只取自己的结果；冷却/在飞计数亦按会话隔离。
 * 持久化发现另存 review-inbox，瞬态通知不是唯一真相源。
 *
 * @module post-commit-review-queue
 */

export interface PostCommitReviewOutcomeEntry {
  /** 必须由生产者绑定，缺失归属的结果不允许任何会话消费。 */
  sessionId: string
  /** 已格式化的结论行（与同步路径注入工具结果的行一致） */
  lines: string[]
  /** 审查结论 — rejected/verified/inconclusive/nudge，决定投递优先级 */
  verdict: string
  /** 审查层级（auto/L2/L3）——仅用于投递文案 */
  tier: string
  enqueuedAt: number
}

const queue: PostCommitReviewOutcomeEntry[] = []
const scheduling = new Map<string, { lastAt: number; inFlight: number }>()

export function reviewSchedulingState(sessionId: string): { lastAt: number; inFlight: number } {
  let state = scheduling.get(sessionId)
  if (!state) { state = { lastAt: 0, inFlight: 0 }; scheduling.set(sessionId, state) }
  return state
}

export function resetReviewScheduling(expireOnly = false): void {
  if (expireOnly) { for (const state of scheduling.values()) state.lastAt = 0 }
  else scheduling.clear()
}

export function clearSessionReviewResults(sessionId: string): void {
  consumePostCommitReviewOutcomes(sessionId)
  scheduling.delete(sessionId)
}

export function enqueuePostCommitReviewOutcome(entry: Omit<PostCommitReviewOutcomeEntry, 'enqueuedAt'>): void {
  if (!entry.sessionId?.trim()) throw new Error('Review outcome requires a sessionId')
  queue.push({ ...entry, enqueuedAt: Date.now() })
}

/** 排空队列并返回全部待投递结论（hook 消费端）。 */
export function consumePostCommitReviewOutcomes(sessionId: string | undefined): PostCommitReviewOutcomeEntry[] {
  if (!sessionId?.trim()) return []
  const owned = queue.filter(entry => entry.sessionId === sessionId)
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.sessionId === sessionId) queue.splice(i, 1)
  }
  return owned
}

/** Test-only: clear the module-level queue so it does not leak across cases. */
export function __resetPostCommitReviewQueue(): void {
  queue.length = 0
}
