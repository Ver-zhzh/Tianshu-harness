import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { frameInset, frameLine, frameTop } from './overlay-frame.js'

export function panelHeader(title: string, tabs: string[], selected: number, width: number, theme: RivetTheme): string[] {
  const budget = Math.max(1, width - frameInset(width) * 2 - displayWidth(title) - 3)
  let start = 0, end = tabs.length
  const size = () => displayWidth(tabs.slice(start, end).join('   ')) + 2
  while (size() > budget && end - start > 1) {
    if (selected - start > end - selected - 1) start++
    else end--
  }
  const labels = tabs.slice(start, end).map((tab, i) => start + i === selected
    ? ANSI.REVERSE + ` ${truncateToDisplayWidth(tab, Math.max(1, budget - 2))} ` + ANSI.RESET
    : color(tab, theme.muted)).join('   ')
  return [frameTop(width, theme), frameLine(color(title, theme.secondary, { bold: true }) + (tabs.length ? '   ' + labels : ''), width, theme)]
}

export function panelSearch(query: string, active: boolean, placeholder: string, width: number, theme: RivetTheme): string[] {
  const available = Math.max(1, width - frameInset(width) * 2 - 4)
  const budget = Math.max(0, available - (active ? 1 : 0))
  const text = query ? truncateToDisplayWidth(query, budget) : color(truncateToDisplayWidth(placeholder, budget), theme.muted)
  return [frameLine(color('╭' + '─'.repeat(available + 2) + '╮', theme.dim), width, theme),
    frameLine(color('│ ', theme.dim) + text + (active ? color('▏', theme.primary) : '') + ' '.repeat(Math.max(0, available - displayWidth(text) - (active ? 1 : 0))) + color(' │', theme.dim), width, theme),
    frameLine(color('╰' + '─'.repeat(available + 2) + '╯', theme.dim), width, theme)]
}

export function numberedChoice(text: string, index: number, selected: boolean, theme: RivetTheme, current = false): string {
  return color(`${selected ? '❯' : ' '} ${index + 1}. ${text}${current ? ' ✓' : ''}`, selected ? theme.primary : theme.secondary, selected ? { bold: true } : undefined)
}
