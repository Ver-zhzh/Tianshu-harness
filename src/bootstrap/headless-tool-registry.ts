import { createInteractiveToolRegistry, type RuntimeRefs } from '../bootstrap.js'
import type { Config } from '../config/schema.js'
import type { SessionPersist } from '../agent/session-persist.js'
import { TodoStore } from '../tools/todo-store.js'
import { createMemoryTool } from '../tools/memory.js'
import { presetIncludes } from '../tools/tool-preset.js'
import type { GoalTracker } from '../agent/goal-tracker.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

/** Same built-ins and preset metadata as TUI/sidecar; coordinator is bound after assembly. */
export function createHeadlessToolRegistry(config: Config, cwd: string, sessionId: string, persist: SessionPersist,
  goalTrackerRef: { current: GoalTracker | null }, indexer: MeridianIndexer, getTurn: () => number) {
  const claimStore = persist.createClaimStore()
  const refs: RuntimeRefs = {
    coordinator: null, fileHistory: null, claimStore, sessionId, sessionRegistry: null,
    taskLedger: null, ownershipLedger: null, verificationSnapshotManager: null, deliveryGate: null,
    meridianIndexer: indexer, mcpManager: null, lspManager: null, banditState: null, promptEngine: null,
    goalTrackerRef, reviewGateRef: { current: 'off' }, pluginHooks: [], pluginCommands: [], todoStore: new TodoStore(),
  }
  const { registry, toolPreset } = createInteractiveToolRegistry(refs, config, cwd)
  if (presetIncludes(toolPreset, 'memory')) registry.register(createMemoryTool(claimStore, { cwd, sessionId, getTurn }))
  return { registry, refs, claimStore }
}
