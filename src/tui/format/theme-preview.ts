import { ANSI, bg, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { renderCodeDiff } from './code-diff.js'

export function renderThemePreview(theme: RivetTheme, width: number, height: number, background: 'dark' | 'light' = 'dark'): string[] {
  const backdrop = bg(theme.primary.startsWith('#') ? (background === 'light' ? '#faf9f5' : '#191b20') : background === 'light' ? 'white' : 'black')
  const sample = renderCodeDiff('function greet() {\n  console.log("Hello, World!");\n}', 'function greet() {\n  console.log("你好，天枢");\n}', width, theme, background === 'light')
  const rows = [color('─'.repeat(Math.max(0, width)), theme.dim), ...sample, color('─'.repeat(Math.max(0, width)), theme.dim), color(truncateToDisplayWidth('代码配色预览 · 选择后应用', width), theme.muted)]
  return rows.slice(0, Math.max(0, height)).map(text => {
    const hasDiffBackground = /\x1b\[(?:48;|4[1-7]m)/.test(text)
    return hasDiffBackground ? text : backdrop + text.replaceAll(ANSI.RESET, ANSI.RESET + backdrop) + ' '.repeat(Math.max(0, width - displayWidth(text))) + ANSI.RESET
  })
}
