import type { ContentBlock } from '../api/types.js'
import type { SrClass } from './context.js'

/**
 * 模型可见的打断标记（英文与其余 system-reminder 一致）。含 `[interrupted]`
 * 前缀便于 history-invariant 探针识别。语义对齐 Codex `handle_task_abort` /
 * Claude Code `[Request interrupted by user]`：告诉模型「上一条被用户打断、
 * 紧邻上文是 stop 前的部分输出、不要自行续跑，等新指示」。
 */
export const INTERRUPT_MARKER_TEXT =
  '[interrupted] The user stopped the previous reply at this point; any assistant text immediately above is the partial output produced before the stop. Do not resume or continue the interrupted task on your own — wait for and follow the user\'s next instruction.'

export interface InterruptionDeps {
  removeLastMessage: () => void
  addAssistantBlocks: (blocks: ContentBlock[]) => void
  appendSystemReminder: (content: string, cls?: SrClass, opts?: { mergeTail?: boolean }) => void
}

export interface InterruptionParams {
  partialText: string
  assistantResponded: boolean
  userMessageConsumed: boolean
  /** abort 来源标签（loop.abortReason()）：仅 watchdog 中止有值；用户 Stop 为 undefined。 */
  abortTag?: string
  markerEnabled: boolean
}

/**
 * 打断时的历史处理。返回本轮是否已有 assistant 消息（供调用方沿用 assistantResponded）。
 * - 开关关 / watchdog 中止：旧行为——无回复则撤回 user 消息（自动续跑链路依赖此形状）。
 * - 用户打断：保留 user 消息；有 partial 文本则作为 assistant text 落历史（用户已看到的
 *   文字必须持久化，同 turn-orchestrator 的 contract repair 原则）；再追加标记。标记不得
 *   改写已发送的 user 消息，因此标记始终独立追加。userMessageConsumed 表示压缩
 *   消费了原消息，不表示请求已发送；普通流中止时它仍可能为 false。
 * - 只追加 text 块，绝不追加 tool_use：中止时 collectedBlocks 可能含未配对 tool_use，
 *   进历史会让下一请求 400。
 */
export function recordInterruption(deps: InterruptionDeps, p: InterruptionParams): boolean {
  const watchdog = p.abortTag?.startsWith('watchdog') ?? false
  if (!p.markerEnabled || watchdog) {
    if (!p.assistantResponded && !p.userMessageConsumed) deps.removeLastMessage()
    return p.assistantResponded
  }
  let responded = p.assistantResponded
  const text = p.partialText.trimEnd()
  if (text.length > 0) {
    deps.addAssistantBlocks([{ type: 'text', text }])
    responded = true
  }
  deps.appendSystemReminder(INTERRUPT_MARKER_TEXT, 'functional', { mergeTail: false })
  return responded
}

/** history-invariant 探针用：该 user 消息是否只是（或以）打断标记结尾。 */
export function endsWithInterruptMarker(content: string): boolean {
  return content.includes(INTERRUPT_MARKER_TEXT)
}
