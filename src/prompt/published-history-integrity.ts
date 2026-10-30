import { proveRewindHistory, HistoryIntegrityError, type ContinuationPrefixProof } from '../api/continuation-prefix.js'
import type { OaiMessage } from '../api/oai-types.js'

export function assertPublishedSourceHistory(published: ContinuationPrefixProof['messages'], messages: readonly OaiMessage[]): void {
  const current = proveRewindHistory(messages)
  const firstMismatch = published.findIndex((message, index) => current[index]?.hash !== message.hash)
  if (firstMismatch >= 0) throw new HistoryIntegrityError('已发布的源历史发生变化；禁止通过压缩授权改写', {
    reason: 'published_source', memoryCount: messages.length, persistedCount: null, publishedCount: published.length, firstMismatch,
  })
}
