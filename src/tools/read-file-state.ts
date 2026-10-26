import { createHash } from 'node:crypto'
import { canonicalPathKey } from '../path-format.js'

function observationKey(sessionId: string | undefined, path: string): string { return `${sessionId ?? ''}::${canonicalPathKey(path)}` }

/** 表2 — last observed file state per session. Written by read_file, grep
 *  registration, AND successful edits (edit_file/hash_edit/write_file). Read
 *  by the stale-file detection in the edit tools and read_section.
 *
 *  This is deliberately separate from readHistory/fileReadHistory (表1): 表1
 *  means "content the model actually read" and is only ever written by read
 *  paths — edits DELETE its entries (invalidateReadHistory) so read-ref can
 *  never claim "unchanged" against pre-edit content. 表2 carries the old
 *  refreshFileReadMtime duty: after our own successful edit we note the new
 *  mtime here so the next edit's staleness check doesn't false-positive on
 *  our own write (read-edit-stale loop prevention). */
interface KnownFileState {
  mtimeMs: number
  sizeBytes: number
  fullyObserved?: boolean
  /** Known whole-file version; complete read permission additionally requires fullyObserved. */
  contentHash?: string
}
export const lastKnownFileState = new Map<string, KnownFileState>()
const LAST_KNOWN_MAX = 500

export function trimLastKnown(): void {
  if (lastKnownFileState.size <= LAST_KNOWN_MAX) return
  const drop = Math.ceil(lastKnownFileState.size * 0.2)
  let i = 0
  for (const key of lastKnownFileState.keys()) {
    lastKnownFileState.delete(key)
    if (++i >= drop) break
  }
}

/** Return the last mtimeMs this session observed for a file (via read_file,
 *  grep, or its own successful edit), or null if never observed. */
export function getFileReadMtime(canonicalPath: string, sessionId?: string): number | null {
  const entry = lastKnownFileState.get(observationKey(sessionId, canonicalPath))
  return entry ? entry.mtimeMs : null
}

/** Record the file state this session just observed (read or wrote).
 *  Successor of the old refreshFileReadMtime: after a successful edit the
 *  caller notes the post-write mtime here so the NEXT edit's staleness check
 *  doesn't false-positive on our own write (read-edit-stale loop prevention).
 *  Writes 表2 only — never touches the read-dedup tables, so read-ref can
 *  never be tricked into claiming pre-edit content is current. */
export function noteFileObserved(canonicalPath: string, mtimeMs: number, sizeBytes: number, sessionId?: string, content?: string, fullyObserved = content !== undefined): void {
  const key = observationKey(sessionId, canonicalPath)
  const previous = lastKnownFileState.get(key)
  const contentHash = content !== undefined ? createHash('sha256').update(content).digest('hex')
    : previous?.mtimeMs === mtimeMs && previous.sizeBytes === sizeBytes ? previous.contentHash : undefined
  lastKnownFileState.set(key, { mtimeMs, sizeBytes, contentHash, fullyObserved: fullyObserved || previous?.contentHash === contentHash && previous?.mtimeMs === mtimeMs && previous.sizeBytes === sizeBytes && previous.fullyObserved })
  trimLastKnown()
}

export function getFileReadContentHash(canonicalPath: string, sessionId?: string): string | undefined {
  return lastKnownFileState.get(observationKey(sessionId, canonicalPath))?.contentHash
}
export function hasObservedFileVersion(path: string, mtimeMs: number, sizeBytes: number, sessionId?: string): boolean {
  const state = lastKnownFileState.get(observationKey(sessionId, path))
  return state?.contentHash !== undefined && state.mtimeMs === mtimeMs && state.sizeBytes === sizeBytes
}
/** A confirmed disk change invalidates every session's observation of that path. */
export function forgetFileObservations(path: string): void {
  const suffix = `::${canonicalPathKey(path)}`
  for (const key of lastKnownFileState.keys()) if (key.endsWith(suffix)) lastKnownFileState.delete(key)
}
export function isFileFullyObserved(canonicalPath: string, sessionId?: string): boolean {
  return lastKnownFileState.get(observationKey(sessionId, canonicalPath))?.fullyObserved === true
}

/** Mutations replace observation scope, even on coarse-mtime, same-size writes. */
export function noteFileWritten(path: string, mtimeMs: number, sizeBytes: number, sessionId?: string, content?: string, fullyObserved = false): void {
  lastKnownFileState.set(observationKey(sessionId, path), {
    mtimeMs, sizeBytes, fullyObserved,
    contentHash: content === undefined ? undefined : createHash('sha256').update(content).digest('hex'),
  })
  trimLastKnown()
}

export function observationForVersion(path: string, sessionId: string | undefined, version: string): 'full' | 'partial' | 'unknown' {
  const state = lastKnownFileState.get(observationKey(sessionId, path))
  return state?.contentHash === version ? state.fullyObserved ? 'full' : 'partial' : 'unknown'
}
