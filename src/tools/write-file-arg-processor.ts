/**
 * write_file arg processor — replaces the full `content` field in tool call
 * arguments with a file pointer once it crosses the size threshold, because
 * write_file.execute already persists the content to `file_path` on disk.
 *
 * This is the W2 fix for the empirically observed cache break: a ~20KB
 * write_file content argument pushed verbatim into oaiMessages broke the
 * exact-prefix cache for the rest of the session.
 *
 * PURE SYNC operation — no artifactStore needed, the tool itself owns the write.
 */

import { createFileContentArgProcessor } from '../agent/tool-arg-post-processor.js'
import { toPosixPath } from '../path-format.js'
import { POINTER_INTERNAL_TAG } from './pointer-tag.js'

export const WRITE_FILE_POINTER_PREFIX = '[file written to'

/**
 * Below this many chars the content stays inline — small files / configs are
 * cheap to keep and re-reading them as a pointer would only add round-trips.
 * The real damage came from multi-KB payloads, so 2000 is a conservative floor.
 */
export const WRITE_FILE_CONTENT_THRESHOLD = 2000

export const writeFileArgProcessor = createFileContentArgProcessor({
  toolName: 'write_file',
  contentField: 'content',
  pointerPrefix: WRITE_FILE_POINTER_PREFIX,
  threshold: WRITE_FILE_CONTENT_THRESHOLD,
  resolvePath: parsed => {
    const fp = parsed.file_path
    return typeof fp === 'string' && fp.length > 0 ? toPosixPath(fp) : null
  },
  render: ({ path, lines, chars }) =>
    `${WRITE_FILE_POINTER_PREFIX} ${path} — ${lines} lines, ${chars} chars. 请求内容已折叠；执行状态以工具结果为准，按需 read_file。${POINTER_INTERNAL_TAG} display-only pointer]`,
})

/**
 * Parse a regurgitated write_file pointer line back into its parts — the inverse
 * of `render` above (single source of truth for the format). Returns null when
 * the line is not a well-formed write_file pointer. Used by write_file's
 * idempotent resolution: a pointer echoed back as content for the SAME path
 * means the intended content is already on disk.
 */
export function parseWriteFilePointer(line: string): { path: string; lines: number; chars: number } | null {
  const m = /^\[file written to (.+?) — (\d+) lines, (\d+) chars\./.exec(line.trimStart())
  if (!m) return null
  return { path: m[1]!, lines: Number(m[2]), chars: Number(m[3]) }
}
