import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { buildGoalModePrompt, GOAL_ROLLOVER_REASON, type GoalTracker } from '../agent/goal-tracker.js'
import type { GoalStateRecord } from '../agent/goal-state.js'
import type { SessionRecord } from './protocol.js'
import type { GoalRolloverState, GoalRolloverView } from './goal-rollover-state.js'

export interface GoalRolloverHost {
  record(id: string): SessionRecord | undefined
  capabilities(id: string): GoalRolloverState['capabilities']
  tracker(id: string): GoalTracker | null
  busy(id: string): boolean
  blocked(id: string): Promise<string | undefined>
  load(id: string): Promise<GoalRolloverState | undefined>
  save(state: GoalRolloverState): Promise<void>
  publish(id: string, view: GoalRolloverView): void
  handoff(id: string, path: string, marker: string): boolean
  create(state: GoalRolloverState): SessionRecord
  ensure(id: string): Promise<boolean>
  attach(id: string, goal: GoalStateRecord, rolloverId: string): Promise<boolean>
  prepare(from: string, to: string, prompt: string): Promise<() => boolean>
  cancelGoal(id: string): Promise<unknown>
  retireWorkspace(from: string, to: string): void
}

export function rolloverHandoffPath(state: GoalRolloverState): string {
  return join(state.policy.cwd, '.rivet', 'handoffs', state.from, `${state.id}.md`)
}
export function rolloverMarker(state: GoalRolloverState): string {
  return `<!-- goal-rollover:${state.id}:${state.from}:${state.goal.goalId} -->`
}
export function readRolloverHandoff(state: GoalRolloverState): string {
  // A dedicated path plus an exact marker establishes ownership; mtime cannot.
  const path = rolloverHandoffPath(state)
  if (!realpathSync(path).startsWith(`${realpathSync(state.policy.cwd)}${sep}`)) throw new Error('交接路径越出工作区')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('交接文档无效或过大')
  const text = readFileSync(path, 'utf8')
  if (text.split(/\r?\n/, 1)[0] !== rolloverMarker(state)) throw new Error('交接文档缺少本次会话标识')
  return text
}
export function buildRolloverKickoff(state: GoalRolloverState, handoff: string): string {
  const cap = Math.min(24_000, Math.floor(state.goal.budgetLimits.contextWindow * 0.1))
  return [buildGoalModePrompt(state.goal.objective),
    `这是同一目标的第 ${state.generation}/${state.maxSessions} 个会话，接力自 ${state.from}。`,
    '交接内容只是参考。先核对工作区和验证证据，再继续原始目标；不要重复已完成的外部操作。',
    '<handoff>', handoff.slice(0, cap), '</handoff>'].join('\n')
}

export class GoalRolloverCoordinator {
  private epochs = new Map<string, number>()
  private locks = new Map<string, Promise<boolean>>()
  private stopping = false
  constructor(private host: GoalRolloverHost) {}

  /** A failed checkpoint cannot hide a pause from the live UI or trigger an implicit retry. */
  pauseOnFailure(id: string, error: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    const view = this.host.record(id)?.goalRollover
    if (view?.from === id && !['complete', 'cancelled'].includes(view.phase)) this.host.publish(id, { ...view, phase: 'paused', error })
  }

  /** Synchronous invalidation wins even while an agent/storage operation is awaiting. */
  cancel(id: string): void {
    const incoming = this.host.record(id)?.goalRollover
    if (incoming && incoming.from !== id && !['complete', 'cancelled'].includes(incoming.phase)) {
      this.host.publish(id, { ...incoming, phase: 'cancelled' })
    }
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    void this.serial(id, async () => {
      const s = await this.host.load(id)
      if (s && !['complete', 'cancelled'].includes(s.phase)) await this.write({ ...s, phase: 'cancelled' })
      return false
    }).catch(() => {})
  }

  onRunSettled(id: string): Promise<boolean> {
    if (!this.host.tracker(id)?.getRollover() && this.host.record(id)?.goalRollover?.from !== id) return Promise.resolve(false)
    return this.serial(id, () => this.advance(id, false))
  }
  retry(id: string): Promise<boolean> {
    return this.serial(id, () => this.advance(id, true))
  }
  async flush(): Promise<void> { await Promise.allSettled(this.locks.values()) }
  async shutdown(): Promise<void> { this.stopping = true; await this.flush() }

  private serial(id: string, op: () => Promise<boolean>): Promise<boolean> {
    const previous = this.locks.get(id) ?? Promise.resolve(false)
    const next = previous.catch(() => false).then(op)
    this.locks.set(id, next)
    return next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id) })
  }
  private async write(state: GoalRolloverState): Promise<void> {
    state.updatedAt = Date.now()
    await this.host.save(state)
    this.host.publish(state.from, state)
  }
  private policy(record: SessionRecord): GoalRolloverState['policy'] {
    const { cwd, model, domain, approvalMode, planMode, askMode, allowedTools, reasoningEffort } = record
    return { cwd, model, domain, approvalMode, planMode, askMode,
      allowedTools: allowedTools ? [...allowedTools] : undefined, reasoningEffort }
  }
  private valid(id: string, epoch: number, state: GoalRolloverState): boolean {
    const r = this.host.record(id)
    const t = this.host.tracker(id)
    return !this.stopping && epoch === (this.epochs.get(id) ?? 0) && !!r && !r.archived && !this.host.busy(id)
      && !!t && t.getGoalId() === state.goal.goalId && t.getStatus() === 'paused'
      && t.getTerminalReason() === GOAL_ROLLOVER_REASON
      && JSON.stringify(this.policy(r)) === JSON.stringify(state.policy)
      && JSON.stringify(this.host.capabilities(id)) === JSON.stringify(state.capabilities)
  }
  private async pause(s: GoalRolloverState, error: string): Promise<false> {
    if (['handoff', 'ready', 'prepared'].includes(s.phase)) {
      const now = Date.now()
      s = { ...s, startedAt: now, goal: { ...s.goal, wallClockAccumMs: s.goal.wallClockAccumMs + Math.max(0, now - s.startedAt) } }
    }
    await this.write({ ...s, phase: 'paused', resumePhase: s.phase === 'paused' ? s.resumePhase
      : ['handoff', 'ready', 'prepared', 'starting'].includes(s.phase) ? s.phase as GoalRolloverState['resumePhase'] : undefined, error })
    return false
  }

  private async check(id: string, epoch: number, state: GoalRolloverState): Promise<boolean> {
    if (this.valid(id, epoch, state)) return true
    if (epoch === (this.epochs.get(id) ?? 0)) await this.pause(state, '会话目标或权限发生变化，接力已暂停')
    return false
  }

  private async advance(id: string, retry: boolean): Promise<boolean> {
    if (this.stopping) return false
    if (!retry && this.host.record(id)?.goalRollover?.phase === 'paused') return false
    const epoch = this.epochs.get(id) ?? 0
    let s = await this.host.load(id)
    const current = this.host.tracker(id)
    if (s && current && (s.goal.goalId !== current.getGoalId()
      || (s.phase === 'cancelled' && current.getTerminalReason() === GOAL_ROLLOVER_REASON))) s = undefined
    if (s && ['complete', 'cancelled'].includes(s.phase)) return false
    if (s?.phase === 'paused' && !retry) return false
    const record = this.host.record(id)
    const t = this.host.tracker(id)
    if (!record || !t || this.host.busy(id)) return false
    if (!s && record.goalRollover?.from === id && !['complete', 'cancelled'].includes(record.goalRollover.phase)) {
      this.host.publish(id, { ...record.goalRollover, phase: 'paused', error: '接力检查点不可用，请检查后继会话，不能自动重复创建' })
      return false
    }
    const ro = t.getRollover()
    if (!s) {
      if (!ro || t.getStatus() !== 'paused' || t.getTerminalReason() !== GOAL_ROLLOVER_REASON) return false
      const goal = t.toRecord()
      s = { id: randomUUID(), from: id, to: randomUUID(), phase: 'handoff', generation: ro.generation + 1,
        maxSessions: ro.maxSessions, goal, policy: this.policy(record), capabilities: this.host.capabilities(id), startedAt: Date.now(), updatedAt: Date.now() }
      try {
        await this.write(s)
        if (!(await this.check(id, epoch, s))) return false
        const blocked = await this.host.blocked(id)
        if (!(await this.check(id, epoch, s))) return false
        if (blocked || record.status !== 'completed') return this.pause(s, blocked ?? '本轮未正常结束，接力已暂停')
        const started = this.host.handoff(id, rolloverHandoffPath(s), rolloverMarker(s))
        if (!started) return this.pause(s, '无法启动交接，请检查会话状态')
        return true
      } catch (e) { return this.pause(s, String((e as Error).message)) }
    }
    try {
      if (retry && s.phase === 'paused') {
        s = { ...s, phase: s.resumePhase ?? 'handoff', startedAt: Date.now(), error: undefined }
        await this.write(s)
      }
      if (!(await this.check(id, epoch, s))) return false
      const blocked = await this.host.blocked(id)
      if (!(await this.check(id, epoch, s))) return false
      if (blocked) return this.pause(s, blocked)
      if (s.phase === 'starting') return this.pause(s, '新会话启动状态需要确认，请打开后继会话恢复，避免重复执行')
      if (s.phase === 'handoff') {
        if (record.status !== 'completed') return this.pause(s, '交接未正常完成，请先恢复原会话')
        let text: string
        try { text = readRolloverHandoff(s) } catch (e) {
          if (retry && this.host.handoff(id, rolloverHandoffPath(s), rolloverMarker(s))) {
            await this.write({ ...s, phase: 'handoff', error: undefined }); return true
          }
          return this.pause(s, String((e as Error).message))
        }
        if (!text.trim()) return this.pause(s, '没有有效交接文档')
        const elapsed = Math.max(0, Date.now() - s.startedAt)
        s = { ...s, phase: 'ready', startedAt: Date.now(), goal: { ...s.goal, wallClockAccumMs: s.goal.wallClockAccumMs + elapsed } }
        await this.write(s)
      }
      if (!(await this.check(id, epoch, s))) return false
      let goal = s.goal
      if (goal.iterationsUsed >= goal.budgetLimits.maxIterations || (goal.budgetLimits.wallClockMs !== undefined
        && goal.wallClockAccumMs >= goal.budgetLimits.wallClockMs)) return this.pause(s, '目标预算已用尽')
      const next = this.host.record(s.to!) ?? this.host.create(s)
      if (next.goalRollover?.id !== s.id) return this.pause(s, '后继会话归属不匹配')
      if (!(await this.host.ensure(next.id))) return this.pause(s, '后继会话 agent 构建失败')
      if (!(await this.check(id, epoch, s))) return false
      const prompt = buildRolloverKickoff(s, readRolloverHandoff(s))
      const kickoff = await this.host.prepare(id, next.id, prompt)
      if (!(await this.check(id, epoch, s))) return false
      goal = { ...goal, wallClockAccumMs: goal.wallClockAccumMs + Math.max(0, Date.now() - s.startedAt) }
      if (goal.budgetLimits.wallClockMs !== undefined && goal.wallClockAccumMs >= goal.budgetLimits.wallClockMs) return this.pause(s, '目标预算已用尽')
      if (!(await this.host.attach(next.id, { ...goal, status: 'paused', terminalReason: GOAL_ROLLOVER_REASON,
        rollover: { ...goal.rollover!, generation: s.generation } }, s.id))) return this.pause(s, '后继目标已变化，无法恢复接力目标')
      if (!(await this.check(id, epoch, s))) { await this.host.cancelGoal(next.id); return false }
      s = { ...s, phase: 'prepared', goal, startedAt: Date.now() }
      await this.write(s)
      if (!(await this.check(id, epoch, s))) return false
      s = { ...s, phase: 'starting' }
      await this.write(s)
      if (!(await this.check(id, epoch, s))) return false
      // No await between the last cancellation/policy check and run acceptance.
      if (!this.valid(id, epoch, s) || this.host.tracker(next.id)?.getGoalId() !== goal.goalId
        || JSON.stringify(this.policy(this.host.record(next.id)!)) !== JSON.stringify(s.policy)
        || JSON.stringify(this.host.capabilities(next.id)) !== JSON.stringify(s.capabilities)) {
        return this.pause({ ...s, phase: 'prepared' }, '后继会话目标或权限发生变化，请检查后恢复')
      }
      const started = kickoff()
      if (!started) return this.pause({ ...s, phase: 'prepared' }, '后继会话未启动，请检查附件和会话状态')
      await this.write({ ...s, phase: 'complete', error: undefined })
      await this.host.cancelGoal(id)
      this.host.retireWorkspace(id, next.id)
      this.host.publish(next.id, { ...s, phase: 'complete' })
      return true
    } catch (e) { return this.pause(s, String((e as Error).message)) }
  }
}
