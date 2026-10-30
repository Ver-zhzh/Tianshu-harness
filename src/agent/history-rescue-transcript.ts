import type { OaiMessage } from '../api/oai-types.js'
import type { Message } from '../api/types.js'
import { verifyLines } from './checksum.js'
import { isOaiMessage, parseSessionLine } from './session-persist.js'
import { legacyMessageToOaiMessages } from './session-message-conversion.js'
import { decodeTranscriptText, isZstdFrameStream, scanZstdFrames } from './session-transcript-codec.js'
import { describePersistedHistory } from './session-oai-projection.js'

/** Decode the captured bytes, without re-reading a moving file or synthesizing tool results. */
export function readHistoryRescueTranscript(bytes: Buffer) {
  const messages: OaiMessage[] = []
  let text = '', failure: unknown
  try { text = decodeTranscriptText(bytes) } catch (error) { failure = error }
  for (const row of verifyLines(text.trim().split('\n').filter(Boolean)).validLines) {
    try {
      const parsed = parseSessionLine(row)
      if (!parsed) continue
      if (isOaiMessage(parsed)) messages.push(parsed)
      else messages.push(...legacyMessageToOaiMessages(parsed as Message))
    } catch { /* Invalid rows remain in the exact-byte rescue export. */ }
  }
  const diagnostic = describePersistedHistory(() => {
    if (failure) throw failure
    if (isZstdFrameStream(bytes) && scanZstdFrames(bytes).tornStart !== undefined) throw new Error('incomplete frame')
    return text
  }, messages)
  return { messages, diagnostic }
}
