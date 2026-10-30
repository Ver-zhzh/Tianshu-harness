import type { OaiMessage } from '../api/oai-types.js'
import type { HistoryIntegrityDetails } from '../api/continuation-prefix.js'
import { verifyLines } from './checksum.js'
import { serializeOaiSessionMessage } from './session-message-serialization.js'
import { readFileSync } from 'node:fs'
import { parseFrozenSnapshotData } from '../prompt/frozen-snapshot.js'

export const SESSION_AUDIT_LINE_TYPES: ReadonlySet<string> = new Set(['compact_start', 'compact_end', 'model_switch'])

export function canonicalOrphanOutcomes(frozenPath: string, messages: readonly OaiMessage[]): Array<{ id: string; name: string }> | undefined {
  try {
    const snapshot = parseFrozenSnapshotData(JSON.parse(readFileSync(frozenPath, 'utf8')))
    if (!snapshot || !(snapshot.publishedHistory || snapshot.rewindAuthorization?.history)) return undefined
    const results = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
    return messages.flatMap(message => message.role === 'assistant'
      ? (message.tool_calls ?? []).filter(call => call.id && !results.has(call.id)).map(call => ({ id: call.id, name: call.function.name })) : [])
  } catch { return undefined }
}

export function describePersistedHistory(read: () => string, messages: readonly OaiMessage[]): HistoryIntegrityDetails {
  try { return describeOaiHistoryIntegrity(read(), messages) }
  catch (error) { return { reason: String(error).includes('incomplete frame') ? 'incomplete_frame' : 'unreadable', memoryCount: messages.length, persistedCount: null } }
}

export function describeOaiHistoryIntegrity(transcript: string, messages: readonly OaiMessage[]): HistoryIntegrityDetails {
  const rows = readMessageRows(transcript)
  if (!rows) return { reason: 'checksum', memoryCount: messages.length, persistedCount: null }
  const firstMismatch = messages.findIndex((message, index) => rows[index] !== serializeOaiSessionMessage(message))
  const index = firstMismatch >= 0 ? firstMismatch : rows.length > messages.length ? messages.length : undefined
  return { reason: rows.length < messages.length ? 'missing' : rows.length > messages.length ? 'extra' : index === undefined ? 'none' : 'changed',
    memoryCount: messages.length, persistedCount: rows.length, ...(index === undefined ? {} : { firstMismatch: index }),
    legacyTruncation: rows.some(row => row.includes('<session-message-truncated ')) }
}

function readMessageRows(transcript: string): string[] | undefined {
  const lines = transcript.trim().split('\n').filter(Boolean)
  const { validLines, invalidCount } = verifyLines(lines)
  if (invalidCount > 0) return undefined
  return validLines.filter(line => {
    const parsed = JSON.parse(line) as { type?: string }
    return !parsed.type || !SESSION_AUDIT_LINE_TYPES.has(parsed.type)
  })
}

export function matchesOaiSessionProjection(transcript: string, messages: readonly OaiMessage[], maxChars?: number): boolean {
  const rows = readMessageRows(transcript)
  return rows !== undefined && rows.length === messages.length
    && rows.every((line, index) => line === serializeOaiSessionMessage(messages[index]!, maxChars))
}

export function canRepairOaiSessionProjection(transcript: string, messages: readonly OaiMessage[], maxChars?: number): boolean {
  const rows = readMessageRows(transcript)
  if (!rows || rows.length === 0 || rows.length > messages.length) return false
  let cursor = 0
  for (const row of rows) {
    let matched = false
    while (cursor < messages.length) {
      const message = messages[cursor++]!
      if (row === serializeOaiSessionMessage(message)
        || (maxChars !== undefined && row === serializeOaiSessionMessage(message, maxChars))) {
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return true
}
