/**
 * deliver_task — 语义化交付工具 (B1-8)
 *
 * 从低层 git commit 升级到语义化工程交付原语。
 *
 * 契约分离（2026-10-25「提交、审查、测试彻底分离」）：本工具收敛为纯安全提交——
 * 只做文件归属、范围校验与 Git 安全保护，然后提交。它不再执行验证（run_tests
 * 独立）、不再触发审查（review_changes 独立）、不再物化候选快照或影响分析。
 * 成功回执明确「本次未执行测试或审查」——提交保存工作成果，质量义务由独立入口表达。
 *
 * 行为：
 * - 读取 TaskLedger + OwnershipLedger + DeliveryGate v2（台账状态仅用于披露）
 * - commit=true 且 approval 通过时执行 ownership-scoped commit
 * - 保留：归属/adopt/force 范围覆盖、半暂存/版本一致/index 锁/敏感路径保护、
 *   真实 SHA 回执、内聚性提示、恢复日志、跨会话 claim 冲突
 *
 * @module deliver-task
 * @task B1-8
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import { captureCommitVersionAsync } from './commit-version-async.js'
import { recordRuntimeDiagnostic } from '../utils/runtime-diagnostics.js'
import { gitCommand } from '../tools/git-command.js'
import { deliveryCandidateScope } from './delivery-candidate-scope.js'
import { createDeliveryNoProgressTracker, deliveryNextAction } from './delivery-no-progress.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import { debugLog } from '../utils/debug.js'

/**
 * 阶段时间戳标记（commit 卡死诊断插桩，主控可靠性闭环 2026-08-06）。
 * 返回 (stage) => void：有界记录阶段与相对耗时，并保留 debug 输出。
 * 下次 deliver_task commit=true 卡死时，
 * 日志里最后一个 stage 就是卡点：在 execute 内（缺 execute:return）或
 * execute 已返回但工具未完成（全标记齐全 = harness 结果回传层卡死）。
 */
export function createStageMarker(prefix: string, correlationId?: string, sessionId?: string): (stage: string) => void {
  const t0 = Date.now()
  return (stage: string): void => {
    recordRuntimeDiagnostic({ kind: 'delivery_stage', phase: stage, correlationId, sessionId, elapsedMs: Date.now() - t0 })
    debugLog(`[${prefix}] ${stage} +${Date.now() - t0}ms`)
  }
}

import { filterExternalNoise, type DeliveryGateV2 } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
import { checkCommitCohesion } from './commit-cohesion.js'
import { recordDeliveryReceipt } from './delivery-receipt.js'
import { readUnacknowledged, acknowledgeAll, type RecoveryEntry } from './recovery-journal.js'
import { collectCurrentDirtyFiles, parseLearnedEntries } from './delivery-report.js'
export { formatReviewOutcomeLines, detectSymptomPatch, collectCurrentDirtyFiles, detectMissingVisualVerify, parseLearnedEntries, type LearnedPattern } from './delivery-report.js'

export interface B1Context {
  continuityStatus?: string
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  gate: DeliveryGateV2
  /** Optional SessionRegistry for cross-session claim conflict detection */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management */
  sessionId?: string
  /** Test hook / alternate runtime source for current dirty files. */
  getCurrentDirtyFiles?: (cwd: string) => string[] | undefined
  /** 提交硬门恢复路径（会话中途 git init）：基线只在会话启动时采集一次；基线
   *  不完整时由硬门现场重采，仓库现在可用则原地换基线并返回 true。缺省 → 无
   *  恢复路径（保持硬阻断，现状行为不变）。 */
  recaptureBaseline?: (cwd: string) => boolean
  /** Test hook / alternate runtime executor for scoped commits. */
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => ScopedCommitResult | Promise<ScopedCommitResult>
  /** config agent.delivery.autoCommit。false 时即使 commit=true 也不实际
   *  执行 git commit，仅输出交付报告。 */
  autoCommit?: boolean
}

/** 被动风险提示（契约分离 Wave 2）：仅依据本次 diff 的既有事实，纯函数无 IO。
 *  最多 3 项、总长 ≤600 字符；纯注释/格式变化不提示；未评估不冒充确定。
 *  不扫描全仓、不查询影响图、不加载编译器、不启动 worker。 */
export function passivelyAssessRisk(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined
  const hints: string[] = []
  const add = (line: string): void => {
    const candidate = ['⚠️ 风险提示（仅基于本次 diff；独立审查可用 review_changes）：', ...hints, line].join('\n')
    if (candidate.length <= 600) hints.push(line)
  }
  for (const f of files) {
    if (f === 'package.json' || f === 'package-lock.json' || f === 'pnpm-lock.yaml') {
      add(`- ${f}：依赖/脚本变化——注意协议兼容与安装路径`)
    } else if (/\/migration|\/schema|\.sql$/.test(f)) {
      add(`- ${f}：数据迁移/结构面——注意可回滚与存量数据`)
    } else if (/(^|\/)(permission|auth|security|sandbox|guardrail|firewall)/i.test(f)) {
      add(`- ${f}：权限/安全边界——注意 fail-closed 与授权边界`)
    } else if (/^\.rivet-config\.json$|^tsconfig.*\.json$|\/\.rivet-config\.json$/.test(f)) {
      add(`- ${f}：配置结构——注意旧配置读取兼容`)
    }
    if (hints.length >= 3) break
  }
  return hints.length > 0 ? ['⚠️ 风险提示（仅基于本次 diff；独立审查可用 review_changes）：', ...hints].join('\n') : undefined
}

/** 提示用文件集：commit 用实际提交范围，只读用报告范围。 */
function filesToCommitForHint(reportDirty: string[] | undefined, commit: boolean, scope: readonly string[]): readonly string[] {
  if (commit) return scope
  return reportDirty ?? []
}

/** 旧混合参数 → 精简迁移错误。在归属校验、台账读取、commit 之前返回，
 *  不启动任何质量任务，不把它解释为验证失败后重试。 */
const LEGACY_FIELD_ROUTES: Record<string, string> = {
  verification_policy: '验证策略已随提交义务一并移除；开发中定向验证直接用 run_tests(files/filter)',
  review_level: '审查深度参数已移除；用 review_changes(action="start", depth=...) 或 TUI /review',
  review_policy: '提交后审查分批已移除；审查由 review_changes 独立承接',
  skipAutoReview: '自动审查开关已移除；审查由 review_changes 独立承接，提交路径不再触发任何审查',
  review_findings: '审查发现处理已移交 review_changes(action="list"/"update")',
  checklist: '任务完成度清单参数已移除；在最终回复中自行披露完成/未完成项，验证用 run_tests 表达',
  learned: '知识收割参数已移除；用 memory 工具的 remember 直接持久化',
}

export function createDeliverTaskTool(getB1Context: (params?: ToolCallParams) => B1Context): Tool {
  const noProgress = createDeliveryNoProgressTracker()
  return {
    definition: {
      name: 'deliver_task',
      description: `基于 B1 归属台账检查任务交付就绪度，并执行归属范围的安全提交。

### 用法
- 用 deliver_task 检查当前任务是否可交付（只读报告：归属文件、外部文件、台账验证状态）
- commit=true 时执行归属范围限定提交：只受所有权、跨会话冲突、版本一致性检查约束
- 提交与验证、审查彻底分离：提交成功不代表验证通过——回执明确「本次未执行测试或审查」
- 开发中的定向验证用 run_tests(files/filter)；独立审查用 review_changes 或 /review
- 验证缺口（零验证/失败/超时/过期）如实披露，不阻断安全提交，也不为取得提交许可扩大测试

### 参数
- commit: 设为 true 以请求限定范围提交的审批（默认：false，只读报告）
- message: 提交信息（commit=true 时必填）
- files: 可选，本次交付候选的已归属文件路径数组（子集）。省略时使用当前全部已归属 dirty 文件。
- adopt: 提交前要认领归属的外部或共同归属文件路径数组。用于接管崩溃/冻结会话的工作。要求 commit=true。
- force: 已独立核实跨会话接管安全时显式覆盖 claim 冲突；不豁免路径、索引、半暂存或版本安全。`,
      input_schema: {
        type: 'object',
        properties: {
          commit: { type: 'boolean', description: '请求对已归属文件做限定范围的提交' },
          message: { type: 'string', description: '提交信息（commit=true 时必填）' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '可选，已归属文件子集，报告和提交使用该范围。省略时使用当前全部已归属 dirty 文件。',
          },
          adopt: {
            type: 'array',
            items: { type: 'string' },
            description: '提交前认领进已归属集合的外部文件路径。用于另一会话崩溃后的跨会话接管。要求 commit=true。',
          },
          force: {
            type: 'boolean',
            description: '仅在独立核实接管安全后覆盖跨会话 claim 冲突；不豁免 Git 安全保护。',
          },
        },
        required: [],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const mark = createStageMarker('deliver-task', params.toolUseId, params.sessionId)
      mark('execute:start')
      const ctx = getB1Context(params)
      // ── 旧混合参数无副作用退回（契约分离）：在任何台账/归属/提交副作用之前 ──
      for (const field of Object.keys(LEGACY_FIELD_ROUTES)) {
        if (params.input[field] !== undefined) {
          return {
            content: `❌ deliver_task 不再接受 "${field}"：${LEGACY_FIELD_ROUTES[field]}。本次调用未产生任何副作用（未读取台账、未提交）；请拆分为独立调用。`,
            isError: true,
            errorKind: 'format_error',
          }
        }
      }
      ctx.ownership.autoOwnFromLedger()
      const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? await collectCurrentDirtyFiles(params.cwd)
      if (currentDirtyFiles) ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
      const commit = params.input.commit === true
      const requestedFiles = params.input.files as string[] | undefined
      const adoptFiles = commit && ctx.autoCommit !== false ? params.input.adopt as string[] | undefined : undefined
      const dirtySet = currentDirtyFiles ? new Set(currentDirtyFiles) : undefined
      if (requestedFiles !== undefined && (!Array.isArray(requestedFiles) || requestedFiles.length === 0)) {
        return { content: '❌ No files specified for commit. Provide non-empty files array or omit to use all owned files.', isError: true, errorKind: 'format_error' }
      }
      const adoptableExternal = new Set(ctx.ownership.getExternalFiles(currentDirtyFiles).filter(file => !dirtySet || dirtySet.has(file)))
      const adoptableCoOwned = new Set(ctx.ownership.getCoOwnedFiles().filter(file => !dirtySet || dirtySet.has(file)))
      if (adoptFiles?.length) {
        if (!dirtySet) return { content: '❌ Adopt: cannot confirm which files are dirty; retry after Git status is available.', isError: true, errorKind: 'delivery_gate' }
        const notAdoptable = adoptFiles.filter(file => (!adoptableExternal.has(file) && !adoptableCoOwned.has(file) && !ctx.ownership.isOwned(file)) || dirtySet?.has(file) !== true)
        if (notAdoptable.length > 0) {
          return { content: `❌ Adopt: file(s) not in external or co-owned files: ${notAdoptable.join(', ')}. Only dirty external and co-owned files can be adopted.`, isError: true, errorKind: 'delivery_gate' }
        }
      }
      const ownedSet = new Set(ctx.ownership.getOwnedFiles())
      if (requestedFiles) {
        const notOwned = requestedFiles.filter(file => !ownedSet.has(file) && !adoptFiles?.includes(file))
        if (notOwned.length > 0) {
          return { content: `❌ File(s) not in owned files: ${notOwned.join(', ')}. Cannot deliver non-owned files.`, isError: true, errorKind: 'delivery_gate' }
        }
        const notDirty = requestedFiles.filter(file => dirtySet && !dirtySet.has(file))
        if (notDirty.length > 0) {
          return { content: `❌ File(s) are not currently dirty: ${notDirty.join(', ')}. Cannot deliver clean files.`, isError: true, errorKind: 'delivery_gate' }
        }
      }
      // A takeover is part of this delivery candidate even when `files` names
      // only the previously owned subset. Validate before changing ownership.
      const scopeFiles = deliveryCandidateScope(requestedFiles, adoptFiles, ctx.ownership.getOwnedFiles(), currentDirtyFiles)
      if (commit && scopeFiles.length === 0) return { content: '❌ No dirty files in the delivery candidate.', isError: true, errorKind: 'delivery_gate' }
      const adopted = adoptFiles?.length ? ctx.ownership.adoptFiles(adoptFiles) : []
      const reportDirtyFiles = requestedFiles || commit ? scopeFiles : currentDirtyFiles

      // ── 只读报告（台账状态仅用于披露，不驱动任何门禁）──
      const rawVerifications = ctx.taskLedger.getVerifications()
      const report = ctx.gate.getReport([], reportDirtyFiles, undefined, undefined, false)
      mark('report:done')

      // Cap file lists and filter external noise to keep the signal readable.
      const FILE_LIST_CAP = 5
      const renderFileList = (files: string[], extraHiddenCount = 0): string[] => {
        if (files.length === 0 && extraHiddenCount === 0) return ['  (none)']
        const shown = files.slice(0, FILE_LIST_CAP).map(f => `  ${f}`)
        const hidden = files.length - Math.min(files.length, FILE_LIST_CAP) + extraHiddenCount
        if (hidden > 0) shown.push(`  (+${hidden} more${extraHiddenCount > 0 ? `, ${extraHiddenCount} junk/gitignored` : ''})`)
        return shown
      }
      const externalSplit = filterExternalNoise(report.externalFiles, params.cwd)
      const lines: string[] = [
        `Ledger verification: ${report.state}（台账状态披露，本次交付不执行验证）`,
        `Task: ${report.taskId}`,
        '',
        `Owned files (${report.ownedFileCount}):`,
        ...renderFileList(report.ownedFiles),
        '',
        `Co-owned files (${report.coOwnedFileCount}):`,
        ...renderFileList(report.coOwnedFiles),
        '',
        `Historical owned files (${report.historicalOwnedFileCount}):`,
        ...renderFileList(report.historicalOwnedFiles),
        '',
        `External files (${report.externalFileCount}):`,
        ...renderFileList(externalSplit.files, externalSplit.noiseCount),
        '',
        report.verificationCount > 0
          ? `Verifications: ${report.verificationCount}（台账记录，未经本次提交复核）`
          : 'Verifications: none (no tests were run for this task)',
      ]
      const blockedCommit = (reason: string, errorKind: 'delivery_gate' | 'format_error' = 'delivery_gate'): ToolResult => noProgress.rejected(report.taskId, undefined, reason,
        rawVerifications, deliveryNextAction(reason, undefined),
        { content: lines.join('\n'), isError: true, errorKind })
      if (ctx.continuityStatus) lines.push(`Session evidence continuity: ${ctx.continuityStatus}${ctx.continuityStatus === 'baseline_missing' ? '（启动时无历史任务状态，与当前验证结果分开）' : ''}`)

      // Echo producer facts; incomplete counts must remain visibly incomplete.
      if (report.latestVerificationTotals) {
        const v = report.latestVerificationTotals
        lines.push(`  Latest: ${v.passed ?? '未确认'} pass ${v.countsReliable !== true && !v.failed ? '未确认' : v.failed ?? '未确认'} fail ${v.skipped ?? '未确认'} skip${v.countsReliable !== true ? '（已确认计数，非全量；失败数量未确认时须补证据）' : ''} — ${v.command}`)
        if (v.executionId) lines.push(`  Execution: ${v.executionId} · ${v.timestamp ? new Date(v.timestamp).toISOString() : '时间未确认'} · ${v.durationMs ?? '未确认'}ms`)
      }

      const health = summarizeOwnershipHealth({
        ownedFiles: report.ownedFiles,
        coOwnedFiles: report.coOwnedFiles,
        externalFiles: report.externalFiles,
        dirtyFiles: reportDirtyFiles ?? [...report.ownedFiles, ...report.coOwnedFiles, ...report.externalFiles],
      })
      if (health.warningLines.length > 0) {
        lines.push('', 'Ownership health warnings:')
        lines.push(...health.warningLines.map(line => `  ${line}`))
      }
      // B1 pending-adopt 显式清单：无归属分类的 dirty 文件（多为 worker 写入或
      // 他会话半成品）——明确列出并给认领路径，替代静默 unclassified 导致的
      // 交付遗漏（worker 文件需事后 adopt 补交）。
      if (health.pendingAdopt.length > 0) {
        lines.push('', '⚠️  Pending adopt（无归属分类的 dirty 文件——可能是 worker 写入或他会话半成品）：')
        lines.push(...health.pendingAdopt.map(f => `  - ${f}`))
        lines.push('  认领方式：deliver_task commit=true adopt=[...]（确认属于本任务）；不属于则忽略（外部文件不进提交范围）。')
      }
      if (health.infoLines.length > 0) {
        lines.push('', 'Ownership caveats:')
        lines.push(...health.infoLines.map(line => `  ${line}`))
      }
      if (report.blockingReason) {
        lines.push('', `⚠️  台账验证待办（不阻断提交，交付报告须披露）: ${report.blockingReason}`)
      }

      // P2 cross-session signal: detect claim conflicts with other sessions
      const claimConflicts: Array<{ file: string; holder: string; claimType: string }> = []
      if (ctx.sessionRegistry && ctx.sessionId && report.ownedFiles.length > 0) {
        for (const f of report.ownedFiles) {
          const claim = ctx.sessionRegistry.checkClaim(f, ctx.sessionId)
          if (claim && claim.sessionId !== ctx.sessionId) {
            claimConflicts.push({ file: f, holder: claim.sessionId, claimType: claim.claimType })
          }
        }
        if (claimConflicts.length > 0) {
          lines.push('', '⚠️  Cross-session claim conflicts:')
          for (const c of claimConflicts) {
            const claimKind = c.claimType === 'exclusive' ? 'exclusive lock' : 'shared read'
            lines.push(`  ${c.file} — ${claimKind} held by session ${c.holder}`)
          }
          lines.push('', '  (Continue only if you have verified this conflict is safe to override.)')
        }
      }

      lines.push('', `Attribution: ${report.attributionSummary}`)
      if (report.currentBlockingFailure) {
        lines.push('', `验证遗留项（不阻断提交，须披露）: ${report.currentBlockingFailure}`)
        lines.push('→ 根据实际证据处理；没有基线对照，不能认定失败由本次改动引入或属于预存量。')
      }

      // Recovery journal: detect files that were restored (undo/git checkout) during this session.
      // A clean file after restore may hide unfinished intent — surface it explicitly.
      const recoverySessionId = ctx.sessionId ?? params.sessionId
      const recoveries = readUnacknowledged(params.cwd, recoverySessionId)
      if (recoveries.length > 0) {
        lines.push('', '--- Recovery Journal ---')
        lines.push('  Files restored during this session (edit failure → restore):')
        for (const r of recoveries) {
          lines.push(`  ⚠️  ${r.file} (${r.action}, ~${r.linesLost} lines lost at ${r.ts.slice(11, 19)})`)
        }
        lines.push('', '  ⚠️  Verify no intended changes were lost in these recoveries.')
        lines.push('  If all recovered changes have been re-applied, this warning will clear on next deliver_task.')
      }

      const message = params.input.message as string | undefined

      if (commit) {
        // Manual commit mode — user wants to review before committing.
        // Still run the full gate report, just skip the actual git commit.
        if (ctx.autoCommit === false) {
          lines.push(
            '',
            '🛑 自动提交已关闭（agent.delivery.autoCommit = false）。',
            '以上交付报告与门禁状态仅供参考——变更未提交。',
            '审查完成后由用户手动执行 git commit。',
          )
          return { content: lines.join('\n') }
        }
        if (!ctx.ownership.isBaselineComplete()) {
          // 恢复路径：基线只在会话启动时采集一次——会话开始后目录才变成 git 仓库
          // （新项目脚手架 git init）时基线仍停留在启动时的 incomplete，现场重采
          // 一次，仓库现在可用即原地换基线放行。只解决这一类；重采仍失败（非 git
          // 工作区）→「无法归因不许提交」的默认不变，硬门不撤。
          if (ctx.recaptureBaseline?.(params.cwd) === true) {
            lines.push('', '✅ 归属基线已现场重采（会话启动后目录才成为 git 仓库），按新基线继续。')
          } else {
            lines.push('', '❌ Cannot commit: 归属基线未完整建立，无法安全执行 scoped commit。')
            lines.push('文件改动已保存在工作区中。git 仓库可用后重试 deliver_task 会现场重采基线（如刚执行 git init，直接重试即可）；force 不豁免。')
            return blockedCommit('baseline-incomplete')
          }
        }
        // Keep the atomic commit reminder at the commit boundary.
        lines.push(
          '',
          '<atomic-commit-reminder>',
          '提交前只确认本次一个逻辑单元：',
          '1. 是否只包含当前任务文件？',
          '2. 是否混入外部/他人改动？',
          '3. 提交范围是否与用户要求一致？',
          '4. commit message 是否描述一个原子变更？',
          '</atomic-commit-reminder>',
        )

        const forceGate = params.input.force === true

        if (!message) {
          lines.push('', '❌ Commit requires a "message" parameter.')
          return blockedCommit('missing-commit-message', 'format_error')
        }

        if (adopted.length > 0) {
          const wasCoOwned = adopted.filter(file => adoptableCoOwned.has(file))
          const wasExternal = adopted.filter(file => adoptableExternal.has(file))
          if (wasCoOwned.length > 0) lines.push('', `🔓 Adopted ${wasCoOwned.length} co-owned file(s) into exclusive ownership:`)
          if (wasExternal.length > 0) lines.push('', `🔓 Adopted ${wasExternal.length} external file(s) into owned set:`)
          for (const file of adopted) lines.push(`   ${file}`)
          if (wasCoOwned.length > 0) lines.push('', '  ⚠️ These files were shared with another session. Verify the other session has finished before committing.')
          if (wasExternal.length > 0) lines.push('', '  ⚠️ These files were modified by another session. Verify the changes are correct before committing.')
        }

        const filesToCommit = scopeFiles
        const commitVersion = await captureCommitVersionAsync(params.cwd, filesToCommit, { signal: params.abortSignal })
        lines.push('', `Commit scope (${report.state}): ${filesToCommit.join(', ') || '(none)'}`)
        const commitConflictFiles = new Set(filesToCommit)
        const blockingClaimConflicts = claimConflicts.filter(conflict => commitConflictFiles.has(conflict.file))
        if (blockingClaimConflicts.length > 0 && !forceGate) {
          lines.push('', '❌ Cannot commit: cross-session claim conflicts are present.')
          lines.push('   → Resolve the other session claim or use force=true only after independently verifying the override is safe.')
          return blockedCommit('cross-session-claim')
        }
        if (blockingClaimConflicts.length > 0 && forceGate) {
          lines.push('', '⚠️ Cross-session claim conflicts overridden with force=true. Verify the other session has finished or approved the takeover.')
        }

        const cohesion = checkCommitCohesion(filesToCommit)
        if (cohesion.needsWarning) lines.push('', 'ℹ️ 本次提交涉及多个文件或区域；建议按逻辑单元审查，文件数量不阻断安全提交。')

        // ── COMMIT ─────────────────────────────────────────────────────────
        // 提交与审查/验证彻底分离：commit 就是 commit——落地工作成果。
        // 验证走 run_tests，审查走 review_changes，都不在本路径。

        // A lock's age cannot prove that its owner has exited.
        const lockPath = join(params.cwd, '.git', 'index.lock')
        if (existsSync(lockPath)) {
          lines.push('', '  ⚠️  Git index is locked; its owner has not been verified.')
          lines.push('     Wait for the owning Git process to finish and retry; the lock was preserved. 当前候选的源码验证仍可用。')
          return blockedCommit('git-index-lock')
        }

        mark('commit:before')

        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg, expectedVersion: commitVersion ?? undefined, signal: params.abortSignal }))
        const commitResult = await executor(params.cwd, filesToCommit, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          if (commitResult.reason === 'version-unavailable' && commitResult.detail) {
            lines.push(`   Baseline diagnostics: ${commitResult.detail}`)
          }
          return blockedCommit('scoped-commit-failed')
        }
        noProgress.clear(report.taskId)
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${filesToCommit.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
        lines.push('', 'ℹ️ 本次未执行测试或审查——提交只保存工作成果；质量义务由 run_tests / review_changes 独立表达。')
        const sha = commitResult.commitSha
        if (sha) {
          lines.push(`   VERIFIED: 本次提交 ${sha}。The commit is real — do NOT re-attempt it.`)
          ctx.taskLedger.record({ type: 'git_action', command: 'deliver_task commit', meta: { commitSha: sha } })
          if (recoverySessionId) {
            try { recordDeliveryReceipt(params.cwd, recoverySessionId, sha) }
            catch (error) { lines.push(`⚠️ 提交已完成，归属回执未持久化：${String(error)}；不要重复提交。`) }
          }
        } else lines.push('⚠️ 提交命令已成功，但未取到本次 SHA；先核对命令输出，不要用当前 HEAD 代替或重复提交。')
        mark('commit:after')
        const readback = sha ? await gitCommand(params.cwd, ['-c', 'core.quotePath=false', 'show', '--stat', '--format=%H', sha], { signal: params.abortSignal }) : { status: -1, stdout: '' }
        if (readback.status === 0 && readback.stdout.trim()) {
          lines.push('', '--- actual changes (git show --stat) ---')
          lines.push(readback.stdout.trim())
        }
        // Acknowledge recovery journal entries — the commit confirms intent was preserved.
        if (recoveries.length > 0) acknowledgeAll(params.cwd, recoverySessionId)
      }

      // ── 被动风险提示（轻量：仅本次 diff 的既有事实，≤3 项/600 字符，不扫全仓/不动影响图）──
      // 触及权限边界/协议兼容/配置结构/数据迁移面的改动值得点名；同一 diff 不重复。
      try {
        const riskHints = passivelyAssessRisk(filesToCommitForHint(reportDirtyFiles, commit, scopeFiles))
        if (riskHints) lines.push('', riskHints)
      } catch { /* 提示绝不让交付失败 */ }

      // ── 交付后自检（硬性，不替代人工审查，但减少静默带偏）─────────────
      // 每次交付结束时提醒 agent 核验两件事：① 提交的文件是否就是本次要交的
      // （避免 --all 事故）；② 工作区是否有不该出现的未跟踪文件（可能是
      // 上一步操作意外写入的临时文件/缓存/构件产物）。
      lines.push('',
        '交付后自检（提交后 10 秒内看一眼）：',
        '  1. 刚才的提交文件列表是否符合「本次改动的文件」——发现陌生文件先核对归属并报告，不自动还原他会话改动',
        '  2. 项目目录下有没有不该出现的新文件（git status 里的 ?? 行）——先确认归属与用途，不自动清理他会话文件',
      )

      return { content: lines.join('\n') }
    },

    requiresApproval(params: ToolCallParams): boolean {
      return params.input.commit === true
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,

    // Default commits perform local reporting + scoped Git operations. Full
    // checks / strict commits retain candidate analysis; reviews run detached.
    //
    // commit 预算 60s→180s（2026-07-21 事故）：多会话共享工作区（几十个外部
    // 改动文件）+ 并发 tsc/test 满载 CPU 时，所有权扫描 + claim 审计 + git
    // 操作 60s 跑不完 → 超时重试全灭 → 模型退回裸 git 提交 → 把并发会话的
    // 半成品 tracked 改动卷进提交、漏掉 untracked 依赖文件（损毁提交
    // 7b0c2936）。提交是终态动作，宁可慢不可断。
    timeoutMs: (params) => {
      if (params?.input?.commit !== true) return 60_000    // 门禁查询：ownership + cohesion
      return 180_000                                       // commit：文件读写 + git 操作（满载机器留余量）
    },
  }
}
