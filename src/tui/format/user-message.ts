/**
 * 用户消息：首行识别说话人，续行对齐正文，长文本按终端字宽换行。
 *
 * 渲染结构：
 * ❯ 消息首行
 *   消息后续行
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { ambiguousWideEnabled, displayWidth, hardWrapToDisplayWidth } from '../width.js'

export interface FormatUserMessageInput {
  /** 消息文本内容 */
  content: string
  /** 终端宽度（列数） */
  width: number
}

export function formatUserMessage(input: FormatUserMessageInput, theme: RivetTheme): string[] {
  const lines: string[] = []

  const marker = useAsciiGlyphs() ? '>' : '❯'
  const prefix = color(marker, theme.userColor, { bold: true })
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const indent = ' '.repeat(displayWidth(`${marker} `, widthOptions))
  const width = Math.max(2, input.width - 1 - indent.length)
  const contentLines = input.content.split('\n').flatMap(line => hardWrapToDisplayWidth(line, width, widthOptions))
  for (let i = 0; i < contentLines.length; i++) {
    const text = contentLines[i]!
    lines.push(i === 0 ? `${prefix} ${color(text, theme.assistantColor)}` : text ? `${indent}${color(text, theme.assistantColor)}` : '')
  }

  return lines
}
