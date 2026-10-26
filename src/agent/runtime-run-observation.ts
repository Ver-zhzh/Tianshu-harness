import { runtimeObservation, withRuntimeRun } from '../utils/runtime-provenance.js'
import type { AgentLoop } from './loop.js'

export function observeAgentRuntimeRun<T>(agent: Pick<AgentLoop, 'config' | 'persist' | 'telemetryWriter'>, runId: string, operation: () => T): T {
  return withRuntimeRun({ runId, sessionId: agent.config.sessionId }, () => {
    const observation = runtimeObservation()
    try { agent.persist?.updateMetadata({ lastRuntimeRun: observation }) } catch { /* diagnostics cannot block a run */ }
    try { agent.telemetryWriter?.write({ kind: 'runtime-run', ...observation }) } catch { /* same rule for custom writers */ }
    return operation()
  })
}
