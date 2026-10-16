import type { OaiMessage } from '../api/oai-types.js'
import { LocalWorkerPolicyError } from '../api/continuation-prefix.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import type { WriteProbe } from '../context/write-evidence-probe.js'
import { debugLog } from '../utils/debug.js'
import type { SessionContext } from './context.js'

export interface CompactionHistorySource {
  messages: OaiMessage[]
  json: string
}

export function captureCompactionHistory(session: SessionContext): CompactionHistorySource {
  const messages = session.getMessages().slice()
  return { messages, json: JSON.stringify(messages) }
}

/**
 * Replace session messages after running OAI orphan-tool_call preflight.
 *
 * Compaction paths (tryPartialCompact, replaceWithCheckpoint, microCompact)
 * can produce message lists where an assistant(tool_calls) survives but its
 * matching tool result was deleted. The OpenAI-compatible API rejects such
 * sequences with: "An assistant message with 'tool_calls' must be followed
 * by tool messages responding to each 'tool_call_id'."
 *
 * runResumePreflightOai detects orphans and inserts synthetic tool results,
 * making the sequence safe to send.
 */
export async function commitCompactionHistory(deps: {
  session: SessionContext
  writeProbe?: WriteProbe
  commitHistory?: (expected: OaiMessage[], candidate: OaiMessage[]) => Promise<void>
  onHistoryRewritten?: () => void | Promise<void>
}, messages: OaiMessage[], expected: CompactionHistorySource, backupTranscript: () => void): Promise<void> {
  if (JSON.stringify(deps.session.getMessages()) !== expected.json) {
    throw new LocalWorkerPolicyError('历史在压缩摘要期间发生变化；禁止替换')
  }
  // Optional pre-compaction transcript snapshot: capture the CURRENT (pre-replace)
  // message list before it is overwritten. This is the single choke point for
  // every compaction path, so one hook covers partial / checkpoint / micro.
  backupTranscript()
  const preflight = runResumePreflightOai(messages, { writeProbe: deps.writeProbe })
  if (preflight.repaired) {
    debugLog(`[compact-preflight] repaired ${preflight.syntheticResultsInserted} orphan tool_call(s)`)
  }
  if (deps.commitHistory) await deps.commitHistory(expected.messages, preflight.messages)
  else deps.session.replaceMessages(preflight.messages)
  // History rewritten — read-ref's "look above" targets may be gone.
  try { await deps.onHistoryRewritten?.() } catch { /* never block compaction */ }
}
