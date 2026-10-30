import type { SessionRecord, CreateSessionInput } from './session-manager.js'
import { createHash } from 'node:crypto'
import { SessionPersist } from '../agent/session-persist.js'
import { archiveHistoryRescue, buildHistoryRescue, seedHistoryRescue } from '../agent/history-rescue.js'

export function manageHistoryRescue(owner: { getSession(id: string): SessionRecord | undefined }, source: SessionRecord | undefined, available: boolean,
  sourceHash: string | undefined, create: (input: CreateSessionInput, handoff: string) => SessionRecord) {
  if (!source) return undefined
  if (!available) throw new Error('请等待会话和更新准备结束后救援历史')
  const persist = new SessionPersist(source.id, source.cwd), rescue = buildHistoryRescue(persist)
  if (!sourceHash) return rescue
  // New identity and frozen state are independent; no old tool calls are seeded.
  const targetId = `rescue-${createHash('sha256').update(source.id).update(sourceHash).digest('hex').slice(0, 40)}`
  const existing = owner.getSession(targetId)
  if (existing) {
    const first = new SessionPersist(targetId, existing.cwd).loadOai()[0]
    if (existing.cwd !== source.cwd || first?.role !== 'user' || first.content !== rescue.handoff) throw new Error('救援会话身份与交接不一致，禁止覆盖')
    return { session: existing }
  }
  if (sourceHash !== rescue.sourceHash) throw new Error('历史在预览后发生变化，请重新导出并预览')
  archiveHistoryRescue(persist, rescue)
  seedHistoryRescue(source.cwd, targetId, rescue)
  const record = create({ id: targetId, cwd: source.cwd, workspaceRoots: source.workspaceRoots, model: source.model,
    approvalMode: source.approvalMode, allowedTools: source.allowedTools, title: `${source.title ?? source.id} · 历史救援` }, rescue.handoff)
  return { session: record }
}
