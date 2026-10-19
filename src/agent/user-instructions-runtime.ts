import type { PromptEngine } from '../prompt/engine.js'
import type { SessionPersist } from './session-persist.js'
import type { AgentConfig } from './loop-types.js'
import { resolvePromptBlocks } from '../prompt/block-policy.js'
import { buildBudgetReport } from '../prompt/prefix-budget.js'

export function wireUserInstructionsPersistence(engine: PromptEngine, persist: SessionPersist): void {
  if (engine.getUserInstructionsSnapshot().state !== 'active' && !engine.exportFrozenSnapshot().userInstructions) return
  engine.setExecutionSnapshotCommit(snapshot => persist.commitFrozenSnapshot(snapshot))
  engine.setOnFrozenSnapshotChanged(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
}

export function agentPrefixBudget(config: AgentConfig) {
  const policy = config.blockPolicy ?? resolvePromptBlocks(config.cwd ?? process.cwd())
  return {
    profile: policy.profile,
    toolDescriptions: policy.toolDescriptions,
    report: buildBudgetReport(config.promptEngine.getPrefixBudgetInputs()),
    userInstructions: config.promptEngine.getUserInstructionsStatus(),
  }
}
