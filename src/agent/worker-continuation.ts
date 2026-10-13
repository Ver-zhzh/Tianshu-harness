/** Worker failures are terminal. Legacy continuation exports remain disabled. */
import type { Usage } from '../api/types.js'
import type { WorkerResult } from './work-order.js'

export const MAX_BUDGET_CONTINUATIONS = 0
export const MAX_HANDS_EXTRA_RUNS = 0
export const HANDS_GATE_REPAIR_RESERVE = 0
export const STALL_TOOL_CALL_THRESHOLD = 3

export interface ContinuationInput {
  result: WorkerResult
  /** 已经续跑过几次（首轮结束时为 0）。 */
  attempt: number
  /** 父信号或 order controller 是否已经断开。 */
  aborted: boolean
  /** 写工（hands 角色）。 */
  isWrite: boolean
  /** 写工是否跑在共享 worktree 里。 */
  sharedWorktree: boolean
  /** 上一轮是否交回了会话消息——续跑靠它承接上下文。 */
  hasSessionMessages: boolean
  /** 上一轮的产出度量。缺席时不判（旧调用点）。
   *
   *  `waitingFirstByteMs` / `ttftSamples` 目前**只采集不判据**：绝对阈值需要健康
   *  环境下的基线，而现有样本全部采自一次性能风暴期间（席位平均每次工具调用间隔
   *  15–36s，非席位中位数 10.3s），拿它标定会把病态固化成标准。等积累到干净基线
   *  再决定判据形态——大概率是「相对该 profile 历史中位数退化 N 倍」而非绝对秒数。 */
  productivity?: { toolCalls: number; waitingFirstByteMs?: number; ttftSamples?: number }
}

export type ContinuationDecision =
  | { readonly proceed: true; readonly reason: 'max_turns' | 'timeout' }
  | { readonly proceed: false; readonly skipReason: string }

export function decideContinuation(_input: ContinuationInput): ContinuationDecision {
  return { proceed: false, skipReason: '固定执行策略：子代理失败即终止，自动续跑已禁用' }
}

export interface HandsContinuationInput {
  result: WorkerResult
  /** 已经续跑过几次（首轮结束时为 0）。 */
  attempt: number
  /** 本次 hands 会话里首轮之外已经用掉的 agent 轮次（与解析修复、闸门修复共用总账）。 */
  extraRunsUsed: number
  /** 父信号断开或 API 报错——不得再续。 */
  aborted: boolean
}

export function decideHandsContinuation(_input: HandsContinuationInput): ContinuationDecision {
  return { proceed: false, skipReason: '固定执行策略：写工失败即终止，自动续跑和闸门修复已禁用' }
}

/** 续跑轮的 objective——告诉它这是接着干，不是重来。 */
export function buildContinuationObjective(
  originalObjective: string,
  reason: 'max_turns' | 'timeout',
  attempt: number,
): string {
  const cause = reason === 'max_turns'
    ? '上一轮用尽了轮次预算，没能产出终局报告'
    : '上一轮用尽了时间预算，没能产出终局报告'
  return [
    `继续未完成的任务（第 ${attempt} 次续跑）。${cause}——你的完整对话历史就在上面，已经做过的工作不要重做。`,
    '先花一轮盘点：已经查清/改完了什么，还差什么。然后只补差的部分，尽快产出终局 JSON 报告。',
    '如果这一轮又要用尽预算，宁可提前收敛成一份诚实的部分报告，也不要再次被硬切断。',
    '',
    `原始目标：${originalObjective}`,
  ].join('\n')
}

/** 累加续跑各轮的 token 用量——只加两侧都可能缺的数值字段，缺项按 0 计。 */
export function mergeUsage(
  a: Usage | Partial<Usage> | undefined,
  b: Usage | Partial<Usage> | undefined,
): Usage | Partial<Usage> | undefined {
  if (!a) return b
  if (!b) return a
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<Exclude<keyof Usage, 'observation' | 'cacheCoverage' | 'estimated'>>)
  const merged: Partial<Usage> = {}
  for (const key of keys) {
    const left = a[key]
    const right = b[key]
    if (typeof left === 'number' || typeof right === 'number') {
      merged[key] = (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0)
    }
  }
  if (b.observation || a.observation) merged.observation = b.observation ?? a.observation
  return merged
}

/** 从累计值里扣掉已回种的份额（usage-ledger 对齐，2026-08-18）。
 *
 *  `runWorkerSession` 以 priorUsage 回种新 SessionContext 后，`getTotalUsage()`
 *  返回的是「种入 + 本轮」的累计值；对 coordinator / hands-session 这些用
 *  mergeUsage 逐轮累加的记账方，必须拿**差值**（本轮净增）——直接透传累计值
 *  会把种入份额重复计入派发总账。字段缺项按 0 计，负差值钳到 0（理论上
 *  不可能——种入的每个键都先经过 addSidePathUsage 加进了同一累计器）。 */
export function subtractUsage(
  total: Usage | Partial<Usage> | undefined,
  prior: Usage | Partial<Usage> | undefined,
): Partial<Usage> {
  const out: Partial<Usage> = {}
  if (!total) return out
  for (const key of Object.keys(total) as Array<Exclude<keyof Usage, 'observation' | 'cacheCoverage' | 'estimated'>>) {
    const t = total[key]
    if (typeof t !== 'number') continue
    const p = prior?.[key]
    out[key] = Math.max(0, t - (typeof p === 'number' ? p : 0))
  }
  return out
}

/** 在续跑产出的结果上留痕，让主控知道这份报告经过几轮才落地。 */
export function markContinued(result: WorkerResult, attempts: number, reason: 'max_turns' | 'timeout'): WorkerResult {
  const note = `budget-continuation: 首轮因${reason === 'max_turns' ? '轮次' : '时间'}预算耗尽被切断，自动续跑 ${attempts} 次后产出本报告`
  return result.risks.includes(note) ? result : { ...result, risks: [...result.risks, note] }
}
