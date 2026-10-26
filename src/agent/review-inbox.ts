import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { sessionsDir } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'
import type { ReviewOutcome } from './review-router.js'

const findingSchema = z.object({
  id: z.string(), reviewId: z.string(), commitRef: z.string(), files: z.array(z.string()),
  claim: z.string(), evidence: z.string(), severity: z.string().optional(),
  state: z.enum(['pending', 'confirmed', 'rejected', 'fixed', 'blocked', 'applied']),
  verification: z.enum(['not_run', 'passed', 'failed', 'stale']).default('not_run'),
  createdAt: z.number(), updatedAt: z.number(),
  history: z.array(z.object({ state: z.string(), at: z.number(), reason: z.string(), evidence: z.string(), fixCommit: z.string().optional(), verificationCommand: z.string().optional(), verification: z.enum(['not_run', 'passed', 'failed', 'stale']).optional() })).default([]),
  resolution: z.object({ reason: z.string(), evidence: z.string(), fixCommit: z.string().optional(), verificationCommand: z.string().optional(), verification: z.enum(['not_run', 'passed', 'failed', 'stale']).optional() }).optional(),
})
export type ReviewFindingTask = z.infer<typeof findingSchema>
export interface ReviewFollowupNotice { sessionId: string; reviewId: string }
const storeSchema = z.object({ version: z.literal(1), sessionId: z.string(),
  reviews: z.array(z.object({ id: z.string(), followupClaimed: z.boolean(), verdict: z.string().optional(), workspaceFingerprint: z.string().optional(), stale: z.boolean().optional() })), findings: z.array(findingSchema) })
type State = z.infer<typeof storeSchema>
export const reviewFollowupPrompt = '用户要求处理本会话审查发现时，用 review_changes(action="list") 读取记录，独立核实后登记处理结果。修复、验证和提交分别由用户决定；未执行测试须标 not_run。'

/** Each operation reloads before its atomic write; no stale run-local snapshot can erase newer findings. */
export function createReviewInbox(cwd: string, sessionId: string, options: { file?: string; now?: () => number } = {}) {
  assertValidSessionId(sessionId)
  const file = options.file ?? join(sessionsDir(cwd), sessionId, 'review-inbox.json')
  const now = options.now ?? Date.now
  const read = (): State => {
    if (!existsSync(file)) return { version: 1, sessionId, reviews: [], findings: [] }
    const data = storeSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (data.sessionId !== sessionId) throw new Error('Review inbox owner mismatch')
    return data
  }
  const write = (data: State) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileAtomicSync(file, JSON.stringify(data) + '\n')
  }
  return {
    sessionId,
    record(reviewId: string, commitRef: string, files: readonly string[], outcome: ReviewOutcome, version?: { workspaceFingerprint?: string; stale?: boolean }): ReviewFindingTask[] {
      const data = read()
      const defects = (outcome.findings ?? []).filter(f => f.polarity !== 'confirmation')
      if (outcome.patcherArtifacts?.length) defects.push({ claim: '隔离审查补丁尚未应用到主工作树',
        evidence: outcome.patcherArtifacts.map(a => `${a.patchSummary ?? '补丁待核实'}；${a.diffArtifactId ? `read_section artifactId=${a.diffArtifactId}` : '无可取回句柄，须重新复现'}；文件：${a.changedFiles.join(', ')}`).join('\n') })
      // Legacy L2 verdicts may only carry text. Preserve them as unverified triage work, never as confirmed bugs.
      if (!defects.length && outcome.verdict === 'rejected' && outcome.evidence) defects.push({ claim: '审查结论待独立核实', evidence: outcome.evidence })
      const added: ReviewFindingTask[] = []
      for (const f of defects) {
        const id = createHash('sha256').update(JSON.stringify([reviewId, f.claim, f.evidence])).digest('hex').slice(0, 16)
        if (data.findings.some(task => task.id === id)) continue
        const time = now()
        const task: ReviewFindingTask = { id, reviewId, commitRef, files: [...files], claim: f.claim ?? '待核实发现', evidence: f.evidence ?? '',
          severity: f.severity, state: 'pending', verification: 'not_run', createdAt: time, updatedAt: time, history: [] }
        data.findings.push(task); added.push(task)
      }
      if (!data.reviews.some(review => review.id === reviewId)) data.reviews.push({ id: reviewId, followupClaimed: false, verdict: outcome.verdict, ...version })
      write(data)
      return added
    },
    getReview(id: string) { return read().reviews.find(r => r.id === id) },
    getReviews() { return read().reviews },
    list(includeClosed = false): ReviewFindingTask[] {
      return read().findings.filter(f => includeClosed || f.state !== 'fixed' && f.state !== 'rejected')
    },
    claimFollowup(reviewId: string): boolean {
      const data = read(), review = data.reviews.find(r => r.id === reviewId)
      if (!review || review.followupClaimed || !data.findings.some(f => f.reviewId === reviewId && (f.state === 'pending' || f.state === 'confirmed'))) return false
      review.followupClaimed = true
      write(data)
      return true
    },
    releaseFollowup(reviewId: string): void {
      const data = read(), review = data.reviews.find(r => r.id === reviewId)
      if (review) { review.followupClaimed = false; write(data) }
    },
    update(id: string, state: ReviewFindingTask['state'], resolution: NonNullable<ReviewFindingTask['resolution']>): ReviewFindingTask {
      const data = read(), task = data.findings.find(f => f.id === id)
      if (!task) throw new Error('Finding does not belong to this session')
      if (!resolution.reason.trim() || !resolution.evidence.trim()) throw new Error('Resolution requires reason and independent evidence')
      if (task.state === 'rejected' || task.state === 'fixed' && (state !== 'fixed' || resolution.fixCommit !== task.resolution?.fixCommit)) throw new Error('Finding already closed; its audit record is immutable')
      if (state === 'fixed' && !resolution.fixCommit) throw new Error('Fixed requires a commit')
      if (state === 'fixed' && !['confirmed', 'applied', 'fixed'].includes(task.state)) throw new Error('Independently confirm the finding before marking it fixed')
      task.state = state; task.resolution = resolution; task.updatedAt = now(); task.verification = resolution.verification ?? 'not_run'
      task.history.push({ state, at: task.updatedAt, ...resolution })
      write(data)
      return task
    },
  }
}
export type ReviewInbox = ReturnType<typeof createReviewInbox>

export function renderReviewFindings(tasks: readonly ReviewFindingTask[]): string {
  if (!tasks.length) return '本会话没有未核销的审查发现。'
  return ['审查发现记录（处理时机由用户决定；worker 声称须独立核实）：',
    ...tasks.slice(0, 8).map(f => `- ${f.id} [${f.state}/${f.severity ?? '未定级'}；验证 ${f.verification}] ${f.claim}\n  证据线索：${f.evidence}\n  原提交：${f.commitRef}${f.resolution ? `\n  处理记录：${f.resolution.reason}；${f.resolution.evidence}` : ''}`),
    ...(tasks.length > 8 ? [`另有 ${tasks.length - 8} 项；用 review_changes(action="list") 查看。`] : []),
    '用 review_changes(action="update",id,state,reason,evidence) 登记处理结果；fixed 需真实 fix_commit，验证独立记录（缺省 not_run）；passed 需本会话真实验证记录。',
  ].join('\n')
}
