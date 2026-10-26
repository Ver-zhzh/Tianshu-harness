import { verificationLifecycle } from '../agent/verification-runs.js'
import { buildBashVerification } from '../agent/bash-verification.js'
import { classifyVerificationIntent, type VerificationExecutionIntent } from '../agent/verification-intent.js'
import { completionFacts } from './verification-facts.js'
import { prepareCompletionCaptureAsync } from './test-completion-async.js'
import type { JobSpawnOptions } from './job-store.js'
import type { ToolCallParams } from './types.js'
import { getShellCommand } from '../platform.js'
import { classifyDeclaredCommand, loadDeclaredVerify } from '../config/verify-config.js'
import { unwrapVerification } from './verification-invocation.js'

export async function prepareBackgroundVerification(command: string, params: ToolCallParams): Promise<{
  executionId?: string
  actual(command: string): void
  onStarted: JobSpawnOptions['onStarted']
  preparationError?: string
  command: string; env: NodeJS.ProcessEnv; onCompleted: JobSpawnOptions['onCompleted']; note: string; dispose(): void
  /** 同一条命令的执行意图（共同命令事实的唯一解析点）——由 spawn 侧写入
   *  SessionJobs 的私有元数据，供货方判定「是否在等门禁钦定证据」。 */
  intent: VerificationExecutionIntent
}> {
  // Background jobs may intentionally outlive the foreground tool invocation.
  // Preparation remains cancellable; each RPC has its own bounded deadline.
  const preparation = new AbortController()
  const cancelPreparation = () => preparation.abort(params.abortSignal?.reason)
  params.abortSignal?.throwIfAborted()
  params.abortSignal?.addEventListener('abort', cancelPreparation, { once: true })
  const capture = await prepareCompletionCaptureAsync(command, params.cwd, getShellCommand().kind, undefined,
    Number.MAX_SAFE_INTEGER, preparation.signal).finally(() => params.abortSignal?.removeEventListener('abort', cancelPreparation))
  const startedAt = Date.now()
  const intent = classifyVerificationIntent(command, params.cwd)
  const leaf = unwrapVerification(command, params.cwd)
  const declaredKind = classifyDeclaredCommand(leaf?.command ?? command, loadDeclaredVerify(leaf?.cwd ?? params.cwd))
  const kind = declaredKind ?? intent.scope?.kind
  const verificationCommand = !!declaredKind || intent.purpose !== 'none'
  /** 退出码能否充当通过/失败证据：**可归因到某个 kind** + 非常驻形态。
   *  这与「等待资格」（intent.waitingEligible，要求 lifetime === 'finite'）是两件事：
   *  包脚本体无法归因（`npm run lint` → lifetime 'unknown'）不等于它的退出码不可信。
   *  把两者合成一个谓词，会让可归因的 lint/build 退回「按输出文本猜失败」——
   *  脚本里任何一行 `# fail N` 都会把 exit 0 记成 failed
   *  （2026-10-10 回归，用例：verification-run-evidence.test.ts
   *  「background exit facts override replayed failure text」）。 */
  const trustworthyExit = !!leaf && (!!declaredKind || !!kind) && intent.lifetime !== 'persistent'
  const receipt = verificationLifecycle(params, command, params.cwd, { kind, scope: intent.scope?.scope ?? 'unknown', attribution: leaf ? 'known' : 'opaque' }, 'bash')
  receipt.actual(capture?.command ?? command)
  let recorded = false
  return {
    executionId: verificationCommand ? receipt.executionId : undefined,
    actual(command) { receipt.actual(command) },
    onStarted(job) { if (verificationCommand) { receipt.bindJob(job.id); receipt.started() } },
    preparationError: capture?.preparationError,
    command: capture?.command ?? command, env: capture?.env ?? {},
    dispose: () => capture?.dispose(),
    intent,
    note: !verificationCommand ? '' : capture || trustworthyExit && kind !== 'test'
      ? '\n验证运行中，完成后自动记录；启动或输出命中不代表验证通过。'
      : `\n覆盖尚未确认；退出结果和日志保留，可查询已有执行回执，不自动重跑。`,
    async onCompleted({ job, output, error, timedOut }) {
      if (recorded) return
      recorded = true
      try {
        if (!verificationCommand) return
        const exitCode = timedOut ? -1 : job.exitCode
        const coverage = await capture?.read(exitCode ?? -1)
        const stopped = job.status === 'killed'
        if (stopped && coverage) { coverage.complete = false; coverage.executionComplete = false }
        const result = { content: output, exitCode, isError: !!error || stopped || timedOut, errorClass: timedOut ? 'timeout' as const : error ? 'environment' as const : undefined }
        const verification = buildBashVerification(command, result, { content: output, isError: result.isError, errorClass: result.errorClass }, params.cwd)
        if (trustworthyExit || coverage) verification.status = exitCode === 0 && !result.isError ? 'passed' : 'failed'
        if (kind) verification.kind = kind
        if (verification.status === 'passed') delete verification.failureKind
        Object.assign(verification, completionFacts(coverage), { executionId: receipt.executionId, timestamp: startedAt, durationMs: (job.endedAt ?? Date.now()) - startedAt })
        if (coverage?.complete) delete verification.userGuidance
        if (kind === 'test' && !coverage) verification.countsReliable = false
        if (kind !== 'test') { delete verification.passed; delete verification.failed; delete verification.skipped; delete verification.countsReliable }
        if (stopped) verification.userGuidance = timedOut ? '后台验证超时并已终止；未取得完整覆盖证明。' : '后台验证已终止；未取得完整覆盖证明。'
        const final = receipt.finish({ ...verification, omittedBytes: job.omittedBytes }, error ? 'failed_to_start' : timedOut ? 'timed_out' : stopped ? 'cancelled' : 'exited', job.logRef)
        params.onVerificationCompleted?.(final)
      } finally { capture?.dispose() }
    },
  }
}
