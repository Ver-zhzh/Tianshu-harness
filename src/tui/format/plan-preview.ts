import type { RivetTheme } from '../theme.js'
import { formatMarkdown } from './markdown.js'
import { pagerContentWidth, projectPagerDocument } from './pager-document.js'

export function preparePlanPreview(content: string, columns: number, theme: RivetTheme) {
  const logical = formatMarkdown({ text: content, columns: pagerContentWidth(columns), fullDocument: true, wrapText: false }, theme)
  return projectPagerDocument(logical, columns)
}
