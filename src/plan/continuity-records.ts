import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { sessionsDir } from '../config/paths.js'
import { decodeTranscriptText } from '../agent/session-transcript-codec.js'
import { verifyLines } from '../agent/checksum.js'
import { validatePath } from '../tools/path-validate.js'
import type { ToolCallParams } from '../tools/types.js'
import { readCompletionEvidence, saveCompletionEvidence, sourceVersion } from './completion-evidence.js'
import { readEvidenceFacts } from '../agent/evidence-facts.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'
import { planRevision } from './plan-revision.js'

const base = { id: z.string().min(1), text: z.string().min(1), stepId: z.string().optional(),
  reason: z.string().optional(), sourceQuote: z.string().min(1).optional() }
export const decisionSchema = z.object({ ...base, kind: z.enum(['constraint', 'decision', 'rejected', 'proposal']),
  status: z.enum(['active', 'superseded']).default('active') })
export const openItemSchema = z.object({ ...base, status: z.enum(['pending', 'closed', 'deferred', 'blocked']).default('pending'),
  closedBy: z.string().optional(), reopenIf: z.string().optional(), nextAction: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional() })
export type DecisionInput = z.input<typeof decisionSchema>
export type OpenItemInput = z.input<typeof openItemSchema>
export type ContinuityRecord = (z.output<typeof decisionSchema> | z.output<typeof openItemSchema>) & {
  planRef?: string; sourceRef?: string; provenance: 'user_quote' | 'approval' | 'unverified'; updatedAt: number
}
export interface PlanClosureRecord {
  id: string; planRef: string; beforeRevision: string; afterRevision: string
  executionStatus: 'completed' | 'partial' | 'blocked'; acceptanceIds: string[]; executionIds: string[]
  summary: string; at: number
}
export function existingPlanRevision(cwd: string, planRef?: string): string | undefined {
  try { return planRef ? planRevision(readFileSync(validatePath(cwd, planRef), 'utf8')) : undefined } catch { return undefined }
}
export function recordContinuity(params: ToolCallParams, decisions: DecisionInput[] = [], openItems: OpenItemInput[] = [], planRef?: string): void {
  const state = readCompletionEvidence(params)
  const messages: Array<{ content: string }> = []
  try {
    const text = decodeTranscriptText(readFileSync(join(sessionsDir(params.cwd), `${params.sessionId}.jsonl`)))
    for (const line of verifyLines(text.split('\n').filter(Boolean)).validLines) {
      const row = JSON.parse(line)
      if (row.role === 'user' && row.origin === 'human') {
        const content = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? row.content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : ''
        if (content) messages.push({ content })
      }
    }
  } catch { /* missing, legacy or corrupt provenance never becomes human authorization */ }
  function normalize(value: z.output<typeof decisionSchema> | z.output<typeof openItemSchema>): ContinuityRecord {
    if ((value.status === 'deferred' || value.status === 'blocked' || 'kind' in value && value.kind === 'rejected') && !value.reason?.trim()) throw Error('否决、延后和受阻记录必须有原因')
    if (!('kind' in value) && value.status === 'closed') {
      if (!value.closedBy?.trim() || !value.evidenceRefs?.length) throw Error('关闭未决项需要关闭条件及证据引用')
      const facts = readEvidenceFacts(params.cwd, params.sessionId!)
      if (value.evidenceRefs.some(ref => ref.startsWith('source:') ? !sourceVersion(params, ref) : facts.resolve(ref).presence !== 'present')) throw Error('关闭证据不存在或不可核对')
    }
    const matches = value.sourceQuote ? messages.filter(m => m.content.includes(value.sourceQuote!)) : []
    const sourceRef = matches.length === 1 ? `message:${createHash('sha256').update(matches[0]!.content).digest('hex')}` : undefined
    return { ...value, ...('kind' in value && value.kind === 'constraint' && sourceRef ? { text: value.sourceQuote! } : {}), planRef, provenance: sourceRef ? 'user_quote' : 'unverified', sourceRef, updatedAt: Date.now() }
  }
  const nextDecisions = decisions.map(d => normalize(decisionSchema.parse(d)))
  const nextOpen = openItems.map(o => normalize(openItemSchema.parse(o)))
  for (const [key, values] of [['decisions', nextDecisions], ['openItems', nextOpen]] as const) {
    const prior = state[key] ?? []
    for (const value of values) {
      const old = prior.find(p => p.id === value.id)
      if (old?.provenance === 'approval') throw Error('模型不能改写真实审批记录')
      if (old && old.planRef !== value.planRef) throw Error('稳定 ID 不可跨计划复用')
    }
    state[key] = [...prior.filter(p => !values.some(v => v.id === p.id)), ...values]
  }
  saveCompletionEvidence(params, state)
}
/** Called only by actual approval entrypoints, never by todo's model-controlled input. */
export function recordApprovedDecision(cwd: string, sessionId: string, planRef: string, content: string, approach?: string): void {
  const params = { cwd, sessionId, toolUseId: 'approval', input: {} }, state = readCompletionEvidence(params)
  const revision = planRevision(content), id = `approved-${revision.slice(0, 24)}`
  const decisions = (state.decisions ?? []).map<ContinuityRecord>(d => 'kind' in d && d.planRef === planRef && d.provenance === 'approval' ? { ...d, status: 'superseded' } : d).filter(d => d.id !== id)
  decisions.push({ id, kind: 'decision', text: `已批准计划 ${planRef}${approach ? `；所选方案：${approach}` : ''}`,
    status: 'active', planRef, sourceRef: `approval:${revision}`, provenance: 'approval', updatedAt: Date.now() })
  state.decisions = decisions
  saveCompletionEvidence(params, state)
}
export function recordPlanClosure(params: ToolCallParams, record: Omit<PlanClosureRecord, 'id' | 'at'>): void {
  const id = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  assertValidSessionId(params.sessionId!)
  const dir = join(sessionsDir(params.cwd), params.sessionId!)
  const closures = [...readPlanClosures(params).filter(c => c.id !== id), { ...record, id, at: Date.now() }]
  mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(join(dir, 'completion-closures.json'), JSON.stringify({ sessionId: params.sessionId, closures }) + '\n')
}
export function readPlanClosures(params: Pick<ToolCallParams, 'cwd' | 'sessionId'>): PlanClosureRecord[] {
  assertValidSessionId(params.sessionId!)
  const path = join(sessionsDir(params.cwd), params.sessionId!, 'completion-closures.json')
  if (!existsSync(path)) return []
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (state.sessionId !== params.sessionId || !Array.isArray(state.closures)) throw Error('计划关闭记录归属不符')
  return state.closures
}
