import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { listVerificationRuns } from '../agent/verification-runs.js'
import { readEvidenceFacts } from '../agent/evidence-facts.js'
import { createReviewInbox } from '../agent/review-inbox.js'
import { validatePath } from '../tools/path-validate.js'
import { detectSensitiveFileOnDisk } from '../tools/sensitive-file-detector.js'
import type { AcceptanceItemInput, ToolCallParams } from '../tools/types.js'
import { existingPlanRevision, readPlanClosures } from './continuity-records.js'
import type { ContinuityRecord, PlanClosureRecord } from './continuity-records.js'

export type ExecutionStatus = 'completed' | 'partial' | 'blocked'
export interface AcceptanceRecord extends AcceptanceItemInput {
  id: string
  planRef?: string
  codeFingerprint?: string
  sourceVersions: Record<string, string>
  planRevision?: string
}
export interface FindingDisposition {
  findingId: string
  stepId: string
  disposition: 'adopted' | 'excluded' | 'deferred' | 'unverified'
  reason?: string
  reportRef?: string
  resolutionEvidenceRefs?: string[]
}
export interface EvidenceState { sessionId: string; acceptance: AcceptanceRecord[]; findings: FindingDisposition[]
  decisions?: ContinuityRecord[]; openItems?: ContinuityRecord[]; closures?: PlanClosureRecord[] }
function location(params: ToolCallParams): string {
  if (!params.sessionId) throw new Error('验收证据需要明确的会话归属')
  assertValidSessionId(params.sessionId)
  return join(sessionsDir(params.cwd), params.sessionId, 'completion-evidence.json')
}
export function readCompletionEvidence(params: ToolCallParams): EvidenceState {
  const path = location(params)
  if (!existsSync(path)) return { sessionId: params.sessionId!, acceptance: [], findings: [], closures: readPlanClosures(params) }
  const state = JSON.parse(readFileSync(path, 'utf8')) as EvidenceState
  if (state.sessionId !== params.sessionId || !Array.isArray(state.acceptance) || !Array.isArray(state.findings)) throw new Error('验收证据归属或格式不符')
  state.closures = [...(state.closures ?? []), ...readPlanClosures(params)].filter((c, index, all) => all.findIndex(r => r.id === c.id) === index)
  return state
}
export function saveCompletionEvidence(params: ToolCallParams, state: EvidenceState): void {
  if (state.sessionId !== params.sessionId) throw Error('验收证据归属不符')
  const path = location(params)
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomicSync(path, JSON.stringify(state) + '\n')
}
export function sourceVersion(params: ToolCallParams, ref: string): string | undefined {
  const match = /^source:(.+):(\d+)$/.exec(ref)
  if (!match) return undefined
  const path = validatePath(params.cwd, match[1]!)
  if (detectSensitiveFileOnDisk(path).sensitive) throw new Error('敏感材料不可作为源码证据')
  const text = readFileSync(path, 'utf8')
  if (+match[2]! < 1 || +match[2]! > text.split('\n').length) return undefined
  return createHash('sha256').update(text).digest('hex')
}
export function criterionHasEvidence(params: ToolCallParams, item: AcceptanceRecord, readOnly = false): boolean {
  try {
  if (!item.kind || !item.consumerBoundary?.trim() || !item.evidenceRefs?.length) return false
  if (item.planRevision && item.planRef) {
    let revision = item.planRevision
    for (const closure of readCompletionEvidence(params).closures ?? []) if (closure.planRef === item.planRef && closure.beforeRevision === revision) revision = closure.afterRevision
    if (existingPlanRevision(params.cwd, item.planRef) !== revision) return false
  }
  const current = readOnly ? undefined : params.currentVerificationFingerprint?.()
  return item.evidenceRefs.every(ref => {
    if (ref.startsWith('execution:')) {
      const run = listVerificationRuns(params.cwd, params.sessionId!).find(r => r.executionId === ref.slice(10))
      return item.kind === 'verification' && !!run && run.executionState === 'exited' && run.outcome === 'passed'
        && (run.kind !== 'test' || run.coverageStatus === 'complete') && !!current && run.workspaceFingerprint === current
    }
    if (ref.startsWith('review:')) {
      const review = createReviewInbox(params.cwd, params.sessionId!).getReview(ref.slice(7))
      return item.kind === 'review' && !!review && ['verified', 'rejected', 'nudge'].includes(review.verdict ?? '') && !review.stale && !!current && review.workspaceFingerprint === current
    }
    if (!ref.startsWith('source:') || item.kind !== 'implementation') return false
    const hash = sourceVersion(params, ref)
    return !!hash && item.sourceVersions[ref] === hash
  })
  } catch { return false }
}
export function recordCompletionEvidence(params: ToolCallParams, items: AcceptanceItemInput[], findings: FindingDisposition[] = [], planRef?: string): AcceptanceRecord[] {
  const path = location(params), state = readCompletionEvidence(params)
  const normalizedPlan = planRef ? relative(params.cwd, validatePath(params.cwd, planRef)).replaceAll('\\', '/') : undefined
  const normalized = items.map(item => {
    if ((item.status === 'deferred' || item.status === 'blocked') && !(item.reason ?? item.evidence)?.trim()) throw new Error('延后或受阻的验收项必须给出原因')
    const id = item.id ?? createHash('sha256').update(JSON.stringify([normalizedPlan, item.kind, item.criterion])).digest('hex').slice(0, 16)
    const previous = state.acceptance.find(a => a.id === id)
    if (previous && (previous.criterion !== item.criterion || previous.kind !== item.kind || previous.planRef !== normalizedPlan)) throw new Error(`验收 ID ${id} 的定义不可改变`)
    const sourceVersions: Record<string, string> = {}
    for (const ref of item.evidenceRefs ?? []) if (ref.startsWith('source:')) {
      const hash = sourceVersion(params, ref)
      if (hash) sourceVersions[ref] = hash
    }
    const next: AcceptanceRecord = { ...item, id, planRef: normalizedPlan, planRevision: existingPlanRevision(params.cwd, normalizedPlan), codeFingerprint: params.currentVerificationFingerprint?.() ?? undefined, sourceVersions }
    if (next.status === 'met' && !criterionHasEvidence(params, next)) next.status = 'pending'
    return next
  })
  const inbox = createReviewInbox(params.cwd, params.sessionId!).list(true)
  for (const finding of findings) {
    const previous = state.findings.find(f => f.findingId === finding.findingId)
    const reportRef = finding.reportRef ?? previous?.reportRef
    const report = reportRef ? params.artifactStore?.get(reportRef) : undefined
    if (!inbox.some(f => f.id === finding.findingId) && !report) throw new Error(`找不到本会话发现或已登记 worker 报告 ${finding.findingId}`)
    if (['excluded', 'deferred'].includes(finding.disposition) && !finding.reason?.trim()) throw new Error('排除或延后发现必须给出原因')
    if (!normalized.some(a => a.stepId === finding.stepId) && !state.acceptance.some(a => a.stepId === finding.stepId)) throw new Error('发现必须关联已有计划步骤')
    const facts = readEvidenceFacts(params.cwd, params.sessionId!)
    if (finding.resolutionEvidenceRefs?.some(ref => ref.startsWith('source:') ? !sourceVersion(params, ref) : facts.resolve(ref).presence !== 'present')) throw Error('实施证据引用无法核对')
    state.findings = [...state.findings.filter(f => f.findingId !== finding.findingId), { ...finding, ...(reportRef ? { reportRef } : {}) }]
  }
  for (const item of normalized) state.acceptance = [...state.acceptance.filter(a => a.id !== item.id), item]
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomicSync(path, JSON.stringify(state) + '\n')
  return normalized
}

export function completionSummary(params: ToolCallParams, planRef: string, executionStatus: ExecutionStatus) {
  let state: EvidenceState = { sessionId: params.sessionId ?? '', acceptance: [], findings: [] }
  const unavailable: string[] = []
  try { if (params.sessionId) state = readCompletionEvidence(params) }
  catch { unavailable.push('验收记录无法确认，保留待核实') }
  const ids = Array.isArray(params.input.acceptance_ids) ? params.input.acceptance_ids : undefined
  const criteria = state.acceptance.filter(a => ids ? ids.includes(a.id) : a.planRef === planRef)
    .map(a => ({ ...a, status: a.status === 'met' && !criterionHasEvidence(params, a, true) ? 'pending' as const : a.status }))
  const executionIds = Array.isArray(params.input.execution_ids) ? params.input.execution_ids.filter((id): id is string => typeof id === 'string') : []
  let runs: ReturnType<typeof listVerificationRuns> = []
  try { if (params.sessionId) runs = listVerificationRuns(params.cwd, params.sessionId) }
  catch { unavailable.push('执行回执无法确认，未自动重跑') }
  const current: string | undefined = undefined // close is a historical read; never captures a new workspace fingerprint
  const verification = executionIds.length ? executionIds.map(id => {
    const run = runs.find(r => r.executionId === id)
    return run ? `${id}: ${run.executionState}/${run.outcome}，覆盖 ${run.coverageStatus}${!current || !run.workspaceFingerprint ? '（版本不可确认）' : run.workspaceFingerprint !== current ? '（旧版本）' : ''}` : `${id}: 未知（无本会话回执）`
  }).join('；') : '未提供执行回执，未知/未执行'
  const claims = Array.isArray(params.input.verifiedCommands) ? params.input.verifiedCommands.filter((c): c is string => typeof c === 'string') : []
  const legacyCommands = claims.map(command => `${command}（${runs.some(r => executionIds.includes(r.executionId) && r.command === command) ? '已关联回执，结果见上' : '历史声明，未核实'}）`)
  const review = criteria.filter(a => a.kind === 'review').map(a => `${a.id}: ${a.status}`).join('；') || '未关联审查记录，未知/未执行'
  const facts = params.sessionId ? readEvidenceFacts(params.cwd, params.sessionId) : undefined
  const commits = facts?.commits ?? []
  unavailable.push(...(facts?.errors ?? []))
  const summary = [`执行：${executionStatus}`, `实际提交：${commits.length ? commits.join(', ') : '无本会话提交回执（不可确认）'}`, `验证：${verification}`, `审查：${review}`]
  const acceptanceLines = criteria.map(a => `${a.id} [${a.kind ?? '未分类'}/${a.status}] ${a.criterion}；消费边界：${a.consumerBoundary ?? '未声明'}；证据：${a.evidenceRefs?.join(', ') || '无'}${a.reason ?? a.evidence ? `；${a.reason ?? a.evidence}` : ''}`)
  const findingLines = state.findings.filter(f => criteria.some(a => a.stepId === f.stepId)).map(f => `finding:${f.findingId}${f.reportRef ? `（artifact:${f.reportRef}）` : ''} → ${f.stepId}: ${f.disposition}${f.reason ? `（${f.reason}）` : ''}；实施证据：${f.resolutionEvidenceRefs?.join(', ') || '未登记，仍待实施核实'}；验证独立记录`)
  const continuity = [...state.decisions ?? [], ...state.openItems ?? []].filter(i => i.planRef === planRef)
    .map(i => `${i.id} [${'kind' in i ? i.kind : '未决'}/${i.status}；${i.provenance}] ${i.text}；原因：${i.reason || '未知'}${'closedBy' in i ? `；关闭条件：${i.closedBy || '未知'}；重开条件：${i.reopenIf || '未知'}；下一步：${i.nextAction || '未知'}` : ''}`)
  return { executionStatus, executionIds, criteria, summary: summary.join('\n'), detail: [...summary, ...unavailable, ...legacyCommands.map(c => `历史命令：${c}`), ...acceptanceLines, ...findingLines, ...continuity] }
}
