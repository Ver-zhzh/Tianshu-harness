import { stat } from 'node:fs/promises'
import { statSync, readFileSync } from 'node:fs'
import { readFilePayload } from '../tools/read-file.js'
import type { PrewarmCache } from './prewarm.js'

const MAX_PREWARM_BYTES = 100_000

export interface PrewarmValue {
  canonicalPath: string
  content: string
  uiContent: string
  /**
   * File mtime (ms) at prewarm time. The consumer re-stats the live file and
   * uses metadata as an early rejection before checking the actual bytes.
   */
  mtimeMs: number
  /**
   * stat().size at prewarm time — second staleness signal alongside mtime,
   * hardening against coarse-mtime filesystems (exFAT: 2s granularity) where
   * an edit inside the same timestamp window keeps mtime identical. Mirrors
   * ReadHistoryEntry.sizeBytes in read-file.ts.
   */
  sizeBytes: number
}

/** Check if a read_file call can use prewarm cache (only full-file reads). */
export function canUsePrewarmForRead(input: Record<string, unknown>): boolean {
  return typeof input.file_path === 'string'
    && input.offset === undefined
    && input.limit === undefined
}

/** Safely read a file for prewarm cache.
 *
 *  Stores the **full raw content** (no read cap applied), NOT the model-facing
 *  truncated/folded content. The read tool applies the active contextWindow's
 *  cap at consume time, so cap consistency is automatic regardless of which
 *  contextWindow was active when the file was prewarmed. Storing a cap-baked
 *  value here is what made the prewarm cache a dead store — a file prewarmed
 *  under a smaller cap would have served truncated content under a later larger
 *  cap (truncation regression). */
export async function buildPrewarmValue(cwd: string, filePath: string): Promise<PrewarmValue | undefined> {
  try {
    const payload = await readFilePayload(cwd, { filePath })
    const fileStat = await stat(payload.canonicalPath)
    if (fileStat.size > MAX_PREWARM_BYTES) return undefined
    return {
      canonicalPath: payload.canonicalPath,
      content: payload.rawContent,
      uiContent: payload.uiContent,
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
    }
  } catch {
    return undefined
  }
}

/** Alias for batch callers that already use async. */
export const buildPrewarmValueAsync = buildPrewarmValue

/**
 * Consume a prewarmed file: return its full raw content only when a cache entry
 * exists AND the live file's metadata and bytes match the cached content.
 *
 * Returns `null` on miss or staleness (external edit) — the caller then falls
 * back to a normal read. This is the consumer the prewarm cache was missing: it
 * is the first `PrewarmCache.get()` call site in non-test code. The returned
 * content is the **full file** with no read cap; the read tool applies the
 * active contextWindow's cap, so cap consistency holds regardless of which cap
 * was in effect when the file was prewarmed.
 *
 * The byte comparison is bounded by MAX_PREWARM_BYTES. It also catches same-size,
 * same-mtime edits; metadata alone cannot establish a content version.
 */
export function consumePrewarm(cache: PrewarmCache, canonicalPath: string): PrewarmValue | null {
  const value = cache.get(canonicalPath)
  if (!value) return null
  try {
    const live = statSync(canonicalPath)
    if (live.size > MAX_PREWARM_BYTES || live.mtimeMs !== value.mtimeMs || live.size !== value.sizeBytes
      || !readFileSync(canonicalPath).equals(Buffer.from(value.content, 'utf8'))) {
      cache.invalidate(canonicalPath)
      return null // file changed externally since prewarm (mtime OR size moved)
    }
    return value
  } catch {
    cache.invalidate(canonicalPath)
    return null // file deleted or unreadable
  }
}

/**
 * Batch prewarm recently-read files — yields to the event loop between
 * each file so the TUI stays responsive during turn boundary.
 * `limit` caps files per call (default 5); batch dispatch pre-warming
 * passes a larger explicit bound.
 */
export async function batchPrewarm(
  cwd: string,
  paths: string[],
  cache: import('./prewarm.js').PrewarmCache,
  limit = 5,
): Promise<void> {
  let count = 0
  for (const filePath of paths) {
    if (count >= limit) break
    const value = await buildPrewarmValueAsync(cwd, filePath)
    if (!value) continue
    if (cache.has(value.canonicalPath)) continue
    cache.set(value.canonicalPath, value)
    count++
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
