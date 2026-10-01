/**
 * 折叠/截断提示的单一事实来源。
 *
 * 渲染端（tool-card / collapsed-*）产出这些标记，scrollback pager 解析端
 * （scrollback-transcript.ts）反向识别它们来判定「这条消息被截断过、可展开」。
 * 两边各写各的字符串会在文案调整时静默失联——pager 的展开入口消失而没有任何报错，
 * 所以放在这里共享。
 */

import type { FrontendPreferences } from './frontend-preferences.js'
import { getKeybindingRows } from './keybindings.js'

/** 折叠 N 行的提示：`… +25 行 · ctrl+o 展开`。 */
export function truncationHint(omitted: number, unit = '行', expandHint = EXPAND_HINT): string {
  return `… +${omitted} ${unit} · ${expandHint}`
}

/** 无计数的展开提示（diff 摘要等已自带规模描述的场景）。 */
export const EXPAND_HINT = 'ctrl+o 展开'

/** The command fallback also remains available when history or expansion is rebound. */
export function toolExpandHint(preferences: FrontendPreferences): string {
  const key = getKeybindingRows(preferences).find(row => row.action === 'lastTool')?.key
  return key ? `${key.replace('_', '+')} 展开` : '/pager → Enter 查看详情'
}

/**
 * 截断标记识别。生产提示与历史兼容提示均可识别：
 *  - `ctrl+o 展开`（EXPAND_HINT）：`… +25 行 · ctrl+o 展开`、`… +12 行 diff ·
 *    ctrl+o 展开`（单位可带空格）、裸提示 `ctrl+o 展开完整 diff`
 *  - `[Ctrl+O]`：历史英文标记 `… +N lines [Ctrl+O]` / `… [Ctrl+O]`——`/resume`
 *    载入的旧会话 scrollback 里仍是英文形态，不认会让旧会话的展开入口失效。
 *  - 重绑定的 ctrl/alt 字母展开键，以及标准键位的 `/pager → Enter 查看详情`。
 */
export const TRUNCATION_MARKER_RE =
  /(?:ctrl|alt)\+[a-z]\s*展开|\/pager\s*→\s*Enter|\[Ctrl\+O\]/i
