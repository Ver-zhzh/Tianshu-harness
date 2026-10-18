import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentLoop } from './loop.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import { validateExecutionHistory } from '../api/execution-continuity.js'
import { ContinuationPrefixError, LocalWorkerPolicyError, isCompleteExecutionSnapshot, assertRewindHistory, proveRewindHistory, type RewindGenerationAuthorization } from '../api/continuation-prefix.js'

export interface ContinuityRecoveryPlan {
  status: 'ready' | 'blocked' | 'applied'
  reason: string
  recoveryId?: string
  priorRequestId?: string
  sourceHash?: string
}
const maintenance = new WeakSet<AgentLoop>()
const previews = new WeakMap<AgentLoop, { plan: ContinuityRecoveryPlan; fingerprint: string; applied?: boolean }>()
export const isContinuityMaintenance = (agent: AgentLoop): boolean => maintenance.has(agent)
export async function withContinuityAvailable<T>(agent: AgentLoop, operation: () => Promise<T>): Promise<T> {
  if (maintenance.has(agent)) throw new LocalWorkerPolicyError('会话正在修复前缀，禁止启动新的执行')
  return operation()
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function assertIdle(agent: AgentLoop): void {
  if (agent.isRunning() || agent.config.client.getExecutionPolicy?.().singleAttempt || agent.config.inputOrigin === 'worker_task'
    || agent.config.coordinatorRef?.()?.hasRunningWork()) throw new LocalWorkerPolicyError('会话或 worker 正在运行，或属于固定执行 worker；禁止修复前缀')
}
function clean(snapshot: FrozenSnapshotData): FrozenSnapshotData {
  const { executionSnapshot: _proof, publishedHistory: _source, publishedUserCount: _count, renderedHistory: _render,
    rewindAuthorization: _rewind, pendingCompaction: _pending, ...rest } = snapshot
  return { ...rest, anchors: [], userKeys: [], frozenUserMerged: [], frozenPendingMerged: [], firstUserKey: null }
}
async function inspect(agent: AgentLoop) {
  const persist = agent.persist
  if (!persist) throw new LocalWorkerPolicyError('当前会话没有耐久历史，无法修复前缀')
  await agent.drainPersistWrites()
  await persist.drainFrozenSnapshots()
  const snapshot = persist.readFrozenSnapshot()
  if (!snapshot || snapshot.pendingCompaction || snapshot.rewindAuthorization) throw new LocalWorkerPolicyError('冻结证据缺失或有未决历史事务，禁止修复前缀')
  const prior = snapshot.executionSnapshot
  if (!isCompleteExecutionSnapshot(prior) || !snapshot.publishedHistory?.length) throw new LocalWorkerPolicyError('源历史封印或执行绑定不完整，禁止修复前缀')
  const history = agent.session.getMessages()
  const disk = persist.loadOai()
  const actual = proveRewindHistory(history)
  if (snapshot.publishedHistory.some((entry, index) => entry.hash !== actual[index]?.hash)
    || JSON.stringify(disk) !== JSON.stringify(history)) throw new LocalWorkerPolicyError('源历史与持久化封印不一致，禁止修复前缀')
  const active = agent.config.client.getMainPrefixProof?.()
  if (!active || hash(active) !== hash(prior)) throw new LocalWorkerPolicyError('运行时与持久化执行绑定不一致，禁止修复前缀')
  const probe = agent.config.promptEngine.withFrozenSnapshot(clean(snapshot)).buildOaiRequest(history)
  try { await validateExecutionHistory(agent.config.client, probe) }
  catch (error) {
    if (!(error instanceof ContinuationPrefixError) || !(typeof error.changed === 'number' || error.changed === 'source')) throw error
  }
  const sourceHash = hash(history)
  const fingerprint = hash({ prior, sourceHash, snapshot })
  return { persist, snapshot, prior, history: structuredClone(history), sourceHash, fingerprint }
}

export async function previewContinuityRecovery(agent: AgentLoop): Promise<ContinuityRecoveryPlan> {
  try {
    assertIdle(agent)
    const state = await inspect(agent)
    assertIdle(agent)
    const plan: ContinuityRecoveryPlan = { status: 'ready', reason: '确认后仅重建冻结投影；保留聊天，不重放已完成工具。',
      recoveryId: randomUUID(), priorRequestId: state.prior.requestId, sourceHash: state.sourceHash }
    previews.set(agent, { plan, fingerprint: state.fingerprint })
    return plan
  } catch (error) {
    return { status: 'blocked', reason: error instanceof Error ? error.message : '无法验证连续性证据' }
  }
}

export async function applyContinuityRecovery(agent: AgentLoop, recoveryId: string): Promise<ContinuityRecoveryPlan> {
  const durable = agent.persist?.readFrozenSnapshot()
  const alreadyApplied = durable?.rewindAuthorization?.reason === 'explicit_projection_recovery'
    ? durable.rewindAuthorization.cacheGenerationId : durable?.executionSnapshot?.generationReason === 'explicit_projection_recovery'
      ? durable.executionSnapshot.cacheGenerationId : undefined
  if (alreadyApplied === recoveryId) {
    if (durable?.rewindAuthorization) {
      assertIdle(agent)
      assertRewindHistory(durable.rewindAuthorization, agent.session.getMessages())
      assertRewindHistory(durable.rewindAuthorization, agent.persist!.loadOai())
      agent.config.client.restoreRewindAuthorization!(durable.rewindAuthorization)
      agent.config.promptEngine.prepareProjectionRecovery(durable.rewindAuthorization)
      agent.config.promptEngine.setExecutionSnapshotCommit(snapshot => agent.persist!.commitFrozenSnapshot(snapshot))
    }
    return { status: 'applied', reason: '一次性恢复授权已提交', recoveryId }
  }
  const saved = previews.get(agent)
  if (!saved || saved.plan.recoveryId !== recoveryId) throw new LocalWorkerPolicyError('恢复预览不存在或已过期，请重新预览')
  if (saved.applied) return { ...saved.plan, status: 'applied' }
  assertIdle(agent)
  maintenance.add(agent)
  const engine = agent.config.promptEngine, client = agent.config.client
  try {
    await agent.cancelIdleCompaction()
    const state = await inspect(agent)
    if (state.fingerprint !== saved.fingerprint || agent.config.promptEngine !== engine || agent.config.client !== client) throw new LocalWorkerPolicyError('预览后的历史或执行绑定已变化，请重新预览')
    if (!client.restoreRewindAuthorization) throw new LocalWorkerPolicyError('执行客户端不支持耐久恢复授权')
    const authorization: RewindGenerationAuthorization = { version: 1, reason: 'explicit_projection_recovery',
      cacheGenerationId: saved.plan.recoveryId!, model: state.prior.model, history: proveRewindHistory(state.history), prior: state.prior }
    const path = state.persist.getFilePath().replace(/\.jsonl$/, '.frozen.json')
    const original = await readFile(path)
    const backup = join(dirname(path), basename(state.persist.getFilePath(), '.jsonl'), 'continuity-backups', `${saved.plan.recoveryId}.json`)
    await mkdir(dirname(backup), { recursive: true })
    try { await copyFile(path, backup, constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await readFile(backup)).equals(original)) throw new LocalWorkerPolicyError('恢复备份身份冲突') }
    if (!(await readFile(path)).equals(original) || hash(agent.session.getMessages()) !== state.sourceHash
      || hash(client.getMainPrefixProof?.()) !== hash(state.prior)) throw new LocalWorkerPolicyError('备份期间历史或执行绑定发生变化，请重新预览')
    if (agent.config.coordinatorRef?.()?.hasRunningWork()) throw new LocalWorkerPolicyError('worker 已启动，禁止修复前缀')
    const target = { ...clean(state.snapshot), executionSnapshot: state.prior, rewindAuthorization: authorization }
    await state.persist.commitFrozenSnapshot(target)
    engine.prepareProjectionRecovery(authorization)
    engine.setExecutionSnapshotCommit(snapshot => state.persist.commitFrozenSnapshot(snapshot))
    client.restoreRewindAuthorization(authorization)
    saved.applied = true
    return { ...saved.plan, status: 'applied' }
  } finally { maintenance.delete(agent) }
}
