import type { AgentLoop } from './loop.js'
import type { HandoffLiveInput } from './fact-handoff.js'
export function liveHandoffInput(agent: AgentLoop): HandoffLiveInput {
  const contract = agent.getTaskContract()
  return { goal: contract?.objective, planRef: contract?.planRef, scope: contract ? [...contract.scope.mentionedFiles, ...contract.constraints].join('；') : undefined,
    turnCount: agent.session.getTurnCount(), todos: agent.config.getTodos?.() }
}
