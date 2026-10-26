/**
 * thinking 详情回看仓。
 *
 * 经典主屏不逐段写入「已推理」摘要或正文；这里留存最近一次 thinking 的正文，
 * 供 /thinking（legacy ctrl+t）在只读 pager 中查看，不污染 scrollback。
 */

import { formatThinking } from '../format/thinking.js'
import type { RivetTheme } from '../theme.js'

export interface ThinkingReview {
  text: string
  elapsedMs: number
  domainId?: string
}

/** 留存上限：超长思考留尾部（结论在近处，与 live 区 tail 截断同向）。 */
const REVIEW_MAX_CHARS = 256_000

export class ThinkingReviewStore {
  private last: ThinkingReview | null = null

  save(review: ThinkingReview): void {
    const text = review.text.length > REVIEW_MAX_CHARS ? review.text.slice(-REVIEW_MAX_CHARS) : review.text
    if (!text.trim()) return
    this.last = { ...review, text }
  }

  peek(): ThinkingReview | null {
    return this.last
  }

  /** 取出并清空，供需要一次性消费详情的调用方使用。 */
  take(): ThinkingReview | null {
    const v = this.last
    this.last = null
    return v
  }

  clear(): void {
    this.last = null
  }
}

/** 详情文本：done 头 + 展开正文（逻辑行上限防一次性糊屏，超出仍走「上方省略」）。 */
export function formatThinkingReview(review: ThinkingReview, theme: RivetTheme): string[] {
  return formatThinking({
    text: review.text,
    elapsedMs: review.elapsedMs,
    done: true,
    expanded: true,
    maxLines: 400,
    domainId: review.domainId,
  }, theme)
}
