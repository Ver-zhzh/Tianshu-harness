import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth } from '../width.js'
import { wrapReadingText } from './reading-layout.js'

/** Wrap cell contents without hiding values; tables use the terminal width. */
export function renderTable(rows: string[][], columns: number, theme: RivetTheme): string[] {
  const count = Math.max(0, ...rows.map(row => row.length))
  if (!count) return []
  const available = Math.max(1, columns - 1) - 4 - 3 * (count - 1)
  if (available < count) return rows.flatMap(row => wrapReadingText(row.join(' · '), Math.max(1, columns - 1)))
  const widths = Array.from({ length: count }, (_, i) => Math.max(1, ...rows.map(row => displayWidth(row[i] ?? ''))))
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    const largest = widths.indexOf(Math.max(...widths))
    widths[largest]!--
  }
  const rule = (left: string, join: string, right: string) => color(left + widths.map(width => '─'.repeat(width + 2)).join(join) + right, theme.dim)
  const output = rows.flatMap((row, index) => {
    const cells = widths.map((width, i) => wrapReadingText(row[i] ?? '', width))
    const output = Array.from({ length: Math.max(...cells.map(cell => cell.length)) }, (_, line) => {
      const content = cells.map((cell, i) => { const value = cell[line] ?? ''; return value + ' '.repeat(Math.max(0, widths[i]! - displayWidth(value))) }).join(' │ ')
      return '│ ' + content + ' │'
    })
    return index === 0 ? [...output.map(line => color(line, theme.secondary, { bold: true })), rule('├', '┼', '┤')] : output
  })
  return [rule('┌', '┬', '┐'), ...output, rule('└', '┴', '┘')]
}
