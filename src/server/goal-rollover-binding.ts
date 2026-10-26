import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getSessionDir } from '../agent/session-persist.js'
import { readFactHandoff, renderFactHandoff } from '../agent/fact-handoff.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { GoalRolloverCoordinator } from './goal-rollover.js'
import { RecoveryJournal } from './recovery-journal.js'
import { prepareRolloverInputs } from './goal-rollover-inputs.js'
import { getWaveGate, setWaveGate } from '../agent/wave-gate.js'
import { getInvokedSkills, recordSkillInvoked } from '../agent/skill-gate.js'
import { redactText } from './redact.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { SessionRecord } from './protocol.js'
import type { GoalRolloverView } from './goal-rollover-state.js'
import type { GoalTracker } from '../agent/goal-tracker.js'

export function canAttachRollover(record: SessionRecord, running: boolean, goal: GoalTracker | null, relayId: string, goalId: string): boolean {
  return !record.archived && !running && record.goalRollover?.id === relayId
    && record.goalRollover.phase !== 'cancelled'
    && (!goal || (goal.getGoalId() === goalId && goal.getStatus() === 'paused'))
}

export function bindGoalRollover<S extends { record: SessionRecord; running: boolean; disabledSkills: Set<string>; reviewGateOverride?: 'auto' | 'off' }>(manager: RuntimeSessionManager, opts: {
  journal?: RecoveryJournal
  sessions: Map<string, S>
  approvalMode(): SessionRecord['approvalMode']
  append(session: S, view: GoalRolloverView): void
  persist(session: S): void
  blocked(id: string): string | undefined
}) {
  const record = (id: string) => {
    const r = opts.sessions.get(id)?.record
    return r ? { ...r, approvalMode: r.approvalMode ?? opts.approvalMode() ?? 'manual' } : undefined
  }
  const busy = (id: string) => !!opts.sessions.get(id)?.running
  const publish = (id: string, state: GoalRolloverView) => {
    const session = opts.sessions.get(id)
    if (!session) return
    const { id: relayId, from, to, phase, generation, maxSessions, error } = state
    const view = { id: relayId, from, ...(to && opts.sessions.has(to) ? { to } : {}), phase, generation, maxSessions,
      ...(error ? { error: redactText(error) } : {}) }
    session.record.goalRollover = view
    opts.append(session, view)
    opts.persist(session)
  }
  const journals = new Map<string, RecoveryJournal>()
  const journal = (id: string) => {
    if (opts.journal) return opts.journal
    const session = record(id)
    if (!session) throw new Error('Session unavailable')
    let j = journals.get(session.cwd)
    if (!j) { j = new RecoveryJournal(join(getSessionDir(session.cwd), 'rollovers')); journals.set(session.cwd, j) }
    return j
  }
  const coordinator: GoalRolloverCoordinator = new GoalRolloverCoordinator({
    record,
    capabilities: id => ({ disabledSkills: [...(opts.sessions.get(id)?.disabledSkills ?? [])].sort(),
      reviewGateOverride: opts.sessions.get(id)?.reviewGateOverride }),
    tracker: id => manager.getSessionGoalTracker(id),
    busy,
    blocked: async id => {
      const r = record(id)
      if (!r || r.archived || r.pendingApprovals || r.unattendedHalt) return '会话存在中止或待审批事项'
      const busyReason = opts.blocked(id)
      if (busyReason) return busyReason
      if (getWaveGate(id)?.passed === false) return '波次验证尚未通过，请在原会话处理后恢复'
      if (r.planMode === 'planning' || r.askMode === 'asking') return '只读模式下不自动接力，请先确认执行权限'
      if ((await manager.listPlans(id))?.some(p => p.status === 'submitted')) return '计划等待审批，接力已暂停'
      const inspection = await journal(id).inspect(id)
      if (inspection?.needsConfirmation.length) return '存在结果未知的工具，请先确认后恢复'
      return undefined
    },
    load: async id => {
      const state = await journal(id).loadGoalRollover(id)
      if (state?.waveGate && !getWaveGate(id)) setWaveGate(state.waveGate, id)
      for (const skill of state?.invokedSkills ?? []) recordSkillInvoked(skill, id)
      return state
    },
    save: state => journal(state.from).saveGoalRollover({ ...state,
      waveGate: getWaveGate(state.from), invokedSkills: [...getInvokedSkills(state.from)] }),
    publish,
    handoff: (id, path, marker) => {
      if (!manager.requestHandoff(id).ok) return false
      const source = record(id)
      if (!source) return false
      mkdirSync(dirname(path), { recursive: true })
      writeFileAtomicSync(path, `${marker}\n${renderFactHandoff(readFactHandoff(source.cwd, id))}`)
      // 事实交接不产生模型轮次，接力状态机只能由这里手动推进；rejection 必须
      // 落地，否则接力会静默停在 handoff 阶段且无人知晓。
      queueMicrotask(() => { void coordinator.onRunSettled(id).catch(error => manager.reportGoalRolloverFailure(id, error)) })
      return true
    },
    create: state => {
      const source = record(state.from)!
      const next = manager.createSession({ ...state.policy, id: state.to,
        missionId: source.missionId,
        title: `${(source.title ?? 'Goal').replace(/ · 接力 \d+\/\d+$/, '')} · 接力 ${state.generation}/${state.maxSessions}`,
        reasoningEffort: source.reasoningEffort as import('../agent/auto-reasoning.js').ReasoningEffort | 'auto' })
      const stored = opts.sessions.get(next.id)!
      stored.disabledSkills = new Set(state.capabilities.disabledSkills)
      stored.reviewGateOverride = state.capabilities.reviewGateOverride
      for (const skill of getInvokedSkills(state.from)) recordSkillInvoked(skill, next.id)
      const gate = getWaveGate(state.from)
      if (gate) setWaveGate(gate, next.id)
      Object.assign(stored.record, { worktreePath: source.worktreePath, worktreeBranch: source.worktreeBranch,
        baselineHead: source.baselineHead, landedHead: source.landedHead })
      publish(next.id, state)
      return record(next.id)!
    },
    ensure: id => manager.ensureSessionAgent(id),
    attach: async (id, record, rolloverId) => !!(await manager.setGoal(id, { goal: record.objective,
      maxIterations: record.budgetLimits.maxIterations, contextWindow: record.budgetLimits.contextWindow, resumeRecord: record, rolloverId })),
    prepare: async (from, to, prompt) => {
      const source = record(from)!
      const inputs = await prepareRolloverInputs(manager, source)
      const window = manager.getSessionGoalTracker(from)?.getContextWindow() ?? 0
      if (inputs.text && Buffer.byteLength(inputs.text, 'utf8') > window * 0.25) throw new Error('原始附件占用过大，请先整理输入后恢复接力')
      return () => {
        if (busy(to) || record(to)?.archived) return false
        manager.resumeGoal(to, 'runtime')
        const started = manager.run(to, inputs.text ? `${prompt}\n\n原始输入文件：\n${inputs.text}` : prompt,
          inputs.images, false, undefined, { documents: inputs.documents, promptText: prompt })
        if (!started) manager.pauseGoal(to, '接力未启动')
        return started
      }
    },
    cancelGoal: id => manager.cancelGoal(id),
    retireWorkspace: (from, to) => {
      const a = opts.sessions.get(from), b = opts.sessions.get(to)
      if (a?.record.worktreePath && b?.record.worktreePath === a.record.worktreePath) {
        delete a.record.worktreePath; delete a.record.worktreeBranch; opts.persist(a)
      }
    },
  })
  return coordinator
}
