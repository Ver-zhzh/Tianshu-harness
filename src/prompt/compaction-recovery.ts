import type { OaiMessage } from '../api/oai-types.js'
import { LocalWorkerPolicyError, proveRewindHistory, type ContinuationPrefixProof } from '../api/continuation-prefix.js'
import { parseFrozenSnapshotData, type FrozenSnapshotData } from './frozen-snapshot.js'
import { existsSync, statSync } from 'node:fs'

export function hasSnapshotHistory(logPath: string, transcriptPath: string, readHistory: () => OaiMessage[]): { hasLog: boolean; hasRequests: boolean } {
  const hasLog = existsSync(logPath) && statSync(logPath).size > 0
  return { hasLog, hasRequests: hasLog || (existsSync(transcriptPath) && statSync(transcriptPath).size > 0 && readHistory().length > 0) }
}

export function matchesCompactionHistory(expected: ContinuationPrefixProof['messages'], messages: readonly OaiMessage[]): boolean {
  if (messages.length < expected.length) return false
  const actual = proveRewindHistory(messages.slice(0, expected.length))
  return expected.every((message, index) => message.hash === actual[index]?.hash)
}

export function recoverCompactionSnapshot(raw: unknown, readHistory: () => OaiMessage[]): FrozenSnapshotData | undefined {
  let data = parseFrozenSnapshotData(raw)
  const pendingPresent = !!raw && typeof raw === 'object' && 'pendingCompaction' in raw
  if (pendingPresent && !data?.pendingCompaction) throw new LocalWorkerPolicyError('压缩提交标记损坏；禁止恢复历史')
  if (!data?.pendingCompaction) return data
  const { priorHistory, authorization } = data.pendingCompaction
  if (JSON.stringify(data.executionSnapshot) !== JSON.stringify(authorization.prior)) {
    throw new LocalWorkerPolicyError('压缩授权与冻结执行证据不一致；禁止恢复')
  }
  const actual = readHistory()
  if (matchesCompactionHistory(priorHistory, actual)) data = { ...data, pendingCompaction: undefined }
  else if (matchesCompactionHistory(authorization.history, actual)) {
    data = { ...data, pendingCompaction: undefined, rewindAuthorization: authorization }
  } else throw new LocalWorkerPolicyError('历史与压缩提交的旧态和新态均不匹配；禁止恢复')
  return data
}
