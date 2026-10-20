/**
 * Context Collapse: replaces old tool results with semantic summaries.
 *
 * Inspired by Claude Code's Context Collapse strategy — instead of simple
 * truncation (keep first N chars), extract the semantic meaning of a tool
 * result and replace it with a compact summary.
 *
 * Example: a 2000-char grep result becomes "grep 'foo' in src/ → 14 matches
 * across 8 files" (~50 chars). This is 40x compression with high signal retention.
 */

import {
  RUN_TESTS_EXIT_CODE_RE,
  RUN_TESTS_FAILED_RE,
  RUN_TESTS_PASSED_RE,
} from '../tools/run-tests.js'
import { grepOutputStats } from '../utils/grep-output.js'

export interface CollapsedResult {
  toolName: string
  summary: string
  originalTokens: number
  collapsedTokens: number
}

const CHARS_PER_TOKEN = 4

/**
 * Attempt to collapse a tool result into a semantic summary.
 * Returns null if the result is too small to be worth collapsing (< 200 chars)
 * or if the tool type is not recognized.
 *
 * @param toolName  - The tool that produced this result
 * @param content   - The full text content of the tool result
 * @param turnAge   - How many turns ago this result was produced (0 = current turn)
 * @param contextWindow - The total context window size in tokens
 */
export function collapseToolResult(
  toolName: string,
  content: string,
  turnAge: number,
  _contextWindow: number,
): CollapsedResult | null {
  if (content.length < 200) return null
  if (turnAge < 2) return null

  const originalTokens = Math.ceil(content.length / CHARS_PER_TOKEN)

  let result: CollapsedResult
  if (toolName === 'grep' || toolName === 'search') {
    result = collapseGrepResult(toolName, content, originalTokens)
  } else if (toolName === 'read_file') {
    result = collapseReadFileResult(content, originalTokens)
  } else if (toolName === 'bash') {
    result = collapseBashResult(content, originalTokens)
  } else if (toolName === 'write_file' || toolName === 'edit_file') {
    result = collapseWriteResult(toolName, content, originalTokens)
  } else if (toolName === 'run_tests') {
    result = collapseRunTestsResult(content, originalTokens)
  } else if (toolName === 'delegate_task' || toolName === 'delegate_batch') {
    result = collapseDelegateResult(toolName, content, originalTokens)
  } else {
    result = collapseGenericResult(toolName, content, originalTokens)
  }

  return preserveArtifactRef(content, result)
}

/**
 * T7 layering: request-layer collapse must not become a recall blind spot.
 * Large tool results carry a trailing/leading `[artifact:id]` marker (added by
 * the storage-layer artifact intercept). When T7 folds such a result into a
 * `[collapsed ...]` summary, preserve the artifact id so the model can still
 * read_section it — the storage original is untouched, only the request copy is
 * folded, so the reference stays valid. Results without a marker are left as-is
 * (no disk write on the request hot path); their storage original is intact and
 * naturally restored when fillRatio recovers.
 */
function preserveArtifactRef(content: string, result: CollapsedResult): CollapsedResult {
  const artifactId = content.match(/\[artifact:([^\]]+)\]/)?.[1]
  if (!artifactId || result.summary.includes(artifactId)) return result
  // Insert the recall hint before the closing bracket of the summary.
  const summary = result.summary.endsWith(']')
    ? `${result.summary.slice(0, -1)} | read_section artifact:${artifactId}]`
    : `${result.summary} [read_section artifact:${artifactId}]`
  return { ...result, summary, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseGrepResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  // 已带 artifact 的结果：正文是工具层的 head/tail 截断副本——此处对残缺正文
  // 重算行数会把 head 的少数行包装成完整读数（台账 F4：实测 65/20 被抹成
  // 8/4，且 `[artifact:…]` 行本身还会被数成一个「文件」）。工具层已给出全量
  // 统计（summarizeGrepResult 的 `grep "…": N matches in M files`）——沿用之；
  // 解析不到则只留回读提示。格式耦合：同仓同版可接受，失配自动落 fallback。
  if (/\[artifact:[^\]]+\]/.test(content)) {
    const fullStatLine = content
      .split('\n')
      .map(l => l.trim())
      .find(l => /^(grep|search) ".*": \d+ matches in \d+ files/.test(l))
    const summary = fullStatLine
      ? `[collapsed ${toolName}: ${fullStatLine.slice(0, 240)}]`
      : `[collapsed ${toolName}: 正文已截断，完整匹配列表见 artifact]`
    return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
  }

  const { matches: matchCount, files } = grepOutputStats(content)
  const topFiles = files.slice(0, 8)
  const moreFiles = files.length > 8 ? ` (+${files.length - 8} more)` : ''

  const summary = `[collapsed ${toolName}: ${matchCount} matches in ${files.length} files: ${topFiles.join(', ')}${moreFiles}]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseReadFileResult(
  content: string,
  originalTokens: number,
  maxScanLines = 100,
): CollapsedResult {
  const lines = content.split('\n')
  const lineCount = lines.length

  const exports: string[] = []
  const functions: string[] = []
  const classes: string[] = []

  for (const line of lines.slice(0, maxScanLines)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('export ')) exports.push(trimmed.slice(0, 80))
    if (/^(export\s+)?(async\s+)?function\s+\w/.test(trimmed)) {
      const name = trimmed.match(/function\s+(\w+)/)?.[1]
      if (name) functions.push(name)
    }
    if (/^(export\s+)?class\s+\w/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1]
      if (name) classes.push(name)
    }
  }

  const parts: string[] = [`${lineCount} lines`]
  if (classes.length > 0) parts.push(`classes: ${classes.slice(0, 5).join(', ')}`)
  if (functions.length > 0) parts.push(`functions: ${functions.slice(0, 8).join(', ')}`)
  if (exports.length > 0 && classes.length === 0 && functions.length === 0) {
    parts.push(`${exports.length} exports`)
  }

  const summary = `[collapsed read_file: ${parts.join(', ')}]`
  return { toolName: 'read_file', summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseBashResult(content: string, originalTokens: number): CollapsedResult {
  const lines = content.split('\n').filter(l => l.trim())
  const lineCount = lines.length

  const lastLines = lines.slice(-3)
  const exitCodeMatch = content.match(/exit code[:\s]+(\d+)/i)
  const exitCode = exitCodeMatch?.[1] ?? null

  // Extract fail/error lines — highest signal in test output
  const failPattern = /fail|error|FAIL|ERROR|✗|✘|❌/i
  const failLines = lines
    .filter(l => failPattern.test(l) && !/^\s*[✓✔●◌⊙]/.test(l))
    .slice(0, 5)

  const parts: string[] = [`${lineCount} lines output`]
  if (exitCode !== null) parts.push(`exit ${exitCode}`)
  if (failLines.length > 0) parts.push(`fails: ${failLines.map(l => l.slice(0, 80)).join(' | ')}`)
  parts.push(`tail: ${lastLines.map(l => l.slice(0, 60)).join(' | ')}`)

  const summary = `[collapsed bash: ${parts.join(', ')}]`
  return { toolName: 'bash', summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

function collapseWriteResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  const summary = `[collapsed ${toolName}: ${content.length} chars written]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseRunTestsResult(content: string, originalTokens: number): CollapsedResult {
  // run_tests formatOutput：与 RUN_TESTS_*_RE 共享（见 run-tests.ts）
  const passedMatch = content.match(RUN_TESTS_PASSED_RE)
  const failedMatch = content.match(RUN_TESTS_FAILED_RE)
  const exitMatch = content.match(RUN_TESTS_EXIT_CODE_RE)

  const passed = passedMatch ? parseInt(passedMatch[1]!, 10) : null
  const failed = failedMatch ? parseInt(failedMatch[1]!, 10) : null
  const exitCode = exitMatch?.[1] ?? null

  // Extract failed test names (match "✗ name", "FAIL name", or indented failure lines)
  const failureLines = content.split('\n')
    .filter(l => /^\s*[✗✘❌]|^\s*FAIL\s/i.test(l))
    .map(l => l.replace(/^\s*[✗✘❌]\s*/, '').replace(/^\s*FAIL\s+/i, '').trim().slice(0, 80))
    .filter(l => l.length > 0)
    .slice(0, 5)

  const parts: string[] = []
  if (passed !== null || failed !== null) {
    const total = (passed ?? 0) + (failed ?? 0)
    parts.push(`${passed ?? '?'}/${total} passed`)
  }
  if (failed !== null && failed > 0) parts.push(`${failed} failed`)
  if (exitCode !== null) parts.push(`exit ${exitCode}`)
  if (failureLines.length > 0) {
    parts.push(`failures: ${failureLines.join(', ')}`)
  }

  const summary = `[collapsed run_tests: ${parts.join(' · ')}]`
  return { toolName: 'run_tests', summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseDelegateResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  // delegate_task returns typically start with worker profile info
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? content.slice(0, 200)
  const profileMatch = firstLine.match(/(?:profile|worker)[:\s]*(\w+)/i)
  const profile = profileMatch?.[1] ?? 'worker'

  // Extract the first meaningful sentence as snippet
  const summaryMatch = content.match(/summary[:\s]+(.{20,150}?)(?:\.|$)/is)
  const snippet = (summaryMatch?.[1] ?? firstLine).trim().slice(0, 150)

  const summary = `[collapsed ${toolName}: ${profile} — ${snippet}${snippet.length >= 150 ? '…' : ''}]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}

export function collapseGenericResult(toolName: string, content: string, originalTokens: number): CollapsedResult {
  const lines = content.split('\n')
  const preview = lines.slice(0, 3).map(l => l.slice(0, 80)).join(' | ')
  const summary = `[collapsed ${toolName}: ${lines.length} lines, ${content.length} chars. Preview: ${preview}]`
  return { toolName, summary, originalTokens, collapsedTokens: Math.ceil(summary.length / CHARS_PER_TOKEN) }
}
