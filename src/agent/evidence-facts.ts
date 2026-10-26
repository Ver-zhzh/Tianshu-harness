import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { readDeliveryReceipts } from './delivery-receipt.js'
import { listVerificationRuns } from './verification-runs.js'
import { createReviewInbox } from './review-inbox.js'

export type EvidenceValidity = 'current' | 'stale' | 'unknown'
export interface EvidenceResolution {
  ref: string
  sessionId: string
  project: string
  presence: 'present' | 'missing' | 'invalid'
  validity: EvidenceValidity
  result?: unknown
  reason?: string
}
export function evidenceProject(cwd: string): string {
  try { return realpathSync(cwd) } catch { return resolve(cwd) }
}
/** Reads existing records only. An observed fingerprint is never a new workspace proof. */
export function readEvidenceFacts(cwd: string, sessionId: string, currentFingerprint?: string | null) {
  assertValidSessionId(sessionId)
  const errors: string[] = [], project = evidenceProject(cwd)
  function read<T>(label: string, fallback: T, fn: () => T): T {
    try { return fn() } catch { errors.push(`${label}：记录损坏或归属不符，未知`); return fallback }
  }
  const receipts = read('提交回执', [] as string[], () => readDeliveryReceipts(cwd, sessionId))
  const task = read('任务台账', null as Record<string, any> | null, () => {
    const path = join(sessionsDir(cwd), `${sessionId}.task-state.json`)
    if (!existsSync(path)) return null
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (state.sessionId !== sessionId || evidenceProject(state.root) !== project || !Array.isArray(state.events)) throw Error('owner')
    return state
  })
  const commits = [...new Set([...receipts, ...(task?.events ?? []).filter((e: any) => e.type === 'git_action'
    && typeof e.meta?.commitSha === 'string' && /^[a-f0-9]{40,64}$/i.test(e.meta.commitSha)).map((e: any) => e.meta.commitSha)])]
  const runs = read('执行回执', [] as ReturnType<typeof listVerificationRuns>, () => listVerificationRuns(cwd, sessionId))
  const inbox = createReviewInbox(cwd, sessionId)
  const reviews = read('审查记录', [] as ReturnType<typeof inbox.getReviews>, () => inbox.getReviews())
  const findings = read('审查发现', [] as ReturnType<typeof inbox.list>, () => inbox.list(true))
  const validity = (fingerprint?: string | null, stale?: boolean): EvidenceValidity => stale ? 'stale'
    : !currentFingerprint || !fingerprint ? 'unknown' : fingerprint === currentFingerprint ? 'current' : 'stale'
  return { sessionId, project, commits, runs, reviews, findings, errors,
    observedFingerprint: typeof task?.fingerprint === 'string' ? task.fingerprint : undefined,
    resolve(ref: string): EvidenceResolution {
      const [kind, ...rest] = ref.split(':'), id = rest.join(':')
      const record = kind === 'execution' ? runs.find(r => r.executionId === id)
        : kind === 'review' ? reviews.find(r => r.id === id)
        : kind === 'commit' && commits.includes(id) ? { commitSha: id } : undefined
      return { ref, sessionId, project, presence: record ? 'present' : errors.length ? 'invalid' : 'missing',
        validity: record && 'workspaceFingerprint' in record ? validity(record.workspaceFingerprint, record.stale) : 'unknown',
        ...(record ? { result: record } : { reason: '无可核对的本会话记录' }) }
    } }
}
