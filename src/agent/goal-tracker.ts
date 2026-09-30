import { randomUUID } from 'crypto'
import { validateTransition } from './goal-state.js'
import type { GoalStatus, GoalActor, GoalBudgetLimits, GoalStateRecord } from './goal-state.js'

export interface GoalTrackerConfig {
  goal: string
  maxIterations: number
  contextWindow: number
  /** Concrete success criteria the completion judge checks against. */
  successCriteria?: string[]
  /** Max judge runs before accepting a self-declared completion (anti judge-reject loop). Default 3. */
  maxJudgeRuns?: number
  /** Wall-clock budget in milliseconds. undefined = unlimited. */
  wallClockMs?: number
  /** 可选：上下文跨会话接力（desktop/server 入口）。缺省 = 旧行为（95% 暂停）。 */
  rollover?: GoalRolloverConfig
}

/**
 * 上下文接力配置。ratio：估算上下文占窗口比例达到该值即请求接力（0.2–0.9）；
 * maxSessions：含首个会话在内的会话总数上限；generation：当前是第几个会话（1 起）。
 */
export interface GoalRolloverConfig {
  ratio: number
  maxSessions: number
  generation: number
}

/** 接力触发后 tracker 暂停时写入的 terminalReason——session 层据此识别接力请求。 */
export const GOAL_ROLLOVER_REASON = 'context_rollover'

/** 规范化接力配置：非法值返回 undefined（= 不启用），越界值夹紧到安全范围。 */
export function normalizeRolloverConfig(input: unknown, generation = 1): GoalRolloverConfig | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as { ratio?: unknown; maxSessions?: unknown }
  const ratio = typeof raw.ratio === 'number' && Number.isFinite(raw.ratio) ? raw.ratio : 0.5
  const maxSessions = typeof raw.maxSessions === 'number' && Number.isFinite(raw.maxSessions) ? Math.floor(raw.maxSessions) : 5
  if (maxSessions < 2) return undefined
  return { ratio: Math.min(0.9, Math.max(0.2, ratio)), maxSessions: Math.min(20, maxSessions), generation }
}

const DEFAULT_MAX_JUDGE_RUNS = 3

/** Lightweight verdict shape stored on the tracker for deliver_task to read.
 *  Mirrors the fields deliver_task needs — avoids importing the full type. */
export interface StoredGoalJudgeVerdict {
  overall: 'verified' | 'rejected' | 'inconclusive'
  criteriaMet: number
  criteriaUnmet: number
  criteriaTotal: number
  summary: string
}

/**
 * Build the goal-mode driver prompt. Single source of truth shared by the TUI
 * `/goal` slash command and the headless `--goal` CLI entry point, so the two
 * entry points can never drift in wording. The completion marker phrasing here
 * MUST stay in sync with GoalTracker.check()'s detection regex.
 */
export function buildGoalModePrompt(goal: string): string {
  return `[GOAL MODE] ${goal}\n\nYou are now in goal-driven mode. Work toward this goal continuously. When fully complete, output "GOAL ACHIEVED" on its own line. If you encounter a blocker you cannot resolve, output "GOAL BLOCKED" on its own line followed by a brief explanation.`
}

export interface GoalCheckResult {
  shouldContinue: boolean
  reason: 'achieved' | 'budget_exhausted' | 'context_limit' | 'context_rollover' | 'wall_clock_exhausted' | 'continue' | 'no_goal'
  iteration: number
}

/** @deprecated Use GoalStatus values directly. Kept for backward compat in deliver_task. */
export type GoalDeactivationReason = 'achieved' | 'budget_exhausted' | 'context_limit' | 'cancelled'

export class GoalTracker {
  private _status: GoalStatus = 'active'
  private _iteration = 0
  private readonly _goal: string
  private readonly _maxIterations: number
  private readonly _contextWindow: number
  private _terminalReason: string | null = null
  private _successCriteria: string[]
  private readonly _maxJudgeRuns: number
  private _judgeRuns = 0
  private _lastVerdict: StoredGoalJudgeVerdict | null = null

  private _goalId: string
  private readonly _wallClockBudgetMs?: number
  private _wallClockAccumMs = 0
  private _wallClockResumedAt: number
  private readonly _rollover?: GoalRolloverConfig

  constructor(config: GoalTrackerConfig) {
    this._goal = config.goal
    this._maxIterations = config.maxIterations
    this._contextWindow = config.contextWindow
    this._successCriteria = config.successCriteria ? [...config.successCriteria] : []
    this._maxJudgeRuns = config.maxJudgeRuns ?? DEFAULT_MAX_JUDGE_RUNS
    this._goalId = randomUUID()
    this._wallClockBudgetMs = config.wallClockMs
    this._wallClockResumedAt = Date.now()
    if (config.rollover) this._rollover = { ...config.rollover }
  }

  /** 接力配置（未启用为 undefined）。 */
  getRollover(): GoalRolloverConfig | undefined {
    return this._rollover ? { ...this._rollover } : undefined
  }

  getContextWindow(): number {
    return this._contextWindow
  }

  /** True only when status === 'active'. Existing callers rely on this semantic. */
  isActive(): boolean {
    return this._status === 'active'
  }

  /** Current lifecycle status. */
  getStatus(): GoalStatus {
    return this._status
  }

  /** Persistent unique id for this goal instance. */
  getGoalId(): string {
    return this._goalId
  }

  getGoal(): string {
    return this._goal
  }

  getIteration(): number {
    return this._iteration
  }

  getMaxIterations(): number {
    return this._maxIterations
  }

  /** Wall-clock budget in ms, or undefined if unlimited. */
  getWallClockBudgetMs(): number | undefined {
    return this._wallClockBudgetMs
  }

  /** Elapsed wall-clock time (accumulated + current active interval). */
  getWallClockElapsedMs(): number {
    if (this._status === 'active') {
      return this._wallClockAccumMs + (Date.now() - this._wallClockResumedAt)
    }
    return this._wallClockAccumMs
  }

  /** Reason the goal entered a terminal/non-active state, or null if active. */
  getTerminalReason(): string | null {
    return this._terminalReason
  }

  /** @deprecated Use getStatus() === 'complete' instead. */
  getDeactivationReason(): GoalDeactivationReason | null {
    if (this._status === 'active') return null
    if (this._terminalReason === 'achieved') return 'achieved'
    if (this._terminalReason === 'budget_exhausted') return 'budget_exhausted'
    if (this._terminalReason === 'context_limit') return 'context_limit'
    if (this._terminalReason === 'cancelled') return 'cancelled'
    return null
  }

  /** True when the goal reached 'complete' status. Best-effort signal for
   *  deliver_task to auto-trigger L3 review on the final commit. */
  isGoalAchieved(): boolean {
    return this._status === 'complete'
  }

  // ── Status transitions ──────────────────────────────────────────

  /** Pause the goal (active → paused). Can be resumed via resume(). */
  pause(reason?: string, actor: GoalActor = 'runtime'): void {
    this.transitionTo('paused', actor)
    this._terminalReason = reason ?? `Paused by ${actor}`
    this.foldWallClock()
  }

  /** Mark the goal as blocked (active → blocked). Can be resumed via resume(). */
  markBlocked(reason: string, actor: GoalActor = 'model'): void {
    this.transitionTo('blocked', actor)
    this._terminalReason = reason
    this.foldWallClock()
  }

  /** Mark the goal as complete (active → complete). Terminal — cannot resume. */
  markComplete(actor: GoalActor = 'model'): void {
    this.transitionTo('complete', actor)
    this._terminalReason = 'Goal achieved'
    this.foldWallClock()
  }

  /** Resume the goal (paused|blocked → active). Resets the wall-clock timer. */
  resume(actor: GoalActor = 'user'): void {
    this.transitionTo('active', actor)
    this._wallClockResumedAt = Date.now()
    this._terminalReason = null
  }

  /** Cancel the goal — sets terminal state so continuation stops.
   *  Caller should also detach via setGoalTracker(null). */
  cancel(): void {
    this._status = 'complete'
    this._terminalReason = 'cancelled'
    this.foldWallClock()
  }

  /** @deprecated Use pause()/markBlocked()/markComplete()/cancel() instead.
   *  Kept for backward compat with turn-orchestrator's existing call sites. */
  deactivate(reason?: GoalDeactivationReason): void {
    if (reason === 'achieved') {
      this._status = 'complete'
      this._terminalReason = 'Goal achieved'
    } else if (reason === 'budget_exhausted') {
      this._status = 'blocked'
      this._terminalReason = 'budget_exhausted'
    } else if (reason === 'context_limit') {
      this._status = 'paused'
      this._terminalReason = 'context_limit'
    } else {
      this.cancel()
    }
    this.foldWallClock()
  }

  // ── Internal ────────────────────────────────────────────────────

  private transitionTo(target: GoalStatus, _actor: GoalActor): void {
    if (!validateTransition(this._status, target)) {
      throw new Error(`Invalid goal transition: ${this._status} → ${target}`)
    }
    this._status = target
  }

  /** Fold the current active interval into the accumulated wall-clock. */
  private foldWallClock(): void {
    if (this._status === 'active') {
      this._wallClockAccumMs += Date.now() - this._wallClockResumedAt
    }
  }

  // ── Check & budget ──────────────────────────────────────────────

  /** Check if the goal is achieved or limits are hit. Does NOT mutate state. */
  check(streamedText: string, estimatedTokens: number, aborted: boolean): GoalCheckResult {
    if (this._status !== 'active') {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (aborted) {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (/GOAL ACHIEVED|目标已?完成|任务已?完成/i.test(streamedText)) {
      return { shouldContinue: false, reason: 'achieved', iteration: this._iteration }
    }

    if (this._iteration >= this._maxIterations) {
      return { shouldContinue: false, reason: 'budget_exhausted', iteration: this._iteration }
    }

    // 接力：还有会话名额时，在阈值处交棒而不是拖到 95% 暂停。名额用尽则
    // 退回旧语义（继续跑到 95% 再暂停），不会无限开会话。
    const ro = this._rollover
    if (ro && ro.generation < ro.maxSessions && estimatedTokens >= this._contextWindow * ro.ratio) {
      return { shouldContinue: false, reason: 'context_rollover', iteration: this._iteration }
    }

    if (estimatedTokens > this._contextWindow * 0.95) {
      return { shouldContinue: false, reason: 'context_limit', iteration: this._iteration }
    }

    if (this._wallClockBudgetMs !== undefined && this.getWallClockElapsedMs() >= this._wallClockBudgetMs) {
      return { shouldContinue: false, reason: 'wall_clock_exhausted', iteration: this._iteration }
    }

    return { shouldContinue: true, reason: 'continue', iteration: this._iteration }
  }

  /** Advance iteration counter. Called when a continuation is decided. */
  advanceIteration(): void {
    this._iteration++
  }

  // ── Judge fields (unchanged) ────────────────────────────────────

  /** Success criteria the judge verifies against (may be empty → wide judgment). */
  getSuccessCriteria(): string[] {
    return [...this._successCriteria]
  }

  /** Set the criteria extracted from the goal (called once at goal start). */
  setSuccessCriteria(criteria: string[]): void {
    this._successCriteria = [...criteria]
  }

  /** Number of times the completion judge has run for this goal. */
  getJudgeRuns(): number {
    return this._judgeRuns
  }

  /** Cap on judge runs; once reached a self-declared completion is accepted unverified. */
  getMaxJudgeRuns(): number {
    return this._maxJudgeRuns
  }

  /** Record that the judge ran once (called on every judge invocation). */
  recordJudgeRun(): void {
    this._judgeRuns++
  }

  /** Store the last judge verdict for deliver_task to read as evidence. */
  setLastVerdict(v: StoredGoalJudgeVerdict): void {
    this._lastVerdict = v
  }

  /** Last judge verdict, or null if the judge hasn't run. */
  getLastVerdict(): StoredGoalJudgeVerdict | null {
    return this._lastVerdict
  }

  // ── Persistence ─────────────────────────────────────────────────

  /** Serialize to a plain record for persistence. Folds wall-clock first. */
  toRecord(): GoalStateRecord {
    this.foldWallClock()
    const budgetLimits: GoalBudgetLimits = {
      maxIterations: this._maxIterations,
      contextWindow: this._contextWindow,
      ...(this._wallClockBudgetMs !== undefined ? { wallClockMs: this._wallClockBudgetMs } : {}),
    }
    return {
      goalId: this._goalId,
      objective: this._goal,
      status: this._status,
      iterationsUsed: this._iteration,
      wallClockAccumMs: this._wallClockAccumMs,
      budgetLimits,
      ...(this._terminalReason ? { terminalReason: this._terminalReason } : {}),
      ...(this._successCriteria.length > 0 ? { completionCriterion: this._successCriteria.join('\n') } : {}),
      ...(this._rollover ? { rollover: { ...this._rollover } } : {}),
      savedAt: Date.now(),
    }
  }

  /** Reconstruct a GoalTracker from a persisted record.
   *  normalizeAfterResume: active → paused (kimi-code mode) so the user must
   *  explicitly resume after a session restart. */
  static fromRecord(
    record: GoalStateRecord,
    extra?: { successCriteria?: string[]; maxJudgeRuns?: number },
  ): GoalTracker {
    const tracker = new GoalTracker({
      goal: record.objective,
      maxIterations: record.budgetLimits.maxIterations,
      contextWindow: record.budgetLimits.contextWindow,
      ...(record.budgetLimits.wallClockMs !== undefined ? { wallClockMs: record.budgetLimits.wallClockMs } : {}),
      ...(record.completionCriterion ? { successCriteria: record.completionCriterion.split('\n') } : {}),
      ...(extra?.successCriteria ? { successCriteria: extra.successCriteria } : {}),
      ...(extra?.maxJudgeRuns !== undefined ? { maxJudgeRuns: extra.maxJudgeRuns } : {}),
      ...(record.rollover ? { rollover: record.rollover } : {}),
    })
    // Restore mutable state
    tracker._goalId = record.goalId
    tracker._iteration = record.iterationsUsed
    tracker._wallClockAccumMs = record.wallClockAccumMs
    // normalizeAfterResume: active → paused (the process that wrote 'active' is gone)
    tracker._status = record.status === 'active' ? 'paused' : record.status
    tracker._terminalReason =
      record.status === 'active' ? 'Paused after session resume' : (record.terminalReason ?? null)
    return tracker
  }
}
