import { ANSI, enforceTextContract } from '../engine/ansi.js'
import { ambiguousWideEnabled, displayWidth } from '../width.js'

export function proseColumns(columns: number, indentColumns = 0): number {
  return Math.max(1, Math.min(80, columns - indentColumns))
}

/** Keep styles, links and graphemes intact when prose wraps. */
export function wrapReadingText(text: string, width: number, continuation = ''): string[] {
  const rows: string[] = [], wide = { ambiguousAsWide: ambiguousWideEnabled() }
  let current = '', styles = '', link = '', cells = 0, position = 0
  const closeLink = '\x1b]8;;\x1b\\'
  const emit = () => {
    rows.push(current + (link ? closeLink : '') + (styles ? ANSI.RESET : ''))
    current = styles + link + continuation
    cells = displayWidth(continuation, wide)
  }
  const append = (part: string) => {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part)) {
      const n = displayWidth(segment, wide)
      if (cells + n > width && cells) emit()
      current += segment; cells += n
    }
  }
  const clean = text.split(/(\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/).map(part => part.startsWith('\x1b]8;') ? part : enforceTextContract(part)).join('').replace(/\t/g, '    ')
  for (const match of clean.matchAll(/\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\n/g)) {
    append(clean.slice(position, match.index))
    if (match[0] === '\n') emit()
    else {
      current += match[0]
      if (match[0].startsWith('\x1b]8;')) link = /^\x1b\]8;;(?:\x07|\x1b\\)$/.test(match[0]) ? '' : match[0]
      else styles = match[0] === ANSI.RESET ? '' : styles + match[0]
    }
    position = match.index + match[0].length
  }
  append(clean.slice(position))
  rows.push(current + (link ? closeLink : '') + (styles ? ANSI.RESET : ''))
  return rows
}
