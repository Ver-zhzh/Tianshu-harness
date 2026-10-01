import type { ReadStream, WriteStream } from 'node:tty'
import { getTheme, resolveThemeEntry } from '../tui/theme.js'
import { renderThemePreview } from '../tui/format/theme-preview.js'
import { frameHintRows } from '../tui/format/overlay-frame.js'
import { wrapReadingText } from '../tui/format/reading-layout.js'
import { formatWelcomeBrand } from '../tui/format/welcome.js'
import { color } from '../tui/engine/ansi.js'
import { frameInset } from '../tui/format/overlay-frame.js'
import { truncateToDisplayWidth } from '../tui/width.js'

export interface AppearanceSetupResult { themeName: string; usedDefault: boolean }
export class AppearanceSetupCancelled extends Error {}
export function shouldOfferAppearanceSetup(options: { existingConfig: boolean; completed: boolean; tty: boolean; screenReader: boolean; recovery: boolean }): boolean {
  return options.tty && !options.existingConfig && !options.completed && !options.screenReader && !options.recovery
}
const choices = [
  { name: 'auto', label: '自动 · 跟随终端背景' },
  { name: 'cobalt', label: '天枢深色 · 星辰蓝（推荐）' },
  { name: 'graphite', label: '中性深色 · 石墨' },
  { name: 'paper', label: '亮色 · 纸白' },
  { name: 'graphite-accessible', label: '深色 · 蓝黄配色' },
  { name: 'paper-accessible', label: '亮色 · 蓝黄配色' },
  { name: 'dark-ansi', label: '深色 · 仅 ANSI 颜色' },
  { name: 'light-ansi', label: '亮色 · 仅 ANSI 颜色' },
]

export function renderAppearanceSetup(selected: number, width: number, height: number): string[] {
  const name = choices[selected]?.name ?? 'cobalt'
  const entry = resolveThemeEntry(name === 'auto' ? 'cobalt' : name)!
  const theme = getTheme(), inset = frameInset(width), contentWidth = Math.max(1, width - inset * 2)
  const footer = frameHintRows([['↑↓', '选择'], ['Enter', '确认'], ['Esc', '默认'], ['Ctrl+C', '退出']], width, theme)
  const lines = height >= 28 ? [...formatWelcomeBrand(contentWidth, theme), ''] : []
  lines.push(color('开始使用天枢', theme.secondary, { bold: true }))
  if (height >= 18) lines.push('', ...wrapReadingText('选择适合你的终端外观。\n以后可以使用 /theme 更改。', contentWidth), '')
  const previewBudget = height >= 28 ? 8 : height >= 20 ? 5 : 0
  const listBudget = Math.max(1, height - lines.length - footer.length - previewBudget - (previewBudget ? 1 : 0))
  const start = Math.max(0, Math.min(selected - listBudget + 1, choices.length - listBudget))
  choices.slice(start, start + listBudget).forEach((choice, index) => lines.push(color(`${start + index === selected ? '❯' : ' '} ${start + index + 1}. ${choice.label}`, start + index === selected ? theme.primary : theme.secondary, start + index === selected ? { bold: true } : undefined)))
  if (previewBudget) lines.push('', ...renderThemePreview(name.endsWith('-ansi') ? entry.fallback : entry.truecolor, contentWidth, previewBudget, entry.background))
  return [...lines.map(row => ' '.repeat(inset) + truncateToDisplayWidth(row, contentWidth)), ...footer].slice(0, height)
}

export async function promptAppearanceSetup(options: { stdin: ReadStream; stdout: WriteStream; defaultTheme: string }): Promise<AppearanceSetupResult> {
  const { stdin, stdout, defaultTheme } = options
  let selected = Math.max(0, choices.findIndex(choice => choice.name === defaultTheme))
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  const paint = () => stdout.write('\x1b[H\x1b[2J' + renderAppearanceSetup(selected, Math.max(1, stdout.columns - 1), Math.max(1, stdout.rows - 1)).join('\r\n'))
  let onData: ((chunk: Buffer) => void) | undefined
  try {
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write('\x1b[?1049h\x1b[?25l')
    paint()
    return await new Promise<AppearanceSetupResult>((resolve, reject) => {
      onData = chunk => {
        const key = chunk.toString()
        if (key === '\x03') reject(new AppearanceSetupCancelled('外观选择已取消'))
        else if (key === '\x1b') resolve({ themeName: defaultTheme, usedDefault: true })
        else if (key === '\r' || key === '\n') resolve({ themeName: choices[selected]!.name, usedDefault: false })
        else if (key === '\x1b[A' || key === '\x1b[B') {
          selected = (selected + (key.endsWith('A') ? -1 : 1) + choices.length) % choices.length
          paint()
        }
      }
      stdin.on('data', onData)
      stdout.on('resize', paint)
    })
  } finally {
    if (onData) stdin.removeListener('data', onData)
    stdout.removeListener('resize', paint)
    stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l')
    stdin.setRawMode(wasRaw)
    if (wasPaused) stdin.pause()
  }
}
