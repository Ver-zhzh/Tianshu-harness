import { createHash } from 'node:crypto'
import { stableStringify } from './stable-json.js'
import type { Usage } from './types.js'
import { isValidNativeProof } from './native-continuation.js'
import type { NativeCacheAnnotation } from './native-continuation.js'
export type { NativeSourceBoundaries } from './native-continuation.js'

export interface ContinuationPrefixProof {
  version: 1 | 2
  cacheGenerationId?: string
  generationReason?: string
  /** Diagnostic provenance only; never changes binding or generation policy. */
  wireTransformVersion?: string
  credentialScope?: string
  options?: Record<string, unknown>
  provider: string
  model: string
  requestId: string
  endpointHash?: string
  optionsHash: string
  toolsHash: string
  messages: Array<{ hash: string; chars: number; role: string }>
  canonicalSource?: string[]
  nativeTail?: { blockCount: number; hash: string }
  nativeCacheLayout?: NativeCacheAnnotation[]
}

export interface RewindGenerationAuthorization {
  version: 1
  reason: 'explicit_user_rewind' | 'context_limit' | 'explicit_user_compact' | 'explicit_projection_recovery' | 'image_budget'
  cacheGenerationId: string
  model: string
  history: ContinuationPrefixProof['messages']
  prior: ContinuationPrefixProof
}

export function isRewindGenerationAuthorization(value: unknown): value is RewindGenerationAuthorization {
  if (!value || typeof value !== 'object') return false
  const authorization = value as RewindGenerationAuthorization
  return authorization.version === 1 && ['explicit_user_rewind', 'context_limit', 'explicit_user_compact', 'explicit_projection_recovery', 'image_budget'].includes(authorization.reason)
    && typeof authorization.cacheGenerationId === 'string' && authorization.cacheGenerationId.length > 0
    && typeof authorization.model === 'string' && authorization.model.length > 0
    && isCompleteExecutionSnapshot(authorization.prior)
    && authorization.cacheGenerationId !== authorization.prior.cacheGenerationId
    && Array.isArray(authorization.history) && authorization.history.every(message => message
      && typeof message.hash === 'string' && /^[a-f0-9]{64}$/.test(message.hash)
      && typeof message.role === 'string' && Number.isFinite(message.chars))
}

export function proveRewindHistory(messages: readonly unknown[]): ContinuationPrefixProof['messages'] {
  return messages.map(message => ({ hash: hash(message), chars: JSON.stringify(message).length,
    role: String((message as { role?: unknown }).role) }))
}

export function assertRewindHistory(authorization: RewindGenerationAuthorization, messages: readonly unknown[]): void {
  const current = proveRewindHistory(messages)
  if (authorization.history.some((message, index) => current[index]?.hash !== message.hash)) {
    throw new LocalWorkerPolicyError('回退授权对应的保留历史发生变化；禁止发送请求')
  }
}

export interface RequestDiagnostics {
  purpose: 'worker_execution' | 'worker_finalize' | 'worker_report_repair' | 'compact_summary' | 'side_question' | 'vision_description' | 'vision_question' | 'reasoning_recovery' | 'essence_gate' | 'llm_speculation' | 'risk_explain'
  workOrderId?: string
  routeReason?: string
  parentRequestId?: string
  continuationSource?: string
  previousMainRequestId?: string
  baseline?: 'present' | 'baseline_missing' | 'configuration_changed'
  priorPrefix?: ContinuationPrefixProof
}

export class LocalWorkerPolicyError extends Error {
  readonly code: string = 'LOCAL_WORKER_POLICY'
  constructor(message: string, public continuityEvidence?: ContinuityDiagnosticEvidence) { super(message); this.name = 'LocalWorkerPolicyError' }
}

export interface HistoryIntegrityDetails {
  reason: 'missing' | 'extra' | 'changed' | 'checksum' | 'incomplete_frame' | 'unreadable' | 'published_source' | 'none'
  memoryCount: number
  persistedCount: number | null
  publishedCount?: number
  firstMismatch?: number
  legacyTruncation?: boolean
}

export class HistoryIntegrityError extends LocalWorkerPolicyError {
  constructor(message: string, readonly historyIntegrity: HistoryIntegrityDetails) {
    super(`${message}（内存=${historyIntegrity.memoryCount}，磁盘=${historyIntegrity.persistedCount ?? '未知'}${historyIntegrity.firstMismatch === undefined ? '' : `，首差异下标=${historyIntegrity.firstMismatch}`}）`)
  }
}

export class ContinuationPrefixError extends LocalWorkerPolicyError {
  constructor(readonly changed: string | number, readonly previous: ContinuationPrefixProof, readonly next: ContinuationPrefixProof, evidence?: ContinuityDiagnosticEvidence) {
    super(`worker continuation prefix diverged at ${changed}; request not sent`, evidence)
    this.name = 'ContinuationPrefixError'
  }
}

export type PrefixComparison = 'same' | 'changed' | 'unknown'
export interface ContinuityDiagnosticEvidence {
  stage?: 'source' | 'render' | 'transport' | 'binding' | 'unknown'
  sourcePrefix?: PrefixComparison
  renderPrefix?: PrefixComparison
  normalization?: import('./wire-normalization.js').WireNormalizationSummary
}
export interface ContinuityFailureDetails extends ContinuityDiagnosticEvidence {
  kind: 'source_history' | 'projection' | 'tools' | 'options' | 'binding' | 'anchor_missing' | 'anchor_mismatch' | 'snapshot_stale' | 'persistence'
  changed?: string | number
  beforeChars?: number
  afterChars?: number
  deltaChars?: number
  recovery: 'preview' | 'blocked'
  historyIntegrity?: HistoryIntegrityDetails
}
export function continuityFailureDetails(error: unknown): ContinuityFailureDetails | undefined {
  if (error instanceof HistoryIntegrityError) return { kind: 'source_history', stage: 'source', sourcePrefix: 'changed', renderPrefix: 'unknown', recovery: 'blocked', historyIntegrity: error.historyIntegrity }
  if (error instanceof ContinuationPrefixError) {
    const kind = typeof error.changed === 'number' ? 'projection' : error.changed === 'source' ? 'source_history'
      : error.changed === 'tools' ? 'tools' : error.changed === 'options' ? 'options' : 'binding'
    const index = typeof error.changed === 'number' ? error.changed : -1
    const beforeChars = error.previous.messages[index]?.chars, afterChars = error.next.messages[index]?.chars
    return { kind, changed: error.changed, beforeChars, afterChars,
      stage: kind === 'projection' || kind === 'source_history' ? 'unknown' : 'binding',
      sourcePrefix: 'unknown', renderPrefix: 'unknown', ...error.continuityEvidence,
      ...(beforeChars !== undefined && afterChars !== undefined ? { deltaChars: afterChars - beforeChars } : {}),
      recovery: kind === 'projection' ? 'preview' : 'blocked' }
  }
  if (!(error instanceof Error)) return undefined
  if (/持久化历史不完整|源历史与持久化封印不一致|历史与压缩提交|回退授权对应的保留历史/.test(error.message)) {
    return { kind: 'source_history', stage: 'source', sourcePrefix: 'changed', renderPrefix: 'unknown', recovery: 'blocked' }
  }
  const kind = /已发布锚点缺失/.test(error.message) ? 'anchor_missing' : /已发布锚点与冻结投影/.test(error.message) ? 'anchor_mismatch'
    : /冻结构建已过期/.test(error.message) ? 'snapshot_stale' : /耐久提交失败/.test(error.message) ? 'persistence' : undefined
  return kind ? { kind, stage: kind === 'anchor_missing' || kind === 'anchor_mismatch' ? 'render' : 'unknown',
    sourcePrefix: 'unknown', renderPrefix: 'unknown',
    ...(error instanceof LocalWorkerPolicyError ? error.continuityEvidence : {}),
    recovery: kind === 'anchor_missing' || kind === 'anchor_mismatch' ? 'preview' : 'blocked' } : undefined
}

/** resume 证据门（session-persist）专用：历史请求的模型/凭据/选项证据缺失或不完整。
 *  区别于一般策略错误——桌面端据此渲染「以当前配置继续」动作（kind: cold_start_evidence）。 */
export class ColdStartEvidenceError extends LocalWorkerPolicyError {
  readonly code = 'COLD_START_EVIDENCE'
  constructor(message: string) { super(message); this.name = 'ColdStartEvidenceError' }
}

export function isColdStartEvidenceError(error: unknown): error is ColdStartEvidenceError {
  return error instanceof ColdStartEvidenceError || (error instanceof Error && error.name === 'ColdStartEvidenceError')
}

export function isLocalWorkerPolicyError(error: unknown): error is LocalWorkerPolicyError {
  return error instanceof LocalWorkerPolicyError || (error instanceof Error && ['ContinuationPrefixError', 'LocalWorkerPolicyError', 'ColdStartEvidenceError'].includes(error.name))
}

const hash = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex')

export function proveCanonicalSource(messages: readonly unknown[]): string[] {
  return messages.map(hash)
}

export function assertCanonicalSourcePrefix(previous: ContinuationPrefixProof, next: ContinuationPrefixProof): void {
  if (!isValidNativeProof(previous) || !isValidNativeProof(next)) {
    throw new LocalWorkerPolicyError('Execution snapshot has invalid continuation evidence; request not sent')
  }
  if (previous.canonicalSource?.some((message, index) => next.canonicalSource?.[index] !== message)) {
    const at = previous.messages.findIndex((message, index) => next.messages[index]?.hash !== message.hash)
    throw new ContinuationPrefixError(at === -1 ? 'source' : at, previous, next)
  }
}

export function isCompleteExecutionSnapshot(value: unknown): value is ContinuationPrefixProof & { options: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false
  const p = value as ContinuationPrefixProof
  return p.version === 2 && typeof p.cacheGenerationId === 'string' && typeof p.credentialScope === 'string'
    && (p.wireTransformVersion === undefined || (typeof p.wireTransformVersion === 'string' && p.wireTransformVersion.length > 0))
    && typeof p.endpointHash === 'string' && typeof p.provider === 'string' && typeof p.model === 'string'
    && typeof p.requestId === 'string' && typeof p.toolsHash === 'string' && typeof p.optionsHash === 'string'
    && !!p.options && !Array.isArray(p.options) && hash(p.options) === p.optionsHash
    && Array.isArray(p.messages) && p.messages.every(m => m && typeof m.hash === 'string' && typeof m.role === 'string' && Number.isFinite(m.chars))
    && isValidNativeProof(p)
}

/** Hash the final transport body, after every send-time transformation. No content or headers. */
export function proveWirePrefix(body: Record<string, unknown>, provider: string, requestId: string, endpoint?: string): ContinuationPrefixProof {
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>
  return {
    version: 2, provider, model: String(body.model), requestId,
    options: wireOptions(body),
    ...(endpoint ? { endpointHash: hash(endpoint) } : {}),
    optionsHash: hash(wireOptions(body)), toolsHash: hash(body.tools ?? []),
    messages: messages.map(m => ({
      hash: hash(m), chars: JSON.stringify(m).length, role: String(m.role),
    })),
  }
}

export function wireOptions(body: Record<string, unknown>): Record<string, unknown> {
  const fields = ['thinking', 'reasoning_effort', 'tool_choice', 'response_format', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'output_config', 'generationConfig', 'toolConfig', 'text', 'safetySettings', 'parallel_tool_calls', 'seed', 'stop', 'frequency_penalty', 'presence_penalty', 'service_tier']
  const covered = new Set([...fields, 'model', 'stream', 'messages', 'tools', 'system', 'instructions', 'systemInstruction', 'input', 'contents', 'reasoning', 'max_output_tokens'])
  const extraFields = Object.fromEntries(Object.keys(body).filter(key => !covered.has(key)).sort().map(key => [key, hash(body[key])]))
  return { ...Object.fromEntries(fields.map(key => [key, body[key] ?? null])), ...(Object.keys(extraFields).length ? { extraFields } : {}) }
}

export function wireObservation(body: Record<string, unknown>, proof: ContinuationPrefixProof, diagnostics?: RequestDiagnostics, main?: ContinuationPrefixProof): NonNullable<NonNullable<Usage['observation']>['wire']> {
  return { provider: proof.provider, model: proof.model, purpose: diagnostics?.purpose,
    continuationSource: diagnostics?.continuationSource, previousMainRequestId: diagnostics?.previousMainRequestId ?? main?.requestId,
    baseline: diagnostics?.priorPrefix || main ? 'present' : 'baseline_missing', comparison: 'not_checked', endpointHash: proof.endpointHash,
    messages: proof.messages, toolsHash: proof.toolsHash, options: wireOptions(body) }
}

/** Proven historical forks fail locally before dispatch. Legacy recovery requires a complete snapshot. */
export function assertContinuationPrefix(previous: ContinuationPrefixProof | undefined, next: ContinuationPrefixProof): 'present' | 'baseline_missing' | 'configuration_changed' {
  if (!previous) return 'baseline_missing'
  if (previous.provider !== next.provider || previous.model !== next.model || (previous.endpointHash && previous.endpointHash !== next.endpointHash)) throw new ContinuationPrefixError('binding', previous, next)
  const changed = previous.toolsHash !== next.toolsHash
    ? 'tools' : previous.messages.findIndex((m, i) => next.messages[i]?.hash !== m.hash)
  if (changed === 'tools' || changed !== -1) throw new ContinuationPrefixError(changed, previous, next)
  if (previous.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', previous, next)
  return 'present'
}
