import { ANSI_SEQ_RE } from '../engine/ansi.js'
import { frameInset } from './overlay-frame.js'
import { normalizeReadingText, wrapReadingText } from './reading-layout.js'

export interface PagerAnchor {
  line: number
  offset: number
}

export interface PagerDocument {
  content: string
  anchorAt: (row: number) => PagerAnchor
  rowForAnchor: (anchor: PagerAnchor) => number
  searchRows: (query: string) => number[]
}

export function pagerContentWidth(columns: number): number {
  return Math.max(1, columns - frameInset(columns) * 2 - 1)
}

/** Keep logical text separate from terminal wrapping for search and resize. */
export function projectPagerDocument(lines: readonly string[], columns: number, preserveWhitespace = false): PagerDocument {
  const width = pagerContentWidth(columns)
  const logical = lines.map(text => {
    const normalized = normalizeReadingText(text)
    return { text: normalized, plain: normalized.replace(ANSI_SEQ_RE, '') }
  })
  const rows: string[] = [], anchors: PagerAnchor[] = []
  for (const [line, source] of logical.entries()) {
    let offset = 0
    for (const row of wrapReadingText(source.text, width, '', { preserveWhitespace })) {
      const plain = row.replace(ANSI_SEQ_RE, '')
      const start = source.plain.indexOf(plain, offset)
      anchors.push({ line, offset: start < 0 ? offset : start })
      rows.push(row)
      offset = (start < 0 ? offset : start) + plain.length
    }
  }
  const rowForAnchor = (anchor: PagerAnchor): number => {
    let row = 0
    for (const [index, current] of anchors.entries()) {
      if (current.line > anchor.line || current.line === anchor.line && current.offset > anchor.offset) break
      row = index
    }
    return row
  }
  return {
    content: rows.join('\n'),
    anchorAt: (row: number): PagerAnchor => anchors[Math.min(Math.max(0, row), anchors.length - 1)] ?? { line: 0, offset: 0 },
    rowForAnchor,
    searchRows: (query: string): number[] => query ? logical.flatMap((line, index) => {
      const offset = line.plain.toLowerCase().indexOf(query.toLowerCase())
      return offset < 0 ? [] : [rowForAnchor({ line: index, offset })]
    }) : [],
  }
}

export function preparePagerDocument(content: string, columns: number): PagerDocument {
  return projectPagerDocument(content.split('\n'), columns, true)
}
