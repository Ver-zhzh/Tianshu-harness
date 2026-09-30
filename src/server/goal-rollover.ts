/**
 * Goal 上下文接力（rollover）——目标模式下上下文到达阈值时，自动写交接文档、
 * 开同 cwd 的新会话、带原目标原话与交接文档继续跑。适合无人值守的长任务。
 *
 * 状态机（每个源会话最多一条在途接力）：
 *   goal run 收尾，tracker 以 GOAL_ROLLOVER_REASON 暂停
 *     → 发起交接 run（复用 requestHandoff：写 .rivet/HANDOFF.md 并归档）
 *   交接 run 收尾
 *     → 读归档文档 → 新会话 setGoal（剩余预算 + generation+1）→ kickoff run
 *     → 旧会话 goal 取消（防止两个会话同时追同一个目标）
 *
 * 硬性护栏：
 *  - 会话总数受 maxSessions 约束（tracker.check 在名额用尽时不再请求接力）；
 *  - 迭代与墙钟预算按剩余量传给下一棒，不会因接力重置；
 *  - 新会话沿用源会话的审批档/模型/星域，不提升权限；任一 run 被中止/失败、
 *    有待审批项、交接文档缺失，则停在「goal 暂停」态等人处理，不硬开新会话；
 *  - 旧会话 run 已收尾（claims 已由 releaseRunClaims 释放）后才开新会话。
 *
 * 编排主体放在本模块（session-manager 行数棘轮），manager 只注入 host 并在
 * run 收尾处调用 onRunSettled。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGoalModePrompt, GOAL_ROLLOVER_REASON, type GoalTracker } from '../agent/goal-tracker.js'
import { getSessionDir } from '../agent/session-persist.js'
import type { ApprovalMode, SessionRecord, SessionEventType } from './protocol.js'

/** 交接文档注入 kickoff 的最大字符数——防止文档本身把新会话上下文吃掉。 */
export const ROLLOVER_HANDOFF_MAX_CHARS = 24_000

export interface GoalRolloverHost {
  getRecord(id: string): SessionRecord | undefined
  getTracker(id: string): GoalTracker | null
  requestHandoff(id: string, note: string): { ok: boolean; error?: string }
  createSession(input: { cwd: string; title?: string; model?: string; domain?: string; approvalMode?: ApprovalMode }): SessionRecord
  setGoal(id: string, opts: {
    goal: string
    maxIterations: number
    contextWindow: number
    wallClockMs?: number
    successCriteria?: string[]
    rollover?: { ratio: number; maxSessions: number; generation: number }
  }): Promise<unknown>
  cancelGoal(id: string): Promise<unknown>
  /** 先建好 agent：goal handles（refs.goalTrackerRef）随 agent 构建才登记，否则 setGoal 拿不到槽。 */
  ensureAgent(id: string): Promise<boolean>
  run(id: string, prompt: string): boolean
  append(id: string, type: SessionEventType, data: Record<string, unknown>): void
  /** 测试接缝：读归档交接文档。缺省读 <sessionDir>/<id>.handoff.md。 */
  readHandoff?(record: SessionRecord): string | null
}

export function buildRolloverHandoffNote(generation: number, maxSessions: number): string {
  return [
    `自动接力：目标模式上下文已达阈值，本会话（第 ${generation}/${maxSessions} 棒）即将结束，`,
    '下一个会话只能看到这份交接文档和原始目标。请务必写清：已完成（含验证证据）、',
    '进行中的半成品、下一步具体动作、关键文件路径与验证命令。写完即停，不要继续干活。',
  ].join('')
}

export function buildRolloverKickoff(opts: {
  goal: string
  generation: number
  maxSessions: number
  fromSessionId: string
  handoff: string
}): string {
  const body = opts.handoff.length > ROLLOVER_HANDOFF_MAX_CHARS
    ? `${opts.handoff.slice(0, ROLLOVER_HANDOFF_MAX_CHARS)}\n…（交接文档过长已截断）`
    : opts.handoff
  return [
    buildGoalModePrompt(opts.goal),
    '',
    `[GOAL ROLLOVER] 这是同一目标的第 ${opts.generation}/${opts.maxSessions} 个会话，上一个会话 ${opts.fromSessionId} 因上下文到达阈值交棒。`,
    '下面是它留下的交接文档。它只是参考：与上面的原始目标冲突时以原始目标为准；文档中声称已完成的事项，动手前先用工具核实。',
    '',
    '<handoff>',
    body.trim(),
    '</handoff>',
  ].join('\n')
}

function defaultReadHandoff(record: SessionRecord): string | null {
  const dest = join(getSessionDir(record.cwd), `${record.id}.handoff.md`)
  try { return existsSync(dest) ? readFileSync(dest, 'utf8') : null } catch { return null }
}

export class GoalRolloverCoordinator {
  /** 源会话 id → 已发起交接 run、等待其收尾。 */
  private readonly awaitingHandoff = new Set<string>()

  constructor(private readonly host: GoalRolloverHost) {}

  isPending(id: string): boolean {
    return this.awaitingHandoff.has(id)
  }

  /** run 收尾（done 已落、running=false）后调用。返回本次是否推进了接力。 */
  async onRunSettled(id: string): Promise<boolean> {
    const record = this.host.getRecord(id)
    if (!record) { this.awaitingHandoff.delete(id); return false }
    if (this.awaitingHandoff.has(id)) {
      this.awaitingHandoff.delete(id)
      return this.spawnSuccessor(record)
    }
    const tracker = this.host.getTracker(id)
    if (!tracker || tracker.getStatus() !== 'paused' || tracker.getTerminalReason() !== GOAL_ROLLOVER_REASON) return false
    const ro = tracker.getRollover()
    if (!ro) return false
    if (!this.runLooksClean(record)) {
      this.notify(id, false, `接力中止：本轮 run 状态为 ${record.status}${record.pendingApprovals > 0 ? '，且有待审批项' : ''}，goal 保持暂停，可手动恢复。`, ro)
      return false
    }
    const res = this.host.requestHandoff(id, buildRolloverHandoffNote(ro.generation, ro.maxSessions))
    if (!res.ok) {
      this.notify(id, false, `接力中止：无法发起交接（${res.error ?? 'unknown'}），goal 保持暂停。`, ro)
      return false
    }
    this.awaitingHandoff.add(id)
    this.notify(id, true, `✦ 上下文达到 ${Math.round(ro.ratio * 100)}% 阈值，正在写交接文档，完成后将开新会话继续（第 ${ro.generation + 1}/${ro.maxSessions} 棒）。`, ro)
    return true
  }

  private runLooksClean(record: SessionRecord): boolean {
    return record.status === 'completed' && !record.archived && record.pendingApprovals === 0 && !record.unattendedHalt
  }

  private async spawnSuccessor(record: SessionRecord): Promise<boolean> {
    const id = record.id
    const tracker = this.host.getTracker(id)
    const ro = tracker?.getRollover()
    if (!tracker || !ro) return false
    if (!this.runLooksClean(record)) {
      this.notify(id, false, `接力中止：交接 run 状态为 ${record.status}，goal 保持暂停，可手动恢复。`, ro)
      return false
    }
    const handoff = (this.host.readHandoff ?? defaultReadHandoff)(record)
    if (!handoff || handoff.trim().length === 0) {
      this.notify(id, false, '接力中止：交接文档没有写出来，goal 保持暂停，可手动恢复或 /handoff 重试。', ro)
      return false
    }
    const remainingIterations = tracker.getMaxIterations() - tracker.getIteration()
    const wallBudget = tracker.getWallClockBudgetMs()
    const remainingWall = wallBudget === undefined ? undefined : wallBudget - tracker.getWallClockElapsedMs()
    if (remainingIterations <= 0 || (remainingWall !== undefined && remainingWall <= 0)) {
      this.notify(id, false, '接力中止：迭代或墙钟预算已用尽。', ro)
      return false
    }
    const generation = ro.generation + 1
    const baseTitle = (record.title ?? '').replace(/\s*·\s*接力 \d+\/\d+$/, '')
    const next = this.host.createSession({
      cwd: record.cwd,
      title: `${baseTitle || 'Goal'} · 接力 ${generation}/${ro.maxSessions}`,
      ...(record.model ? { model: record.model } : {}),
      ...(record.domain ? { domain: record.domain } : {}),
      ...(record.approvalMode ? { approvalMode: record.approvalMode } : {}),
    })
    if (!(await this.host.ensureAgent(next.id))) {
      this.notify(id, false, `接力中止：新会话 ${next.id} 的 agent 构建失败，goal 保持暂停。`, ro)
      return false
    }
    const criteria = tracker.getSuccessCriteria()
    const snap = await this.host.setGoal(next.id, {
      goal: tracker.getGoal(),
      maxIterations: remainingIterations,
      contextWindow: tracker.getContextWindow(),
      ...(remainingWall !== undefined ? { wallClockMs: remainingWall } : {}),
      ...(criteria.length > 0 ? { successCriteria: criteria } : {}),
      rollover: { ratio: ro.ratio, maxSessions: ro.maxSessions, generation },
    })
    if (!snap) {
      this.notify(id, false, `接力中止：新会话 ${next.id} 无法挂载 goal，goal 保持暂停。`, ro)
      return false
    }
    const started = this.host.run(next.id, buildRolloverKickoff({
      goal: tracker.getGoal(), generation, maxSessions: ro.maxSessions, fromSessionId: id, handoff,
    }))
    if (!started) {
      this.notify(id, false, `接力中止：新会话 ${next.id} 未能启动，goal 保持暂停。`, ro)
      return false
    }
    await this.host.cancelGoal(id)
    this.notify(id, true, `✦ 已接力到新会话 ${next.id}（第 ${generation}/${ro.maxSessions} 棒），本会话的 goal 已结束。`, ro, next.id)
    this.host.append(next.id, 'goal_rollover', {
      text: `✦ 接力自会话 ${id}（第 ${generation}/${ro.maxSessions} 棒）。`,
      ok: true, from: id, to: next.id, generation, maxSessions: ro.maxSessions,
    })
    return true
  }

  private notify(id: string, ok: boolean, text: string, ro: { generation: number; maxSessions: number }, to?: string): void {
    this.host.append(id, 'goal_rollover', {
      text, ok, from: id, ...(to ? { to } : {}), generation: ro.generation, maxSessions: ro.maxSessions,
    })
  }
}
