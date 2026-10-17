import { RequestBodyTooLargeError } from '../api/request-body-guard.js'
import { deepSeekImageLimitError } from '../context/image-input-limits.js'
import { randomUUID } from 'node:crypto'
import type { OaiChatRequest } from '../api/oai-types.js'
import { assertContextBudget, buildContextBudget, DEEPSEEK_BODY_LIMIT, type RequestBudgetPolicy } from '../context/request-budget.js'
import type { ContextBudgetSnapshot } from '../server/protocol.js'
import { isContextLengthError } from '../api/error-classifier.js'

/** Only an explicit pre-generation server rejection permits one model-call replay. */
export function canRecoverContextRejection(error: unknown, outputChars: number, blocks: number): boolean {
  if (!(error instanceof Error) || outputChars > 0 || blocks > 0) return false
  const status = (error as Error & { status?: number }).status
  return (status === 400 || status === 422)
    && isContextLengthError(error.message)
}

export async function prepareContextRequest(deps: {
  build: () => OaiChatRequest
  preview?: (request: OaiChatRequest) => OaiChatRequest
  policy: RequestBudgetPolicy
  compact: () => Promise<boolean>
  publish: (budget: ContextBudgetSnapshot) => void
  signal?: AbortSignal
}): Promise<OaiChatRequest> {
  const requestId = randomUUID()
  for (let attempt = 0; attempt <= 1; attempt++) {
    deps.signal?.throwIfAborted()
    const request = deps.build()
    const visible = deps.preview?.(request) ?? request
    const budget = buildContextBudget(visible, deps.policy, { requestId, revision: attempt })
    budget.bodyBytes = Buffer.byteLength(JSON.stringify(visible))
    const bodyExceeded = deps.policy.transportLimits !== 'none' && budget.bodyBytes > DEEPSEEK_BODY_LIMIT
    const imageError = deps.policy.transportLimits === 'none' ? undefined : deepSeekImageLimitError(visible.messages)
    if (bodyExceeded || imageError) budget.state = 'blocked'
    request.contextBudget = budget
    deps.publish(budget)
    if (budget.state !== 'blocked' && budget.inputTokens <= budget.inputBudget && !bodyExceeded) return request
    if (attempt < 1) {
      deps.publish({ ...budget, state: 'compacting' })
      try { if (await deps.compact()) continue } catch (error) {
        deps.publish({ ...budget, state: 'blocked' })
        if (deps.signal?.aborted) deps.signal.throwIfAborted()
        throw Object.assign(new Error(`上下文整理未完成，原历史已保留：${error instanceof Error ? error.message : String(error)}`), { name: 'ContextPreparationError' })
      }
    }
    deps.publish(budget)
    if (imageError) throw imageError
    if (bodyExceeded) throw new RequestBodyTooLargeError(budget.bodyBytes!, DEEPSEEK_BODY_LIMIT, [], { preserved: true })
    assertContextBudget(budget)
    return request
  }
  throw new Error('Unreachable context preparation state')
}
