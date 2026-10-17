import type { AgentLoop } from './loop.js'
import type { RuntimeRefs } from '../bootstrap.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'

/** Prepare a replacement without invalidating the outgoing runtime on failure. */
export function buildReplacementAgent(
  oldAgent: AgentLoop,
  refs: RuntimeRefs,
  recallRef: { current?: AgentLoop } | undefined,
  explicitModelChange: boolean,
  build: (inherited: PromptEngine | FrozenSnapshotData) => AgentLoop,
): AgentLoop {
  const priorRefs = { ...refs }
  const priorBoxes = Object.values(priorRefs)
    .filter((value): value is { current: unknown } => !!value && typeof value === 'object' && 'current' in value)
    .map(box => [box, box.current] as const)
  const priorRecallAgent = recallRef?.current
  const inherited = explicitModelChange
    ? { ...oldAgent.config.promptEngine.exportFrozenSnapshot(), executionSnapshot: undefined, rewindAuthorization: undefined }
    : oldAgent.config.promptEngine
  let candidate: AgentLoop | undefined
  try {
    candidate = build(inherited)
    if (explicitModelChange) candidate.config.client.authorizeCacheGeneration?.('explicit_user_model')
  } catch (error) {
    try { candidate?.stopFsWatcher() } catch { /* best-effort cleanup */ }
    try { candidate?.stopConfigWatcher() } catch { /* best-effort cleanup */ }
    if (refs.coordinator !== priorRefs.coordinator) {
      try { refs.coordinator?.shutdown() } catch { /* best-effort cleanup */ }
    }
    for (const key of Object.keys(refs)) if (!(key in priorRefs)) Reflect.deleteProperty(refs, key)
    Object.assign(refs, priorRefs)
    for (const [box, current] of priorBoxes) box.current = current
    if (recallRef) recallRef.current = priorRecallAgent
    throw error
  }
  void oldAgent.cancelIdleCompaction()
  try { oldAgent.stopFsWatcher() } catch { /* best-effort cleanup */ }
  try { oldAgent.stopConfigWatcher() } catch { /* best-effort cleanup */ }
  if (priorRefs.coordinator && priorRefs.coordinator !== refs.coordinator) {
    try { priorRefs.coordinator.shutdown() } catch { /* best-effort cleanup */ }
  }
  return candidate
}
