import { ANSI, bg, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { highlightLine, keywordsForLang } from './markdown.js'
import { displayWidth } from '../width.js'
import { wrapReadingText } from './reading-layout.js'
import { diffArrays } from 'diff'

function diffBackdrop(tint: string, light: boolean): string {
  if (!tint.startsWith('#')) return bg(tint)
  const base = light ? 255 : 20, ratio = light ? 0.16 : 0.3
  return bg('#' + [1, 3, 5].map(at => Math.round(base * (1 - ratio) + parseInt(tint.slice(at, at + 2), 16) * ratio).toString(16).padStart(2, '0')).join(''))
}

export function renderCodeDiff(before: string, after: string, width: number, theme: RivetTheme, light = theme.background === 'light', startLine = 1): string[] {
  const old = before.split('\n'), next = after.split('\n')
  let oldLine = startLine, newLine = startLine
  const rows = diffArrays(old, next).flatMap(part => part.value.map(text => {
    if (part.removed) return { text, number: oldLine++, kind: '-' }
    if (part.added) return { text, number: newLine++, kind: '+' }
    oldLine++
    return { text, number: newLine++, kind: ' ' }
  }))
  const digits = String(startLine + Math.max(old.length, next.length) - 1).length
  const syntax = keywordsForLang('typescript')
  return rows.flatMap(row => {
    const tint = row.kind === '-' ? theme.error : row.kind === '+' ? theme.success : theme.muted
    const background = row.kind === ' ' ? '' : diffBackdrop(tint, light)
    const styled = highlightLine(row.text, syntax?.keywords ?? null, false, theme).map(span => color(span.text, span.color ?? theme.assistantColor, { bold: span.bold })).join('')
    return wrapReadingText(styled, Math.max(1, width - digits - 4)).map((line, index) => {
      const content = color(`${index ? ' '.repeat(digits) : String(row.number).padStart(digits)} ${index ? ' ' : row.kind} `, tint) + line
      return background + content.replaceAll(ANSI.RESET, ANSI.RESET + background) + ' '.repeat(Math.max(0, width - displayWidth(content))) + ANSI.RESET
    })
  })
}
