/**
 * 共享 overlay 面板骨架 — 所有全屏 overlay 渲染器统一复用。
 *
 * 两套风格：
 * - `subtle`（默认）：单条顶线、左对齐标题、开放正文与操作提示
 * - `full`：传统框线 + 居中标题（向后兼容，可选）
 *
 * 宽度对齐用显示列宽，遵守终端歧义字符宽度配置。
 */

import { displayWidth, ambiguousWideEnabled, truncateToDisplayWidth } from '../width.js'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

/** 选中项游标（bold primary）。全 overlay 统一，替代历史上的 ▸ / ❯。 */
export const CURSOR = '>'
/** 当前生效项标记（如当前会话 / 当前模型 / 当前主题）。 */
export const CURRENT_MARK = '●'

/** 边框风格枚举。 */
export type BorderStyle = 'subtle' | 'full'

/** 默认边框风格。 */
export const DEFAULT_BORDER: BorderStyle = 'subtle'

const textWidth = (text: string): number => displayWidth(text, { ambiguousAsWide: ambiguousWideEnabled() })
const innerWidth = (width: number): number => Math.max(0, width - 2)
export const frameInset = (width: number): number => width >= 60 ? 2 : width >= 4 ? 1 : 0
const boxedWidth = (width: number): number => Math.max(0, width - textWidth('│') * 2)
function horizontal(width: number): string {
  const cellWidth = textWidth('─')
  return '─'.repeat(Math.floor(Math.max(0, width) / cellWidth)) + ' '.repeat(Math.max(0, width) % cellWidth)
}

/** 顶边框（subtle 风格：细顶线；full 风格：┌─┐）。 */
export function frameTop(width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  if (s === 'full') {
    return color('┌' + horizontal(width - textWidth('┌┐')) + '┐', theme.dim)
  }
  return color(horizontal(width), theme.dim)
}

/** 底边框（subtle 风格：留白；full 风格：└─┘）。 */
export function frameBottom(width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  if (s === 'full') {
    return color('└' + horizontal(width - textWidth('└┘')) + '┘', theme.dim)
  }
  return ' '.repeat(Math.max(0, width))
}

/** 居中标题栏（full 风格用）。 */
export function frameTitleCenter(title: string, width: number, theme: RivetTheme): string {
  title = truncateToDisplayWidth(title, Math.max(0, boxedWidth(width) - 2), { ambiguousAsWide: ambiguousWideEnabled() })
  const remaining = Math.max(0, boxedWidth(width) - 2 - textWidth(title))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  // title 允许自带 ANSI。边框分段着色，避免 title 内部 RESET 把右侧填充和边框
  // 恢复成终端默认色；标题本身由调用方决定层级，框架只负责结构色。
  return color('│' + ' '.repeat(left) + ' ', theme.dim)
    + title
    + color(' ' + ' '.repeat(right) + '│', theme.dim)
}

/** 左对齐标题栏（subtle 风格用）。 */
export function frameTitleLeft(title: string, width: number, theme: RivetTheme): string {
  title = truncateToDisplayWidth(title, Math.max(0, innerWidth(width) - 2), { ambiguousAsWide: ambiguousWideEnabled() })
  const remaining = Math.max(0, innerWidth(width) - 2 - textWidth(title))
  return color('  ', theme.dim)
    + (title.includes('\x1b') ? title : color(title, theme.secondary, { bold: true }))
    + color(' '.repeat(remaining + 2), theme.dim)
}

/** @deprecated Use frameTitleLeft or frameTitleCenter explicitly. */
export const frameTitle = frameTitleLeft

/** 底部快捷键提示行。 */
export function frameFooter(hint: string, width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  const hintBudget = Math.max(0, innerWidth(width) - 2)
  let visibleHint = hint
  if (textWidth(visibleHint) > hintBudget) {
    let suffix = ''
    let suffixWidth = 0
    const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(hint), part => part.segment)
    for (let i = chars.length - 1; i >= 0; i--) {
      const cw = textWidth(chars[i]!)
      if (suffixWidth + cw + textWidth('…') > hintBudget) break
      suffix = chars[i]! + suffix
      suffixWidth += cw
    }
    visibleHint = '…' + suffix
  }
  if (s === 'full') {
    const padded = ` ${visibleHint} `
    const remaining = boxedWidth(width) - textWidth(padded)
    return color('│' + padded + ' '.repeat(Math.max(0, remaining)) + '│', theme.dim)
  }
  return frameLine(` ${color(visibleHint, theme.muted)}`, width, theme)
}

/** 开放内容行：左右留一列空白，正文按显示列宽补齐。 */
export function frameLine(text: string, width: number, theme: RivetTheme): string {
  const inset = frameInset(width), contentWidth = Math.max(0, width - inset * 2)
  text = truncateToDisplayWidth(text, contentWidth, { ambiguousAsWide: ambiguousWideEnabled() })
  const padding = Math.max(0, contentWidth - textWidth(text))
  return color(' '.repeat(inset), theme.dim) + text + ' '.repeat(padding) + color(' '.repeat(inset), theme.dim)
}

/** 组间留白。 */
export function frameDivider(width: number, theme: RivetTheme): string {
  return frameLine('', width, theme)
}

/** Keep every action intact; narrow panels reserve additional footer rows. */
export function frameHintRows(pairs: [key: string, action: string][], width: number, theme: RivetTheme): string[] {
  const budget = Math.max(1, width - 4)
  const rows: string[] = []
  for (const [key, action] of pairs) {
    const item = `${key}:${action}`
    const last = rows.length - 1
    if (last >= 0 && textWidth(`${rows[last]} · ${item}`) <= budget) rows[last] += ` · ${item}`
    else rows.push(item)
  }
  return rows.map(row => frameFooter(row, width, theme))
}

/**
 * 统一生成中文快捷键提示串。组间用 3 空格分隔，键与动作用 1 空格。
 * 例：keyHints([['↑↓','选择'],['Enter','确认'],['Esc','取消']])
 *   → "↑↓ 选择   Enter 确认   Esc 取消"
 */
export function keyHints(pairs: [key: string, action: string][]): string {
  return pairs.map(([k, a]) => `${k} ${a}`).join('   ')
}

// ── 向后兼容别名（overlay.ts 使用这些别名）──────────────────────

/** @deprecated Use frameTop(width, theme, 'full') for old behavior. */
export const formatBorder = frameTop
/** @deprecated Use frameBottom(width, theme, 'full') for old behavior. */
export const formatBottomBorder = frameBottom
/** @deprecated Use frameTitleCenter for old behavior. */
export const formatTitleBar = frameTitleCenter
/** @deprecated Use frameFooter(hint, width, theme, 'full') for old behavior. */
export const formatFooter = frameFooter
