import { resolve } from 'node:path'
import { z } from 'zod'
import { gitCommand } from '../tools/git-command.js'
import type { ToolCallParams, ToolResult } from '../tools/types.js'
import type { TaskLedger } from './task-ledger.js'
import { renderReviewFindings, type ReviewInbox } from './review-inbox.js'

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), include_closed: z.boolean().optional() }),
  z.object({ action: z.literal('update'), id: z.string().min(1), state: z.enum(['confirmed', 'rejected', 'blocked', 'fixed', 'applied']),
    reason: z.string().trim().min(1), evidence: z.string().trim().min(1), fix_commit: z.string().optional(), verification_command: z.string().optional(), verification_status: z.enum(['not_run', 'passed', 'failed', 'stale']).optional() }),
])

/** Resolving a review finding is separate from permission to save a scoped commit. */
export async function handleReviewFindingAction(params: ToolCallParams, inbox: ReviewInbox | undefined, ledger: TaskLedger): Promise<ToolResult> {
  try {
    if (!inbox) throw new Error('本会话的持久化审查收件箱未接入')
    const action = actionSchema.parse(params.input.review_findings ?? params.input)
    if (params.input.commit === true) throw new Error('审查待办更新与提交请分别调用，不能用状态更新代替实际提交')
    if (action.action === 'list') {
      const tasks = inbox.list(action.include_closed)
      return { content: (tasks.length ? tasks.map(task => renderReviewFindings([task])).join('\n\n') : renderReviewFindings([]))
        + (action.include_closed ? `\n完整处理记录：\n${JSON.stringify(tasks, null, 2)}` : '') }
    }
    const task = inbox.list(true).find(f => f.id === action.id)
    if (!task) throw new Error('该 finding 不属于当前会话')
    let fixCommit: string | undefined
    const verification = action.verification_status ?? (action.verification_command ? 'passed' : 'not_run')
    if (action.state === 'fixed') {
      if (!action.fix_commit || !/^[a-f0-9]{7,64}$/i.test(action.fix_commit)) throw new Error('fixed 需要真实的 fix_commit SHA')
      const related = new Set(task.files.map(f => resolve(params.cwd, f)))
      const options = { signal: params.abortSignal, timeoutMs: 5000 }
      const revision = await gitCommand(params.cwd, ['rev-parse', '--verify', `${action.fix_commit}^{commit}`], options)
      if (revision.status !== 0) throw new Error('fix_commit 不存在')
      fixCommit = revision.stdout.trim()
      const files = await gitCommand(params.cwd, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', fixCommit], options)
      if (files.status !== 0 || !files.stdout.split('\0').filter(Boolean).some(f => related.has(resolve(params.cwd, f)))) throw new Error('修复提交没有改动被审查的文件')
      if (/^[a-f0-9]{7,64}$/i.test(task.commitRef)) {
        const original = await gitCommand(params.cwd, ['rev-parse', '--verify', `${task.commitRef}^{commit}`], options)
        const ancestor = await gitCommand(params.cwd, ['merge-base', '--is-ancestor', task.commitRef, fixCommit], options)
        if (ancestor.status !== 0 || original.stdout.trim() === fixCommit) throw new Error('fix_commit 必须是原审查提交之后的修复提交')
      }
    }
    if (verification !== 'not_run') {
      const related = new Set(task.files.map(f => resolve(params.cwd, f)))
      const lastWrite = Math.max(task.createdAt, ...ledger.getEvents().filter(e => e.type === 'file_write' && e.path && related.has(resolve(params.cwd, e.path))).map(e => e.timestamp))
      const proof = ledger.getVerifications().find(e => e.command === action.verification_command
        && (verification === 'stale' ? e.meta?.stale === true : e.timestamp >= lastWrite && e.meta?.stale !== true
          && e.status === verification && (verification !== 'passed' || typeof e.meta?.passed === 'number' && e.meta.passed > 0 && e.meta.failed === 0))
        && (e.meta?.scope === 'targeted' || e.meta?.scope === 'full')
        && (e.meta?.kind === 'test' || e.meta?.kind === undefined && /\btest\b|pytest|vitest|jest/.test(e.command ?? '')))
      if (!proof) throw new Error('验证状态需要本会话真实的 passed 回归验证或对应 failed/stale 记录；未执行请使用 not_run')
    }
    const updated = inbox.update(action.id, action.state, { reason: action.reason, evidence: action.evidence,
      verification, ...(fixCommit ? { fixCommit } : {}), ...(action.verification_command ? { verificationCommand: action.verification_command } : {}) })
    return { content: `审查待办 ${updated.id} → ${updated.state}\n原因：${action.reason}\n独立证据：${action.evidence}\n验证状态：${verification}${fixCommit ? `\n修复提交：${fixCommit}` : ''}` }
  } catch (error) {
    return { content: `审查待办未更新：${error instanceof Error ? error.message : String(error)}`, isError: true, errorKind: 'format_error' }
  }
}
