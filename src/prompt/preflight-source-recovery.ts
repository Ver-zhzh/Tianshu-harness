import type { OaiMessage } from '../api/oai-types.js'
import { proveRewindHistory, type ContinuationPrefixProof } from '../api/continuation-prefix.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'

export function recoverLegacyPreflightSource(messages: OaiMessage[], current: ContinuationPrefixProof['messages'],
  published: ContinuationPrefixProof['messages']): ContinuationPrefixProof['messages'] | undefined {
  const original: OaiMessage[] = []
  let cursor = 0
  let skipped = 0
  for (const expected of published) {
    while (cursor < current.length && current[cursor]!.hash !== expected.hash) {
      if (messages[cursor]?.role !== 'tool') return undefined
      cursor++
      skipped++
    }
    if (cursor >= current.length) return undefined
    original.push(messages[cursor++]!)
  }
  if (!skipped) return undefined
  const repaired = runResumePreflightOai(original)
  if (!repaired.repaired || repaired.syntheticResultsInserted !== skipped || repaired.messages.length !== cursor) return undefined
  return proveRewindHistory(repaired.messages).every((message, index) => current[index]?.hash === message.hash)
    ? current.slice(0, cursor) : undefined
}

export function preservesPublishedWire(previous: ContinuationPrefixProof, next: ContinuationPrefixProof,
  source: ContinuationPrefixProof['messages']): boolean {
  return previous.version === 2 && next.version === 2 && previous.canonicalSource === undefined && next.canonicalSource === undefined
    && previous.messages.length === source.length + 1 && previous.messages[0]?.role === 'system'
    && source.every((message, index) => previous.messages[index + 1]?.role === message.role)
    && previous.provider === next.provider && previous.model === next.model && previous.endpointHash === next.endpointHash
    && previous.credentialScope === next.credentialScope && previous.cacheGenerationId === next.cacheGenerationId
    && previous.optionsHash === next.optionsHash && previous.toolsHash === next.toolsHash
    && previous.messages.every((message, index) => next.messages[index]?.hash === message.hash)
}
