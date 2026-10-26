import type { AgentLoop } from './loop.js'
import type { RuntimeRefs } from '../bootstrap.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import { debugLog } from '../utils/debug.js'

/**
 * 显式挂载的继承必须可观测：新 agent 恢复不了的挂载点会静默缩小模型可见面。
 * 以新 Agent 实际发布的定义判定，不能把挂载返回值当作可见性证明。
 */
function restoreMountedTools(
  oldAgent: AgentLoop,
  candidate: AgentLoop,
  report: (message: string) => void,
): void {
  const lost: string[] = []
  for (const name of oldAgent.getMountedToolNames()) {
    const result = candidate.enableTool(name)
    if (candidate.getActiveToolNames().includes(name)) continue
    debugLog(`[agent] explicit mount not restored after replacement: ${name} → ${result.status}`)
    lost.push(`${name}(${result.status})`)
  }
  if (lost.length > 0) {
    report(`[tools] 模型替换后未恢复的显式挂载：${lost.join('、')}；如需继续使用，请检查档位/禁用配置后重新启用。`)
  }
}

/** Prepare a replacement without invalidating the outgoing runtime on failure. */
export function buildReplacementAgent(
  oldAgent: AgentLoop,
  refs: RuntimeRefs,
  recallRef: { current?: AgentLoop } | undefined,
  explicitModelChange: boolean,
  build: (inherited: PromptEngine | FrozenSnapshotData) => AgentLoop,
  report: (message: string) => void = message => { process.stderr.write(message + '\n') },
): AgentLoop {
  const priorRefs = { ...refs }
  const priorBoxes = Object.values(priorRefs)
    .filter((value): value is { current: unknown } => !!value && typeof value === 'object' && 'current' in value)
    .map(box => [box, box.current] as const)
  const priorRecallAgent = recallRef?.current
  const notices: string[] = []
  const inherited = explicitModelChange
    ? { ...oldAgent.config.promptEngine.exportFrozenSnapshot(), executionSnapshot: undefined, rewindAuthorization: undefined }
    : oldAgent.config.promptEngine
  let candidate: AgentLoop | undefined
  try {
    candidate = build(inherited)
    restoreMountedTools(oldAgent, candidate, text => notices.push(text))
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
  void oldAgent.config.externalHookRuntime?.close().catch(() => {})
  void oldAgent.cancelIdleCompaction()
  try { oldAgent.stopFsWatcher() } catch { /* best-effort cleanup */ }
  try { oldAgent.stopConfigWatcher() } catch { /* best-effort cleanup */ }
  if (priorRefs.coordinator && priorRefs.coordinator !== refs.coordinator) {
    try { priorRefs.coordinator.shutdown() } catch { /* best-effort cleanup */ }
  }
  // Notification failure must not roll back an already committed replacement.
  for (const notice of notices) { try { report(notice) } catch { debugLog('[agent] runtime notice delivery failed') } }
  return candidate
}
