import type { OaiMessage } from './oai-types.js'
import { sanitizeMessageContent } from '../utils/sanitize.js'

export const OPENAI_WIRE_TRANSFORM_VERSION = 'openai-chat-canonical-v1'

/** Lengths and offsets describe JSON UTF-16 characters, never retained content. */
export interface WireNormalizationSummary {
  version: string
  changedMessages: number
  deltaChars: number
  firstChangedMessage?: number
  firstChangedOffset?: number
}

/** No cross-request state: rebuilt frozen messages must receive the same transform. */
export function normalizeWireMessages(messages: OaiMessage[]): { messages: OaiMessage[]; normalization: WireNormalizationSummary } {
  let result: OaiMessage[] | undefined
  const normalization: WireNormalizationSummary = { version: OPENAI_WIRE_TRANSFORM_VERSION, changedMessages: 0, deltaChars: 0 }
  for (let i = 0; i < messages.length; i++) {
    const original = messages[i]!
    const normalized = sanitizeMessageContent(original)
    if (normalized === original) continue
    result ??= messages.slice()
    result[i] = normalized
    const before = JSON.stringify(original), after = JSON.stringify(normalized)
    normalization.changedMessages++
    normalization.deltaChars += after.length - before.length
    if (normalization.firstChangedMessage === undefined) {
      normalization.firstChangedMessage = i
      let offset = 0
      while (offset < Math.min(before.length, after.length) && before[offset] === after[offset]) offset++
      normalization.firstChangedOffset = offset
    }
  }
  return { messages: result ?? messages, normalization }
}
