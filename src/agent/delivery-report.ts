import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gitCommand } from '../tools/git-command.js'
import { GENERAL_DEV_DISCIPLINES, LARGE_FILE_WARN_THRESHOLD } from './review-discipline.js'
import { formatPatcherArtifacts, type ReviewOutcome } from './review-router.js'
import type { ScopedCommitReason } from './scoped-git-commit.js'
import { isUiFilePath, isVisualVerifyTool } from './hooks/render-verify-hook.js'

/** Format a review outcome into report lines. Shared by the synchronous path
 *  (explicit review_level → lines go into the tool result) and the detached
 *  path (system-triggered review → lines flow through the advisory queue). */
export function formatReviewOutcomeLines(outcome: ReviewOutcome): string[] {
  const lines: string[] = []
  if (outcome.verdict === 'rejected' || outcome.escalated) {
    // Advisory: the commit has already landed. Surface the finding
    // as a strong warning + follow-up recommendation, not a block.
    lines.push(`⚠️ 审查门发现问题 (${outcome.tier})：${outcome.evidence ?? '对抗性审查未验证此交付'}`)
    if (typeof outcome.rounds === 'number') lines.push(`   轮次：${outcome.rounds}`)
    lines.push('   → 提交已落地。请在后续提交中处理审查发现。')
    lines.push('   ⚠ 以上审查意见来自 worker，未经主控独立核验。汇报用户前请用 grep/read 确认每条声称的文件:行号真实存在。')
  } else if (outcome.verdict === 'verified') {
    if (outcome.infraFailures && outcome.infraFailures.length > 0) {
      lines.push(`⚠️ 审查门 YELLOW (${outcome.tier})：审查基础设施有注意事项，交付已通过可用证据验证。`)
      lines.push(`   ${outcome.evidence ?? '已通过审查基础设施注意事项验证'}`)
    } else {
      lines.push(`✅ 审查通过 (${outcome.tier})：${outcome.evidence ?? '已验证'}`)
    }
  } else if (outcome.verdict === 'inconclusive') {
    lines.push(`⚠️ 审查未决 (${outcome.tier})：${outcome.evidence ?? '提交后审查未运行（基础设施故障）'}`)
    lines.push('   → 此变更未经审查。运行 /review max 进行完整编队审查。')
  } else if (outcome.verdict === 'nudge') {
    lines.push(`⚠️ 审查提醒 (${outcome.tier})：请在后续工作中应用审查纪律。`)
    lines.push('通用开发方法论：')
    for (const directive of GENERAL_DEV_DISCIPLINES) lines.push(`  - ${directive}`)
  }
  lines.push(...formatPatcherArtifacts(outcome.patcherArtifacts))
  return lines
}

function parseNulFileList(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

/**
 * advisory 检查失败必须可见。
 *
 * 空 catch 会让「检查通过」与「检查自己坏了」在报告里长得一模一样——本仓库
 * 记录在案的最贵 bug 形状（走通和走不通，观察者区分不了）。这里只输出一行、
 * 绝不阻断交付；但一行也必须输出，否则下次没人知道那段检查其实没跑。
 */
export function advisoryFailure(label: string, error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
  return `⚠️ ${label}不可用，已跳过（${detail.slice(0, 120)}）`
}

/**
 * `commitScopedFiles` 的 reason → deliver_task 的阻断标签。
 *
 * 拆开是为了让 `deliveryNextAction` 给出对应下一步：HEAD 变了要重建候选，
 * 基准读不出则重试无效（issue #537）。未命中一律落到 git-commit-failed，
 * 保持保守兜底——新路径忘了设 reason 也不会被误报成「HEAD 变了」。
 */
export function mapCommitFailureReason(reason: ScopedCommitReason | undefined, indexOnlyConflict: boolean | null): string {
  if (indexOnlyConflict) return 'git-index-changed'
  switch (reason) {
    case 'head-changed':
    case 'retry-head-changed':
    case 'staging-head-changed':
      return 'git-head-changed'
    case 'index-changed':
      return 'git-index-changed'
    case 'files-changed':
    case 'retry-files-changed':
    case 'staging-files-changed':
      return 'git-files-changed'
    case 'version-unavailable':
      return 'git-baseline-unavailable'
    default:
      return 'git-commit-failed'
  }
}

export function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
}

/** Collect files exceeding the large-file threshold so review workers can avoid
 *  reading them in full (use offset/limit instead). Best-effort — stat failures
 *  are silently skipped. */
export function collectLargeFiles(cwd: string, filePaths: readonly string[]): Array<{ path: string; sizeBytes: number }> | undefined {
  const large: Array<{ path: string; sizeBytes: number }> = []
  for (const p of filePaths) {
    try {
      const st = statSync(join(cwd, p))
      if (st.size >= LARGE_FILE_WARN_THRESHOLD) {
        large.push({ path: p, sizeBytes: st.size })
      }
    } catch { /* best-effort: missing / broken symlink / permission denied → skip */ }
  }
  return large.length > 0 ? large : undefined
}

async function gitNameList(cwd: string, args: string[]): Promise<string[] | null> {
  const result = await gitCommand(cwd, ['-c', 'core.quotePath=false', ...args], { timeoutMs: 5000 })
  if (result.status !== 0) return null
  return parseNulFileList(result.stdout)
}

/**
 * Detect a "symptom-patch": a tiny single-file change touching only fallback
 * operators (`??` `||` default values). These are the shape of the trained-mode
 * reflex — patch the last hop, not the root. Returns a stance hint, or null.
 */
export async function detectSymptomPatch(cwd: string): Promise<string | null> {
  const res = await gitCommand(cwd, ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'], { timeoutMs: 5000 })
  if (res.status !== 0) return null
  const rows = res.stdout.split(/\r?\n/).filter(Boolean)
    .map(l => l.split('\t'))
    .filter(c => c.length === 3 && !(c[2] ?? '').includes('test'))
  if (rows.length !== 1) return null
  const row = rows[0]!
  const added = Number(row[0]) || 0
  if (added > 2) return null
  const patch = await gitCommand(cwd, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', row[2]!], { timeoutMs: 5000 })
  if (patch.status !== 0) return null
  const addedLines = patch.stdout.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const fallbackOnly = addedLines.length > 0 && addedLines.every(l => /\?\?|\|\||=\s*['"`]?\w*['"`]?\s*$|fallback|default/.test(l))
  if (!fallbackOnly) return null
  return '⚖️  这是症状处的 fallback 补丁(单行、改默认值)。是源头修复还是就近打补丁？数据流追到源头了吗？(清醒锚点，不阻塞)'
}

export async function collectCurrentDirtyFiles(cwd: string): Promise<string[] | undefined> {
  const unstaged = await gitNameList(cwd, ['diff', '--name-only', '-z'])
  const staged = await gitNameList(cwd, ['diff', '--cached', '--name-only', '-z'])
  const untracked = await gitNameList(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!unstaged || !staged || !untracked) return undefined

  const files = new Set<string>()
  for (const file of [...unstaged, ...staged, ...untracked]) {
    files.add(file)
  }
  return [...files].sort()
}

/**
 * W5 (render-verify): check whether the delivery includes UI file changes
 * without any visual verification action (browser/computer_use/browser_debug).
 * Returns a warning line, or null if no issue.
 */
export function detectMissingVisualVerify(
  ownedFiles: readonly string[],
  getEvents?: () => ReadonlyArray<import('./task-ledger.js').TaskLedgerEvent>,
): string | null {
  const uiFiles = ownedFiles.filter(f => isUiFilePath(f))
  if (uiFiles.length === 0) return null

  const events = getEvents?.() ?? []
  const hasVisualVerify = events.some(
    e => e.type === 'tool_exec' && e.tool && isVisualVerifyTool(e.tool),
  )
  if (hasVisualVerify) return null

  return `⚠️ 渲染未验证：UI 文件已修改（${uiFiles.slice(0, 2).join(', ')}${uiFiles.length > 2 ? ' 等' : ''}），但未见 browser_debug/computer_use 视觉验证。交付前用 browser_debug open → navigate → screenshot 检查渲染结果。`
}

// ── 虚空仓库 P0：learned 参数解析 ──────────────────────────────────────────

export interface LearnedPattern {
  text: string
  evidence: string
  tags: string[]
  topic?: string
}

/** 解析 deliver_task `learned` 数组。约定格式："模式描述——证据：文件路径或复现步骤"。
 *  分隔符容忍 "——证据："/"--证据:" 等变体；缺分隔符时整条入 text、evidence 为空。
 *  topic 从 evidence 里提取第一个带扩展名的路径样 token（供召回结构化预过滤）。 */
export function parseLearnedEntries(raw: unknown): LearnedPattern[] {
  if (!Array.isArray(raw)) return []
  const out: LearnedPattern[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const sep = trimmed.match(/[—–-]{1,2}\s*证据\s*[:：]/)
    let text = trimmed
    let evidence = ''
    if (sep && sep.index !== undefined) {
      text = trimmed.slice(0, sep.index).trim()
      evidence = trimmed.slice(sep.index + sep[0].length).trim()
    }
    if (!text) continue
    const pathLike = evidence.match(/[\w@./-]+\.[A-Za-z]{1,8}\b/)
    out.push({
      text,
      evidence,
      tags: ['agent-learned'],
      topic: pathLike?.[0],
    })
  }
  return out
}

