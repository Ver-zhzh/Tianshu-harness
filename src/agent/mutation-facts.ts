import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentFileVersion } from './file-version.js'
import { checkSyntax, type SyntaxCheckResult } from '../tools/syntax-check.js'
import type { FileChangeRecord } from './recovery-stack.js'

export type ParseState = 'valid' | 'invalid' | 'unknown' | 'missing'
export interface MutationObservation { version: string | null; parse: ParseState; html?: SyntaxCheckResult['html']; symbols?: string[] }
export interface MutationFact {
  intent?: 'draft-append'
  sessionId?: string
  toolCallId: string
  file: string
  before: MutationObservation
  after: MutationObservation
  attemptedParse: ParseState
  attempted: boolean
  restoration: 'none' | 'restored' | 'conflict'
}
const checks = new WeakMap<FileChangeRecord, ParseState>()
const restores = new WeakMap<FileChangeRecord, boolean>()
export function noteMutationSyntax(capture: FileChangeRecord | undefined, check: SyntaxCheckResult): void {
  if (capture) checks.set(capture, check.fatal ? 'invalid' : check.checked === false ? 'unknown' : 'valid')
}
export function noteMutationRestoration(capture: FileChangeRecord, restored: boolean): void { restores.set(capture, restored) }
export async function observeMutationFile(cwd: string, file: string): Promise<MutationObservation> {
  try {
    const path = join(cwd, file), version = currentFileVersion(path)
    if (version === null) return { version, parse: 'missing' }
    const check = await checkSyntax(path, await readFile(path, 'utf8'), { parseOnly: true })
    if (currentFileVersion(path) !== version) return { version: null, parse: 'unknown' }
    return { version, parse: check.fatal ? 'invalid' : check.checked === false ? 'unknown' : 'valid', ...(check.html ? { html: check.html } : {}), ...(check.symbols ? { symbols: check.symbols } : {}) }
  } catch { return { version: null, parse: 'unknown' } }
}
export async function mutationFact(cwd: string, capture: FileChangeRecord, before: MutationObservation, sessionId?: string): Promise<MutationFact> {
  const after = await observeMutationFile(cwd, capture.filePath), restored = restores.get(capture)
  const attemptedParse = checks.get(capture) ?? (restored === undefined ? after.parse : 'unknown')
  return { sessionId, toolCallId: capture.toolCallId, file: capture.filePath, before, after, attemptedParse, intent: capture.intent,
    attempted: restored !== undefined || before.version !== after.version,
    restoration: restored === undefined ? 'none' : restored ? 'restored' : 'conflict' }
}
