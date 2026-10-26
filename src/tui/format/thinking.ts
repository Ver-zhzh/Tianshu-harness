/**
 * T9 格式化函数 — thinking 指示器。
 *
 * 纯函数，从 `thinking.tsx` 的渲染逻辑提取。
 */

import { color } from '../engine/ansi.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { hardWrapToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'

export interface FormatThinkingInput {
  /** thinking 文本内容 */
  text: string
  /** 已用时间（毫秒） */
  elapsedMs: number
  /** 包含头部状态行（凝思中…）。默认 true。流式渲染时 spinner 已显示状态，可设 false。 */
  header?: boolean
  /** 展开正文内容。默认 false。 */
  expanded?: boolean
  /** 正文最大行数。默认 8。详情展示时可加大。 */
  maxLines?: number
  /**
   * 正文最大**显示**行数（wrap 之后）。给定时取代 `maxLines`。
   *
   * 推理文本多是长句，窄终端上一个逻辑行会 wrap 成三四个显示行——按逻辑行封顶
   * 时 8 行能占到二十个显示行，而 live 区的高度峰值会被定高视口固化成输入框
   * 上方的常驻空白。需要同时给 `columns` 才能度量。
   *
   * 正文按 wide 上界（ambiguous 按 2 列）硬折行成段输出：每段 ≤ columns-1 宽，
   * 在 narrow/wide 任何终端都恰占 1 显示行——LiveEngine.rowsForLine 恒精确，
   * 相对回顶不欠行（CJK 终端 ambiguous 折行导致 spinner 残影的根修）。
   */
  maxRows?: number
  /** 终端列数，`maxRows` 生效时用于度量 wrap。 */
  columns?: number
  /** 推理已完成（如详情视图）。头部用过去式「✶ 已推理」而非进行时「◐ 凝思中…」。默认 false。 */
  done?: boolean
  /** done 头部附带回看提示（如 `· ctrl+t 回看`）——仅在调用方确实留存了正文时传。 */
  reviewHint?: string
  /** 当前激活的星域 ID（如 qiming / changgeng / wenqu / tianshu 等） */
  domainId?: string
}

const DEFAULT_MAX_LINES = 8

/**
 * 显示层剥 `**emphasis**` 标记：thinking 是模型原始 markdown，live 区不跑完整
 * markdown 渲染，裸 `**` 是纯粹的视觉噪音（grok-build 渲染 markdown，我们取
 * 低成本的 emphasis 剥离）。
 *
 * 保守边界（宁留不剥）：
 * - 开标记前不能是单词字符、星号或斜杠——glob 双星段（目录间的连续两星）与
 *   x**y**z 这类代码形态一律不动；
 * - 标记必须**紧贴**内容（`**文本**`，前后各加一条非空白断言）：星号两侧留白的
 *   形态一律不动——`2 ** 3 ** 4`（幂运算/通配表达）与 `** A **`（不规范加粗）
 *   因此保住，代价是不规范写法不渲染，符合"宁留不剥"；
 * - 内容不含星号（glob 片段永远不配对成功）；
 * - `__`/`~~`/反引号不处理——`__init__` 这类 dunder 误伤代价比收益大。
 */
// eslint-disable-next-line no-control-regex
const EMPHASIS_RE = /(?<![\w\/*])\*\*(?=\S)([^*\n]{1,200}?)(?<=\S)\*\*(?![\w*])/g

function stripEmphasisForDisplay(line: string): string {
  return line.includes('**') ? line.replace(EMPHASIS_RE, '$1') : line
}

/**
 * 格式化 thinking 指示器为 ANSI 行数组（星域符印与多层对比色）。
 */
export function formatThinking(input: FormatThinkingInput, theme: RivetTheme): string[] {
  if (!input.text) return []

  const lines: string[] = []
  const textLines = input.text.split('\n').filter(l => l.trim().length > 0).map(stripEmphasisForDisplay)
  const useAscii = useAsciiGlyphs()

  // ── 获取当前星域元数据与符印 ──────────────────────────────────
  const domainId = input.domainId ?? 'tianshu'
  const domain = starDomainRegistry.get(domainId) ?? starDomainRegistry.get('tianshu')
  
  // 兜底用 ◇（「未定/自定义域」的中性符，与 glance-bar 的自定义域展示同口径），
  // 不用 ✦——那是品牌星，星域缺失时打一颗品牌星是语义污染。
  const rawGlyph = domain?.uiPersona?.glyph ?? '◇'
  const accentKey = domain?.uiPersona?.accent ?? 'primary'
  const accentColor = (theme as Record<string, any>)[accentKey] ?? theme.primary
  const domainName = domain?.name ?? '天枢'

  // ── Header line ─────────────────────────────────────────────
  if (input.header !== false) {
    if (input.done) {
      const secs = Math.round(input.elapsedMs / 1000)
      const glyphStr = useAscii ? '*' : rawGlyph
      const lineInfo = textLines.length > 0 ? ` · ${textLines.length} 行` : ''
      const hint = input.reviewHint ? color(` · ${input.reviewHint}`, theme.dim) : ''

      const headSymbol = color(glyphStr, accentColor, { bold: true })
      const headLabel = color(`${domainName}·已推理`, theme.secondary)
      const headMeta = color(` · ${secs}s${lineInfo}`, theme.dim)
      lines.push(`${headSymbol} ${headLabel}${headMeta}${hint}`)
    } else {
      const statusLabel = getThinkingStatus(input.elapsedMs)
      const lineInfo = textLines.length > 0 ? ` · ${textLines.length} 行` : ''
      const glyphStr = useAscii ? '~' : rawGlyph
      
      const headSymbol = color(glyphStr, accentColor, { bold: true })
      const headLabel = color(`${domainName}·${statusLabel}`, theme.primary)
      const headMeta = color(`${lineInfo}`, theme.dim)
      lines.push(`${headSymbol} ${headLabel}${headMeta}`)
    }
  }

  // ── Content lines (保留最新若干行的 tail，带淡色树脉前缀) ────────
  if (input.expanded && textLines.length > 0) {
    const prefix = color('│ ', theme.dim)
    if (input.maxRows != null && input.columns) {
      // 硬折行路径：每段恰占 1 显示行（见 maxRows 注释），段数即显示行数。
      const { kept, omitted } = tailSegmentsWithinRows(textLines, input.maxRows, input.columns)
      if (omitted > 0) {
        lines.push(`${prefix}${color(`… 上方省略 ${omitted} 行`, theme.dim)}`)
      }
      for (const seg of kept) {
        lines.push(`${prefix}${color(seg, theme.muted)}`)
      }
    } else {
      const kept = textLines.slice(-(input.maxLines ?? DEFAULT_MAX_LINES))
      const omitted = textLines.length - kept.length
      if (omitted > 0) {
        lines.push(`${prefix}${color(`… 上方省略 ${omitted} 行`, theme.dim)}`)
      }
      for (const line of kept) {
        lines.push(`${prefix}${color(line, theme.muted)}`)
      }
    }
  }

  return lines
}

/**
 * 自尾部向前按「整逻辑行」收取，使其硬折行后的显示行数不超过 budget。
 * 至少保留 1 个逻辑行——哪怕它自己就超预算，空的推理区比截没了更难理解。
 *
 * 折段宽度 = columns - 3（'│ ' 前缀 2 列 + 1 列余量，与 clampLine 同口径），
 * 按 wide 上界度量：ambiguous 符号（——……“”）在 CJK 终端按 2 列渲染时，
 * 终端实际行数与 LiveEngine.rowsForLine（narrow 默认）会出现偏差 → 回顶欠擦 →
 * 旧帧顶行（spinner）泄漏成残影。硬折行后每段 ≤ columns-1 wide，任何终端
 * 每段恰占 1 显示行，引擎行数追踪恒精确。
 */
function tailSegmentsWithinRows(
  textLines: readonly string[],
  budget: number,
  columns: number,
): { kept: string[]; omitted: number } {
  const limit = Math.max(1, budget)
  const segWidth = Math.max(1, columns - 3)
  const kept: string[] = []
  let rows = 0
  let keptLines = 0
  for (let i = textLines.length - 1; i >= 0; i--) {
    const segs = hardWrapToDisplayWidth(textLines[i]!, segWidth, { ambiguousAsWide: true })
    if (keptLines > 0 && rows + segs.length > limit) break
    kept.unshift(...segs)
    rows += segs.length
    keptLines++
    if (rows >= limit) break
  }
  return { kept, omitted: textLines.length - keptLines }
}

function getThinkingStatus(elapsedMs: number): string {
  const s = Math.round(elapsedMs / 1000)
  if (s < 30) return `凝思中… ${s}s`
  if (s < 90) return `融汇上下文… ${s}s`
  if (s < 180) return `深沉长考中… ${s}s`
  return `长考中 — Ctrl+C 终止 (${Math.floor(s / 60)}m)`
}
