import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useAsciiGlyphs } from '../../term-caps.js'
import { color } from '../../engine/ansi.js'
import { getTheme } from '../../theme.js'
import { formatUserMessage } from '../user-message.js'

const theme = getTheme(3)

describe('formatUserMessage typography', () => {
  it('keeps the first role marker accented and indents continuation copy', () => {
    const marker = useAsciiGlyphs() ? '>' : '❯'
    const lines = formatUserMessage({ content: '第一行\n第二行', width: 80 }, theme)
    const prefix = color(marker, theme.userColor, { bold: true })

    assert.deepEqual(lines, [
      `${prefix} ${color('第一行', theme.assistantColor)}`,
      `  ${color('第二行', theme.assistantColor)}`,
    ])
  })

  it('preserves blank lines without repeating the role marker', () => {
    const marker = useAsciiGlyphs() ? '>' : '❯'
    const prefix = color(marker, theme.userColor, { bold: true })

    assert.deepEqual(
      formatUserMessage({ content: '正文\n\n继续', width: 80 }, theme),
      [
        `${prefix} ${color('正文', theme.assistantColor)}`,
        '',
        `  ${color('继续', theme.assistantColor)}`,
      ],
    )
  })
})
