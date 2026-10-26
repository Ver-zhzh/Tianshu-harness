import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { preparePagerDocument } from '../pager-document.js'
import { preparePlanPreview } from '../plan-preview.js'
import { frameInset } from '../overlay-frame.js'
import { displayWidth } from '../../width.js'
import { getTheme } from '../../theme.js'

const rowsOf = (document: ReturnType<typeof preparePagerDocument>): string[] => document.content.split('\n')
const pagerWidth = (columns: number): number => Math.max(1, columns - frameInset(columns) * 2 - 1)

function logicalLines(document: ReturnType<typeof preparePagerDocument>, source: string): string[] {
  const lines = source.split('\n').map(() => '')
  rowsOf(document).forEach((row, index) => {
    const anchor = document.anchorAt(index)
    assert.ok(anchor.line >= 0 && anchor.line < lines.length, JSON.stringify(anchor))
    lines[anchor.line] += plain(row)
  })
  return lines
}

test('原始详情在窄屏软折行，完整保留长行、CJK、emoji、rawPath 与空格', () => {
  const source = [
    '  **raw** rawPath=/tmp/alpha beta/中文👩‍💻/cache-routes.ts  trailing  ',
    `第二行  e\u0301 ${'甲乙'.repeat(20)}  `,
  ].join('\n')
  const document = preparePagerDocument(source, 14)
  assert.ok(rowsOf(document).length > 2)
  assert.ok(rowsOf(document).every(row => displayWidth(row) <= pagerWidth(14)))
  assert.deepEqual(logicalLines(document, source), source.split('\n'))
})

test('一到五列的极窄终端不丢字符，也不产生超宽 ASCII 行', () => {
  const source = 'ab  cd\n ef '
  for (let columns = 1; columns <= 5; columns++) {
    const document = preparePagerDocument(source, columns)
    assert.deepEqual(logicalLines(document, source), source.split('\n'), `columns=${columns}`)
    assert.ok(rowsOf(document).every(row => displayWidth(row) <= pagerWidth(columns)), `columns=${columns}`)
  }
})

test('ANSI 样式与 OSC 8 跨行闭合，危险控制序列不进入 pager', () => {
  const link = '\x1b]8;;https://example.com/file\x1b\\'
  const close = '\x1b]8;;\x1b\\'
  const clipboard = '\x1b]52;c;Y2xpcGJvYXJk\x07'
  const source = `before \x1b[36m${link}abcde  cache-routes.ts${close}\x1b[0m after${clipboard}\x1b[2J`
  const document = preparePagerDocument(source, 12)
  assert.deepEqual(logicalLines(document, source), ['before abcde  cache-routes.ts after'])
  assert.ok(document.content.includes('\x1b[36m'))
  assert.ok(document.content.includes(link))
  assert.ok(!document.content.includes('\x1b]52;'))
  assert.ok(!document.content.includes('\x1b[2J'))
  for (const row of rowsOf(document)) {
    let linked = false
    for (const sequence of row.match(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? []) {
      linked = sequence !== close && sequence !== '\x1b]8;;\x07'
    }
    assert.equal(linked, false, `OSC 8 未闭合: ${JSON.stringify(row)}`)
  }
})

test('搜索逻辑行中的跨软折行短语，命中映射到原逻辑行', () => {
  const source = 'HEAD rawPath=/tmp/alpha beta/gamma.ts TAIL\n第二行 Needle'
  const document = preparePagerDocument(source, 12)
  const query = 'alpha beta/gamma'
  assert.ok(!rowsOf(document).some(row => plain(row).includes(query)))
  const hits = document.searchRows(query)
  assert.equal(hits.length, 1)
  assert.ok(plain(rowsOf(document)[hits[0]!]!).includes('alpha'))
  assert.equal(document.anchorAt(hits[0]!).line, 0)
  assert.deepEqual(document.searchRows(query.toUpperCase()), hits)
  const secondLine = document.searchRows('needle')
  assert.equal(secondLine.length, 1)
  assert.equal(document.anchorAt(secondLine[0]!).line, 1)
  assert.deepEqual(document.searchRows(''), [])
})

test('resize 通过逻辑行锚点重映射，折行内偏移回退到最近行首', () => {
  const source = 'short\n0123456789 abcdefghij rawPath=/tmp/one/two.ts\nlast'
  const wide = preparePagerDocument(source, 32)
  const narrow = preparePagerDocument(source, 12)
  for (let line = 0; line < 3; line++) {
    const wideRow = rowsOf(wide).findIndex((_, row) => wide.anchorAt(row).line === line)
    const anchor = wide.anchorAt(wideRow)
    const narrowRow = narrow.rowForAnchor(anchor)
    assert.deepEqual(narrow.anchorAt(narrowRow), anchor)
  }
  const inner = { line: 1, offset: 12 }
  const remapped = narrow.rowForAnchor(inner)
  const resolved = narrow.anchorAt(remapped)
  assert.equal(resolved.line, inner.line)
  assert.ok(resolved.offset <= inner.offset)
  const next = rowsOf(narrow).findIndex((_, row) => {
    const anchor = narrow.anchorAt(row)
    return anchor.line === inner.line && anchor.offset > inner.offset
  })
  assert.ok(next < 0 || remapped < next)
})

test('plan preview 复用文档契约时仍渲染 Markdown', () => {
  const document = preparePlanPreview('# 标题\n\n**加粗**与 rawPath=/tmp/a b.ts', 20, getTheme(0))
  const text = plain(document.content)
  assert.ok(text.includes('标题'))
  assert.ok(text.includes('加粗'))
  assert.ok(!text.includes('# 标题'))
  assert.ok(!text.includes('**'))
  assert.ok(document.searchRows('加粗').length > 0)
})
