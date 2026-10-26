import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import type { ToolCallParams, VerificationMetadata } from '../tools/types.js'
import { verificationIdentity, type VerificationIdentity } from '../tools/verification-identity.js'

import { DELIVERY_CONTRACT_VERSION } from './delivery-contract.js'
export { DELIVERY_CONTRACT_VERSION } from './delivery-contract.js'
export interface VerificationRun extends VerificationMetadata {
  executionId: string
  sessionId: string
  cwd: string
  executionState: 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed_to_start' | 'unknown'
  outcome: 'passed' | 'failed' | 'unknown'
  coverageStatus: 'complete' | 'partial' | 'unknown'
  startedAt?: number
  endedAt?: number
  jobId?: string
  actualCommand?: string
  buildId: string
  contractVersion: number
  requestKey?: string
  requestVersion?: string
  environmentFingerprint?: string
}
const active = new Set<string>()
const key = (cwd: string, owner: string, id: string) => `${resolve(cwd)}:${owner}:${id}`
function file(cwd: string, sessionId: string): string {
  assertValidSessionId(sessionId)
  return join(sessionsDir(cwd), sessionId, 'verification-runs.jsonl')
}
export function listVerificationRuns(cwd: string, sessionId: string): VerificationRun[] {
  const path = file(cwd, sessionId)
  if (!existsSync(path)) return []
  const runs = new Map<string, VerificationRun>()
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]?.trim()) continue
    let value: VerificationRun
    try { value = JSON.parse(lines[index]!) } catch {
      if (index === lines.length - 1) break
      throw new Error('Invalid verification receipt journal')
    }
    if (value.sessionId !== sessionId || !value.executionId) throw new Error('Verification receipt owner mismatch')
    runs.set(value.executionId, value)
  }
  return [...runs.values()].map(run => run.executionState === 'running' && !active.has(key(cwd, sessionId, run.executionId))
    ? { ...run, executionState: 'unknown', outcome: 'unknown', coverageStatus: 'unknown' } : run)
}
export function saveVerificationRun(cwd: string, run: VerificationRun): void {
  const path = file(cwd, run.sessionId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(run) + '\n')
}
export function enrichVerificationRun(cwd: string, owner: string, verification: VerificationMetadata): void {
  if (!verification.executionId) return
  const prior = listVerificationRuns(cwd, owner).find(r => r.executionId === verification.executionId)
  if (prior) {
    const next = { ...prior, ...verification }
    saveVerificationRun(cwd, { ...next, outcome: next.executionState === 'exited' ? resultOutcome(next) : 'unknown', coverageStatus: coverageStatus(next) })
  }
}
function coverageStatus(v: VerificationMetadata): VerificationRun['coverageStatus'] {
  return v.coverage?.executionComplete === true ? 'complete' : v.coverage ? 'partial' : 'unknown'
}
function resultOutcome(v: VerificationMetadata): VerificationRun['outcome'] {
  if ((v.kind ?? 'test') === 'test' && (v.attribution === 'opaque' || v.failureKind === 'tool_invocation_failure')) return 'unknown'
  if ((v.kind ?? 'test') === 'test' && v.scope === 'unknown' && v.countsReliable !== true) return 'unknown'
  if (v.status === 'failed' || v.exitCode !== undefined && v.exitCode !== 0) return 'failed'
  if (v.status !== 'passed') return 'unknown'
  if (v.kind !== 'test' && v.kind !== undefined) return 'passed'
  return v.countsReliable === true && (v.passed ?? 0) > 0 && v.failed === 0 ? 'passed' : 'unknown'
}

/** Construct before spawn, publish running only on a real spawn event. */
export function verificationLifecycle(params: ToolCallParams, command: string, executionCwd: string, initial: Partial<VerificationMetadata> = {}, tool: 'bash' | 'run_tests' = 'run_tests') {
  const executionId = randomUUID(), owner = params.sessionId
  let startedAt: number | undefined, settled = false, jobId: string | undefined
  let persistenceError: string | undefined
  let fingerprint: string | null | undefined
  let identity: VerificationIdentity | undefined, actualCommand = command
  try { fingerprint = params.currentVerificationFingerprint?.() } catch { fingerprint = undefined }
  identity = verificationIdentity(params, tool)
  const publish = (run: VerificationRun) => {
    try { if (owner) saveVerificationRun(params.cwd, run) } catch (error) { persistenceError = String(error) }
  }
  const base = (): VerificationRun => ({ command, kind: 'test', status: 'blocked', scope: 'unknown', ...initial, ...identity,
    executionId, sessionId: owner ?? '', cwd: executionCwd, startedAt, jobId, actualCommand,
    buildId: process.env.RIVET_BUILD_ID ?? 'unknown', contractVersion: DELIVERY_CONTRACT_VERSION,
    workspaceFingerprint: fingerprint, executionState: 'running', outcome: 'unknown', coverageStatus: 'unknown' })
  return {
    executionId,
    actual(command: string) { actualCommand = command },
    bindJob(id: string) { jobId = id },
    started() {
      if (startedAt || settled) return
      startedAt = Date.now()
      try { params.onVerificationStarted?.(executionId) } catch { /* bookkeeping cannot replay an already-started process */ }
      if (owner) active.add(key(params.cwd, owner, executionId))
      publish(base())
    },
    finish(v: VerificationMetadata, state: VerificationRun['executionState'], logRef?: string): VerificationMetadata {
      const facts = { ...v, attribution: v.attribution ?? initial.attribution }
      const metadata = { ...facts, durationMs: v.durationMs ?? (startedAt ? Date.now() - startedAt : undefined), executionId, executionState: state, outcome: state === 'exited' ? resultOutcome(facts) : 'unknown' as const, coverageStatus: coverageStatus(v), ...(logRef ? { logRef } : {}) }
      if (settled) return metadata
      settled = true
      if (owner) active.delete(key(params.cwd, owner, executionId))
      publish({ ...base(), ...metadata, endedAt: Date.now() })
      return { ...metadata, ...(persistenceError ? { userGuidance: `执行已结束，回执持久化失败：${persistenceError}；不要重复执行。` } : {}) }
    },
  }
}

export function renderVerificationRun(run: VerificationRun): string {
  const command = run.command.length > 500 ? run.command.slice(0, 500) + '…（命令过长，查询结构化回执可取原文）' : run.command
  const actual = run.actualCommand && run.actualCommand !== run.command ? `\n实际命令：${run.actualCommand.slice(0, 500)}${run.actualCommand.length > 500 ? '…' : ''}` : ''
  return `${run.executionId} · ${run.executionState} · result=${run.outcome} · coverage=${run.coverageStatus}${run.stale ? ' · stale' : ''}\n${command}${actual}\ncwd=${run.cwd} · exit=${run.exitCode ?? 'unknown'} · ${run.durationMs ?? '?'}ms\n范围：${run.scope}；实际目标：${run.targetFiles?.slice(0, 10).join(', ') || '未知'}${(run.targetFiles?.length ?? 0) > 10 ? ` …共 ${run.targetFiles!.length} 项` : ''}${run.logRef ? `\n日志：${run.logRef}` : ''}${run.omittedBytes ? `（遗漏 ${run.omittedBytes} 字节）` : ''}\n代码指纹：${run.workspaceFingerprint ?? '未知'}\nbuild=${run.buildId} · contract=${run.contractVersion}`
}
