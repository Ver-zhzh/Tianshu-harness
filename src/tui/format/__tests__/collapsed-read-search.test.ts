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
import { ANSI_SEQ_RE } from '../../engine/ansi.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ_RE, '')
}

function makeGroup(entries: CollapsedReadSearchGroup['entries']): CollapsedReadSearchGroup {
  return { entries, startMs: Date.now() - 1200 }
}

describe('formatCollapsedGroup', () => {
  it('keeps a successful multi-entry group on one summary line', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'line-a', rawPath: '/tmp/read-a.txt' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'line-b', rawPath: '/tmp/read-b.txt' },
      { id: '3', toolName: 'read_file', input: { file_path: 'src/c.ts' }, displayName: 'src/c.ts', kind: 'read', completed: true, content: 'line-c', rawPath: '/tmp/read-c.txt' },
      { id: '4', toolName: 'read_file', input: { file_path: 'src/d.ts' }, displayName: 'src/d.ts', kind: 'read', completed: true, content: 'line-d', rawPath: '/tmp/read-d.txt' },
    ])

    const rendered = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 })
    const lines = rendered.map(stripAnsi)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes('Read 4 files'), 'count summary')
    assert.match(lines[0]!, / · \d+(?:\.\d+)?(?:ms|s)/, 'elapsed time')
    assert.ok(lines[0]!.includes('ctrl+o 展开'), 'expand hint stays on the summary line')
    assert.ok(!lines[0]!.includes('src/a.ts'), 'no individual cards')
    assert.ok(!lines[0]!.includes('line-a'), 'no output preview')
    assert.ok(!rendered.some(line => line.includes('/tmp/read-')), 'rawPath is expanded-only')
  })

  it('keeps only the tool title for a single successful result', () => {
    for (const content of ['body line 1\nbody line 2', '']) {
      const group = makeGroup([
        { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content, rawPath: '/tmp/read-full.txt' },
      ])
      const rendered = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 })
      const lines = rendered.map(stripAnsi)
      assert.equal(lines.length, 1)
      assert.ok(lines[0]!.includes('Read'), 'action')
      assert.ok(lines[0]!.includes('src/a.ts'), 'object')
      assert.ok(lines[0]!.includes('完成'), 'status')
      assert.ok(!lines[0]!.includes('body line'), 'no body')
      assert.ok(!lines[0]!.includes('(无输出)'), 'no empty-output placeholder')
      assert.ok(!rendered.some(line => line.includes('/tmp/read-full.txt')), 'no rawPath')
    }
  })

  it('retains every error title and only its last three diagnostic lines', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'success-body', rawPath: '/tmp/success-a.txt' },
      { id: '2', toolName: 'grep', input: { pattern: 'bad-pattern' }, displayName: '"bad-pattern"', kind: 'search', completed: true, isError: true, content: 'noise-1\nnoise-2\ndiag-1\ndiag-2\ndiag-3', rawPath: '/tmp/error-search.txt' },
      { id: '3', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'other-success' },
      { id: '4', toolName: 'read_file', input: { file_path: 'src/broken.ts' }, displayName: 'src/broken.ts', kind: 'read', completed: true, isError: true, content: 'final-1\nfinal-2' },
    ])

    const rendered = formatCollapsedGroup({ group, expanded: false, theme, columns: 100 })
    const lines = rendered.map(stripAnsi)
    assert.equal(lines.length, 8)
    assert.ok(lines[1]!.includes('bad-pattern') && lines[1]!.includes('失败'), 'first error title')
    assert.deepEqual(lines.slice(2, 5), ['  diag-1', '  diag-2', '  diag-3'])
    assert.ok(lines[5]!.includes('src/broken.ts') && lines[5]!.includes('失败'), 'second error title')
    assert.deepEqual(lines.slice(6), ['  final-1', '  final-2'])
    const output = lines.join('\n')
    assert.ok(!output.includes('success-body') && !output.includes('other-success'), 'success output stays hidden')
    assert.ok(!output.includes('noise-1') && !output.includes('noise-2'), 'only error tails remain')
    assert.ok(!rendered.some(line => line.includes('/tmp/')), 'rawPath is expanded-only for mixed groups')
  })

  it('renders complete cards with exactly one rawPath per entry in expanded mode', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'a1\na2\na3\na4\na5', rawPath: '/tmp/read-a.txt' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'b1\nb2', rawPath: '/tmp/read-b.txt' },
    ])

    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(!lines.some(l => /[│├└]/.test(l)), 'no nested frame')
    assert.ok(lines.some(l => l.includes('src/a.ts')), 'first entry')
    assert.ok(lines.some(l => l.includes('src/b.ts')), 'last entry')
    for (const content of ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2']) {
      assert.ok(lines.some(line => line.includes(content)), `expanded content: ${content}`)
    }
    const output = lines.join('\n')
    for (const rawPath of ['/tmp/read-a.txt', '/tmp/read-b.txt']) {
      assert.equal(output.split(rawPath).length - 1, 1, `${rawPath} appears exactly once`)
    }
  })

  it('shows pending hint when no entry completed', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: false },
    ])
    const lines = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('等待结果')), 'pending hint')
  })

  it('keeps expanded CJK content complete instead of clipping it to columns', () => {
    const cjkContent = '这是一段中文测试内容'.repeat(3)
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: cjkContent },
    ])
    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 20 }).map(stripAnsi)
    assert.ok(lines.some(line => line.includes(cjkContent)), lines.join('|'))
  })

  it('keeps the expand hint ahead of secondary summary text at 40 and 20 columns', () => {
    const previousWidthMode = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    try {
      for (const testCase of [
        { columns: 40, expandHint: undefined, expectedHint: 'ctrl+o 展开' },
        { columns: 20, expandHint: '/pager → Enter 查看详情', expectedHint: '/pager' },
      ]) {
        const group = makeGroup([
          { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'a' },
          { id: '2', toolName: 'grep', input: { pattern: 'needle' }, displayName: '"needle"', kind: 'search', completed: true, content: 'b' },
        ])
        const lines = formatCollapsedGroup({ group, expanded: false, theme, ...testCase }).map(stripAnsi)
        assert.equal(lines.length, 1, lines.join('|'))
        assert.ok(lines[0]!.includes(testCase.expectedHint), lines[0])
        assert.ok(!lines[0]!.includes('工具'), lines[0])
        assert.ok(displayWidth(lines[0]!, { ambiguousAsWide: true }) <= testCase.columns - 1, lines[0])
      }
    } finally {
      if (previousWidthMode === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
      else process.env.RIVET_AMBIGUOUS_WIDTH = previousWidthMode
    }
  })

  it('keeps a detail hint on single success and error titles without restoring hidden output', () => {
    for (const isError of [false, true]) {
      for (const testCase of [{ columns: 40 }, { columns: 20, expandHint: '/pager' }]) {
        const group = makeGroup([
          { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, isError, content: 'noise-1\nnoise-2\ndiag-1\ndiag-2\ndiag-3', rawPath: '/tmp/read-full.txt' },
        ])
        const lines = formatCollapsedGroup({ group, expanded: false, theme, ...testCase }).map(stripAnsi)
        const hint = testCase.expandHint ?? 'ctrl+o 展开'
        assert.equal(lines.length, isError ? 4 : 1, lines.join('|'))
        assert.ok(lines[0]!.includes(hint), lines[0])
        assert.ok(!lines.some(line => line.includes('/tmp/read-full.txt')), lines.join('|'))
        assert.ok(!lines.some(line => line.includes('noise-')), lines.join('|'))
        if (isError) assert.deepEqual(lines.slice(1), ['  diag-1', '  diag-2', '  diag-3'])
        else assert.ok(!lines.some(line => line.includes('diag-')), lines.join('|'))
      }
    }
  })
})

describe('formatCollapsedGroupLive', () => {
  it('renders only one active aggregate line（进行体时态）', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: true, content: 'result tail 1\nresult tail 2' },
    ])
    const lines = formatCollapsedGroupLive(group, theme, 80).map(stripAnsi)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes('Searching 1 pattern'), 'live 摘要用进行体')
    assert.ok(!lines[0]!.includes('Searched'), 'live 摘要不应用过去时')
    assert.ok(!lines[0]!.includes('result tail'), 'no recent-result preview')
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
