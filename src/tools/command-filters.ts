/**
 * Command-aware output filter. Returns filtered output, or null when no filter
 * matches the given command (caller falls back to original raw output).
 *
 * P1: Command-Aware filtering — applied in buildModelOutput and directly in
 * bash.ts for commands whose raw output is noisy but semantically simple.
 *
 * 纪律（git log/diff、test 三族沿用）：
 * - 小输出返回 null（无收益零风险）；
 * - 只删不编（除合成摘要/截断标记外不改写原文行），丢内容必留 [+N omitted] 标记；
 * - 模型只看过滤结果，原文始终经 rawPath/ArtifactStore 可恢复。
 * - 内容优先于 exit code：exit 0 但输出含失败签名（error TS / not ok / FAIL /
 *   N failed）时按失败处理——管道会洗白 exit code（incident 2026-07-19：
 *   `tsc --noEmit | head` 的 exit 是 head 的 0，filterTsc 曾因此输出
 *   "✓ typecheck passed" 吞掉 10 个真实错误）。
 * - 含管道的命令一律不过滤：exit code 不可信，原始输出比错误摘要安全。
 */
export function applyCommandFilter(
  command: string,
  stdout: string,
  exitCode: number,
): string | null {
  const cmd = command.trim()

  // 管道命令 exit code 是最后一环的，对 tsc/test 不可信——放行原始输出。
  if (cmd.includes('|')) return null

  // exit 0 但内容含失败签名 → 按失败处理（内容优先于 exit code）。
  const effectiveExit = exitCode === 0 && hasFailureSignature(stdout) ? 1 : exitCode

  // tsc --noEmit
  if (/\btsc\b/.test(cmd) && cmd.includes('--noEmit')) {
    return filterTsc(stdout, effectiveExit)
  }

  // node:test / tsx --test
  if (/\b(node|tsx|npx\s+tsx)\b/.test(cmd) && cmd.includes('--test')) {
    return filterNodeTest(stdout, effectiveExit)
  }

  // git status
  if (/^git\s+status\b/.test(cmd)) {
    return filterGitStatus(stdout)
  }

  // git log（-p/--patch 走 diff 过滤器）
  if (/^git\s+log\b/.test(cmd)) {
    return filterGitLog(cmd, stdout)
  }

  // git diff / git show
  if (/^git\s+(diff|show)\b/.test(cmd)) {
    return filterGitDiff(stdout)
  }

  // npm/pnpm/yarn/bun test、vitest/jest 直跑
  if (isTestRunCommand(cmd)) {
    return filterTestRun(stdout, effectiveExit)
  }

  return null
}

/** 失败签名：exit code 不可信时的内容判据。要求显式非零失败计数，
 *  "0 failed"/"fail 0" 不误判。 */
const FAILURE_SIGNATURE_RE =
  /\berror\s+TS\d+:|^not ok\b|\bAssertionError\b|^FAIL\s|^\s*[×✖✗]\s|\b[1-9]\d*\s+failed\b|ℹ\s*fail\s+[1-9]/m

function hasFailureSignature(stdout: string): boolean {
  return FAILURE_SIGNATURE_RE.test(stdout)
}

// ── shared helpers ─────────────────────────────────────────────

const SGR_RE = /\x1B\[[0-9;]*m/g

function stripSgr(text: string): string {
  return text.includes('\x1B') ? text.replace(SGR_RE, '') : text
}

function truncateLine(line: string, width: number): string {
  return line.length > width ? `${line.slice(0, width - 3)}...` : line
}

// ── tsc --noEmit ────────────────────────────────────────────────────────────

function filterTsc(stdout: string, exitCode: number): string {
  if (exitCode === 0) {
    // Keep the "Found 0 errors" summary line if present; otherwise synthesize
    const summary = stdout.match(/Found\s+0\s+errors?\.?/i)
    return summary ? summary[0] : '✓ typecheck passed'
  }

  return filterFailureOutput(stdout, line => line.trim() === 'Compiling...') ?? stdout.trim()
}

// ── node:test (tsx --test / node --test) ────────────────────────────────────

function filterNodeTest(stdout: string, exitCode: number): string {
  const lines = stdout.split('\n')

  if (exitCode === 0) {
    // Keep summary line(s) with passed/failed counts
    const summary = lines.filter(l => /\d+\s+passed/.test(l))
    return summary.length > 0 ? summary.join('\n') : stdout.trim()
  }

  return filterFailureOutput(stdout) ?? stdout.trim()
}

// ── git status ──────────────────────────────────────────────────────────────

function filterGitStatus(stdout: string): string {
  const lines = stdout.split('\n')
  const filtered = lines.filter(line => {
    const trimmed = line.trim()
    // Remove git hint lines: "(use \"git ...\")" or "(git ...)"
    if (/^\(use\s+"git\s/.test(trimmed)) return false
    if (/^\(git\s/.test(trimmed)) return false
    return true
  })
  return filtered.join('\n')
}

// ── git log ─────────────────────────────────────────────────────────────────
// 策略参照 rtk `filter_log_output`（git.rs:553）：自定义格式行宽截断；默认格式按
// commit 块压缩——保留 commit/Date 行 + 最多 3 行 message，剥 Author/空行/trailer，
// 上限 15 个 commit。≤30 行不过滤（返回 null）。

const GIT_LOG_MAX_COMMITS = 15
const GIT_LOG_LINE_WIDTH = 120

function filterGitLog(cmd: string, stdout: string): string | null {
  if (/(?:^|\s)-p\b|--patch/.test(cmd)) return filterGitDiff(stdout)
  const lines = stripSgr(stdout).split('\n')
  if (lines.length <= 30) return null

  const userFormat = /--oneline|--pretty|--format/.test(cmd) || !lines.some(l => l.startsWith('commit '))
  if (userFormat) {
    const shown = lines.slice(0, 40).map(l => truncateLine(l, GIT_LOG_LINE_WIDTH))
    const omitted = lines.length - shown.length
    if (omitted > 0) shown.push(`[+${omitted} commits omitted]`)
    return shown.join('\n')
  }

  const out: string[] = []
  let commits = 0
  let omittedCommits = 0
  let i = 0
  while (i < lines.length) {
    if (!lines[i]!.startsWith('commit ')) { i++; continue }
    if (commits >= GIT_LOG_MAX_COMMITS) { omittedCommits++; i++; continue }
    commits++
    out.push(lines[i]!)
    i++
    let messageKept = 0
    while (i < lines.length && !lines[i]!.startsWith('commit ')) {
      const raw = lines[i]!
      const t = raw.trim()
      i++
      if (t.startsWith('Date:')) { out.push(t); continue }
      if (t.startsWith('Author:')) continue
      if (t === '') continue
      if (t.startsWith('Signed-off-by:') || t.startsWith('Co-authored-by:')) continue
      if (messageKept < 3) {
        out.push(`    ${truncateLine(t, GIT_LOG_LINE_WIDTH)}`)
        messageKept++
      }
    }
  }
  if (omittedCommits > 0) out.push(`[+${omittedCommits} commits omitted]`)
  return out.join('\n')
}

// ── git diff / git show ─────────────────────────────────────────────────────
// 移植 rtk `compact_diff`（git.rs:333）：保留文件头（精简为文件名）+ @@ hunk 头
// + 变更行 + hunk 内上下文；剥 index/mode/similarity/`\ No newline` 行；每 hunk
// 上限 60 行截断；每文件尾附 +A -R 计数。≤40 行不过滤。

const DIFF_HUNK_MAX_LINES = 60
const DIFF_MAX_LINES = 300

function filterGitDiff(stdout: string): string | null {
  const lines = stripSgr(stdout).split('\n')
  if (lines.length <= 40) return null

  const out: string[] = []
  let currentFile = ''
  let added = 0
  let removed = 0
  let inHunk = false
  let hunkShown = 0
  let hunkSkipped = 0
  // git show 的 commit 头（commit/Author/Date/message）保留前 4 行
  let preambleKept = 0

  const flushFile = (): void => {
    if (hunkSkipped > 0) {
      out.push(`  ... (${hunkSkipped} lines truncated)`)
      hunkSkipped = 0
    }
    if (currentFile && (added > 0 || removed > 0)) {
      out.push(`  +${added} -${removed}`)
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      flushFile()
      currentFile = line.split(' b/').pop() ?? 'unknown'
      out.push(`\n${currentFile}`)
      added = 0
      removed = 0
      inHunk = false
      hunkShown = 0
      continue
    }
    if (line.startsWith('@@')) {
      if (hunkSkipped > 0) {
        out.push(`  ... (${hunkSkipped} lines truncated)`)
        hunkSkipped = 0
      }
      inHunk = true
      hunkShown = 0
      out.push(`  ${line}`)
      continue
    }
    if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++
        if (hunkShown < DIFF_HUNK_MAX_LINES) { out.push(`  ${line}`); hunkShown++ } else { hunkSkipped++ }
        continue
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        removed++
        if (hunkShown < DIFF_HUNK_MAX_LINES) { out.push(`  ${line}`); hunkShown++ } else { hunkSkipped++ }
        continue
      }
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      // 上下文行：hunk 内首条变更之前的纯上下文不保留（rtk 同款）
      if (hunkShown > 0 && hunkShown < DIFF_HUNK_MAX_LINES) { out.push(`  ${line}`); hunkShown++ }
      continue
    }
    // hunk 外：preamble（git show 的 commit 头 / --stat 块）只保留首个文件
    // 之前的 4 行非空行；文件头之后的 index/mode/---/+++ 行一律丢弃。
    if (!currentFile && preambleKept < 4 && line.trim() !== '') {
      out.push(line)
      preambleKept++
    }
    if (out.length >= DIFF_MAX_LINES) {
      out.push('\n... (more changes truncated)')
      return out.join('\n')
    }
  }
  flushFile()
  return out.join('\n')
}

// ── test runners（npm/pnpm/yarn/bun test、vitest/jest）───────────────────────
// 策略参照 rtk vitest/npm 过滤器：剥生命周期头/WARN/进度噪声；成功只留统计行；
// 失败只移除明确通过项；未知诊断保留，超长输出保留头尾与原文回查声明。
// ≤15 行不过滤。

const TEST_SUMMARY_RE = /Test Files|Test Suites|Tests\s+\d|Duration|^\s*ℹ\s+(tests|suites|pass|fail|skipped|todo)|\d+\s+passed|\d+\s+failed|Ran all test suites/
const TEST_PASS_LINE_RE = /^\s*(✓|✔|ok\b|PASS\b)/
const TEST_NOISE_RE = /^>\s+\S+@[\w.-]+\s+\S|^\s*npm\s+(WARN|notice)\b|^\s*pnpm\s+WARN\b/

function isTestRunCommand(cmd: string): boolean {
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?[\w:-]*test[\w:-]*(\s|$)/.test(cmd)) return true
  if (/^(npx|pnpm\s+exec|pnpm\s+dlx|bunx)\s+(vitest|jest)\b/.test(cmd)) return true
  return /^(vitest|jest)\b/.test(cmd)
}

function filterTestRun(stdout: string, exitCode: number): string | null {
  const rawLines = stripSgr(stdout).split('\n')
  if (rawLines.length <= 15) return null

  const lines = rawLines.filter(l => !TEST_NOISE_RE.test(l))

  if (exitCode === 0) {
    const summary = lines.filter(l => TEST_SUMMARY_RE.test(l))
    if (summary.length === 0) return lines.slice(-10).join('\n').trim() || null
    const passedMatch = summary.find(l => /(\d+)\s+passed/.test(l))?.match(/(\d+)\s+passed/)
      ?? summary.find(l => /ℹ\s+pass\s+(\d+)/.test(l))?.match(/ℹ\s+pass\s+(\d+)/)
    const head = passedMatch ? `✓ ${passedMatch[1]} passed` : '✓ tests passed'
    return [head, ...summary].join('\n')
  }

  return filterFailureOutput(stdout)
}

/** Unknown lines can explain a process failure even when every assertion passed. */
function filterFailureOutput(stdout: string, omittable = (line: string) => TEST_PASS_LINE_RE.test(line)): string | null {
  const rawLines = stripSgr(stdout).split('\n')
  const kept = rawLines.filter(line => !omittable(line))
  const omitted = rawLines.length - kept.length
  if (kept.every(line => !line.trim())) return null
  const hasDiagnostic = kept.some(line => line.trim() && !TEST_SUMMARY_RE.test(line) && !TEST_NOISE_RE.test(line))
  const MAX_KEPT = 120
  const preview = kept.length > MAX_KEPT
    ? [...kept.slice(0, 80), `[+${kept.length - MAX_KEPT} diagnostic lines omitted; raw output remains available]`, ...kept.slice(-40)]
    : kept
  return [...(!hasDiagnostic ? ['未取得可解释退出原因的诊断；请查询原始输出或已有执行回执。'] : []),
    ...preview, ...(omitted ? [`[${omitted} known progress/passing lines omitted]`] : [])].join('\n')
}
