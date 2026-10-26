import { createReviewInbox, type ReviewFollowupNotice } from './review-inbox.js'

interface Owner { cwd: string; sessionId: string }
/** Host-owned scheduling: never invoke AgentLoop behind the host's lifecycle/approval machinery. */
export function createReviewFollowupController(deps: {
  getOwner: () => Owner | undefined
  isBusy: () => boolean
  canContinue: () => boolean
  run: (prompt: string) => boolean | Promise<boolean>
  onPending?: (notice: ReviewFollowupNotice) => void
  onError: (error: unknown) => void
  inbox?: typeof createReviewInbox
}) {
  // Compatibility shell: late results may notify their owner, never start a run.
  const notified = new Set<string>()
  return {
    ready(notice: ReviewFollowupNotice): void {
      const key = `${notice.sessionId}:${notice.reviewId}`
      if (notice.sessionId !== deps.getOwner()?.sessionId || notified.has(key)) return
      notified.add(key); deps.onPending?.(notice)
    },
    flush(): void {},
    settled(): void {},
  }
}
