import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSummaryText,
  CollapsedReadSearchBuffer,
  formatCollapsedGroup,
  formatCollapsedGroupLive,
  type CollapsedReadSearchGroup,
} from '../collapsed-read-search.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function makeGroup(entries: CollapsedReadSearchGroup['entries']): CollapsedReadSearchGroup {
  return { entries, startMs: Date.now() - 1200 }
}

describe('formatCollapsedGroup', () => {
  it('renders collapsed actions with an expand route and no nested frame', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'line1\nline2' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'line1' },
      { id: '3', toolName: 'read_file', input: { file_path: 'src/c.ts' }, displayName: 'src/c.ts', kind: 'read', completed: true, content: 'line1' },
      { id: '4', toolName: 'read_file', input: { file_path: 'src/d.ts' }, displayName: 'src/d.ts', kind: 'read', completed: true, content: 'line1' },
    ])

    const lines = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines[0]!.includes('Read 4 files'), 'summary')
    assert.ok(!lines.some(l => /[│├└]/.test(l)), 'no nested frame')
    assert.ok(lines.some(l => l.includes('ctrl+o 展开')), 'expand hint')
  })

  it('renders all expanded actions without nested tree connectors', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'line1\nline2' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'line1' },
    ])

    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(!lines.some(l => /[│├└]/.test(l)), 'no nested frame')
    assert.ok(lines.some(l => l.includes('src/a.ts')), 'first entry')
    assert.ok(lines.some(l => l.includes('src/b.ts')), 'last entry')
  })

  it('shows pending hint when no entry completed', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: false },
    ])
    const lines = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('等待结果')), 'pending hint')
  })

  it('truncates CJK content by display width, not byte length', () => {
    // 8 CJK chars = 16 display columns. With maxWidth ~10, content MUST be truncated.
    // Bug: .length-based check (8 > 10 → false) passes the full line through,
    // causing it to overflow the column budget.
    const cjkContent = '这是一段中文测试内容'
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: cjkContent },
    ])
    // Narrow columns so the CJK line won't fit (childPrefix = '│     ' = 6 cols, columns=20 → maxWidth ≈ 14)
    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 20 }).map(stripAnsi)
    // Every line must fit within the terminal column budget.
    for (const line of lines) {
      // CJK width: each CJK char = 2 columns.
      const w = displayWidth(line)
      assert.ok(w <= 20, `line "${line.slice(0, 20)}..." width ${w} exceeds 20 columns`)
    }
    // The CJK content line should be truncated (not the full 8-char CJK string).
    const contentLines = lines.filter(l => l.includes('中'))
    assert.ok(contentLines.length > 0, 'CJK content present')
    const contentLine = contentLines[0]!
    // After truncation, the visible text should be shorter than the original
    assert.ok(contentLine.length < cjkContent.length + 10, 'CJK content was truncated')
  })
})

describe('formatCollapsedGroupLive', () => {
  it('renders active summary line（进行体时态）', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: true, content: 'result' },
    ])
    const lines = formatCollapsedGroupLive(group, theme, 80).map(stripAnsi)
    assert.ok(lines[0]!.includes('Searching 1 pattern'), 'live 摘要用进行体')
    assert.ok(!lines[0]!.includes('Searched'), 'live 摘要不应用过去时')
  })
})

describe('buildSummaryText 时态（grok verb-group 对标）', () => {
  const group = () => makeGroup([
    { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: true, content: 'r' },
    { id: '2', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'l' },
    { id: '3', toolName: 'ls', input: { path: 'src' }, displayName: 'src', kind: 'list', completed: true, content: 'a.ts' },
  ])

  it('settled（scrollback）用过去时', () => {
    const s = buildSummaryText(group(), false)
    assert.ok(s.includes('Searched 1 pattern') && s.includes('Read 1 file') && s.includes('Listed 1 dir'), s)
  })

  it('active（live）用进行体', () => {
    const s = buildSummaryText(group(), true)
    assert.ok(s.includes('Searching 1 pattern') && s.includes('Reading 1 file') && s.includes('Listing 1 dir'), s)
  })
})

describe('CollapsedReadSearchBuffer', () => {
  it('跨 thinking 折叠：thinking 事件不触碰 buffer，两个 read 仍同组', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('1', 'read_file', { file_path: 'src/a.ts' })
    // thinking delta / thinking commit 介于两个工具调用之间——不调用任何 buffer 方法
    buf.pushUse('2', 'read_file', { file_path: 'src/b.ts' })
    const active = buf.getActive()
    assert.equal(active?.entries.length, 2, '两个 read 仍在同一组')
    // 只有非折叠工具才打断
    assert.ok(buf.shouldBreak('write_file'), '非折叠工具应打断组')
    assert.ok(!buf.shouldBreak('grep'), '折叠工具不打断组')
  })
})
