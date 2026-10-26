/** Behavioral expectations; recovery results are audited independently. */
export type AdvisoryExpectation =
  | {
      kind: 'tool_appears'
      tools: string[]
      /** 可选 target 约束 — 工具的 target 需包含此片段（如特定文件路径） */
      targetIncludes?: string
      /** Recovery result is audited separately from behavior adoption. */
      recoveryTarget?: string
      withinTurns?: number
    }
  | { kind: 'verify_attempted'; withinTurns?: number }
  | { kind: 'file_touched'; paths: string[]; withinTurns?: number }
  | { kind: 'pattern_absent'; path: string; needles: string[]; withinTurns?: number }
  | {
      /** 改道核销（B1/M4，2026-07-23 信号互扰治理；2026-10-10 方向 3 收紧）：
       *  投递之后、同一策略周期内**首次**出现的工具族 → adopted；周期基线内已见
       *  的族不算改道（换文件、只读 bash→read_file 这类同族换外衣都不算）。族映射
       *  与周期边界见 course-correction-tracker.ts，核销账本在 AdvisoryReadback。
       *  旧实现是「送达前 3 轮未见过的 工具族×文件面 粗签名」——文件面进签名 +
       *  滚动窗口让活跃轨迹每轮自证改道，假 adopted 反复清零静默环。 */
      kind: 'course_changed'
      withinTurns?: number
    }
