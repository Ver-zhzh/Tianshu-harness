import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { PromptEngine } from '../prompt/engine.js'

export function buildCompactionSummaryRequest(deps: {
  promptEngine: PromptEngine
  contextWindow: number
  getPublishedGoalAnchor?: () => string | null
}, messages: OaiMessage[]): OaiChatRequest {
  const engine = deps.promptEngine
  const liveGoal = deps.getPublishedGoalAnchor ? engine.getGoalAnchor() : null
  try {
    if (deps.getPublishedGoalAnchor) engine.setGoalAnchor(deps.getPublishedGoalAnchor())
    const request = engine.buildOaiRequest(messages, undefined, deps.contextWindow, { sidePath: true })
    request.tools = undefined
    return request
  } finally {
    if (deps.getPublishedGoalAnchor) engine.setGoalAnchor(liveGoal)
  }
}
