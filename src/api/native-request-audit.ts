import { randomUUID } from 'node:crypto'
import { beginCallAudit, type CallAuditContext } from './call-audit.js'

export type ActiveCallAudit = ReturnType<typeof beginCallAudit>

/** Preparation failures belong to the same attempt as transport and parsing. */
export async function withNativeRequestAudit<T>(context: CallAuditContext, signal: AbortSignal | undefined,
  run: (context: CallAuditContext, audit: ActiveCallAudit) => Promise<T>): Promise<T> {
  const attempt = { ...context, attemptId: randomUUID() }
  const audit = beginCallAudit(attempt)
  try {
    signal?.throwIfAborted()
    return await run(attempt, audit)
  } catch (error) {
    audit.finish({ status: signal?.aborted || (error as Error)?.name === 'AbortError' ? 'aborted' : 'failed', errorName: (error as Error)?.name })
    throw error
  }
}
