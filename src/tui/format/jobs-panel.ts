import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { formatElapsed } from '../worker-panel-model.js'
import type { JobRow } from '../job-registry.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { followListWindow } from './overlay.js'
import { frameTop, frameTitleLeft, frameLine, frameHintRows, frameBottom, CURSOR } from './overlay-frame.js'

/** Flatten whitespace (incl. \n \r \t) then truncate — LiveEngine row-count safety. */
function snippet(text: string, max = 60): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function statusGlyph(row: JobRow): string {
  if (!row.terminal) return '◐'
  if (row.status === 'killed') return '⊗'
  return row.exitCode === 0 ? '✓' : '✗'
}

function statusColor(row: JobRow, theme: RivetTheme): string {
  if (!row.terminal) return theme.success
  if (row.status === 'killed') return theme.warning
  return row.exitCode === 0 ? theme.success : theme.error
}

/**
 * Full-screen `/jobs` overlay: one row per background job. Running jobs first
 * (JobRegistry.rows() already sorts), terminal after. selectedIndex draws the
 * cursor marker. Framework-agnostic — ansi/theme only.
 */
export function renderJobsOverlay(
  rows: JobRow[],
  columns: number,
  height: number,
  theme: RivetTheme,
  selectedIndex: number,
): string[] {
  const out = [frameTop(columns, theme), frameTitleLeft(`后台任务 · ${rows.length}`, columns, theme)]
  const selected = rows.length ? Math.max(0, Math.min(selectedIndex, rows.length - 1)) : -1
  const footerPairs: [string, string][] = [['↑↓', '选择']]
  if (selected >= 0) footerPairs.push(['Enter', '查看日志'])
  if (rows[selected] && !rows[selected]!.terminal) footerPairs.push(['x', '停止选中Job'])
  footerPairs.push(['Esc', '关闭'])
  const footer = frameHintRows(footerPairs, columns, theme)
  const bodyRows = Math.max(1, height - 3 - footer.length)
  const start = followListWindow(selected, rows.length, bodyRows)
  const visible = rows.slice(start, start + bodyRows)
  visible.forEach((row, at) => {
    const i = start + at
    const sel = i === selectedIndex
    const marker = sel ? CURSOR : ' '
    const glyph = statusGlyph(row)
    const c = statusColor(row, theme)
    const dot = row.unread ? color('●', theme.warning) : ' '
    const elapsed = formatElapsed(row.terminal && row.endedAt ? row.endedAt - row.startedAt : Date.now() - row.startedAt)
    const state = row.terminal
      ? (row.status === 'killed' ? '已停止' : `退出码${row.exitCode ?? '?'}`)
      : '运行中'
    const head = `${color(marker, theme.primary, { bold: sel })}${dot}${color(glyph, c)} ${color(row.id, sel ? theme.primary : theme.secondary)} ${color(state, c)} ${color(elapsed, theme.dim)}`
    const remaining = Math.max(0, columns - 4 - displayWidth(head))
    const detail = truncateToDisplayWidth([snippet(row.command), row.lastLine ? snippet(row.lastLine, 40) : ''].filter(Boolean).join(' · '), remaining)
    out.push(frameLine(`${head}${detail ? `  ${color(detail, theme.muted)}` : ''}`, columns, theme))
  })
  if (!rows.length) out.push(frameLine(color('  没有后台任务。', theme.muted), columns, theme))
  while (out.length < 2 + bodyRows) out.push(frameLine('', columns, theme))
  out.push(...footer, frameBottom(columns, theme))
  return out
}
