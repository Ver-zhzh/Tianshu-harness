import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCollapsedBashGroup,
  formatCollapsedBashGroupLive,
  type CollapsedBashGroup,
} from '../collapsed-bash.js'
import { getTheme } from '../../theme.js'
import { ANSI_SEQ_RE } from '../../engine/ansi.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ_RE, '')
}

function makeGroup(entries: CollapsedBashGroup['entries']): CollapsedBashGroup {
  return { entries, startMs: Date.now() - 1200 }
}

describe('formatCollapsedBashGroup', () => {
  it('keeps a successful multi-entry group on one summary line', () => {
    const group = makeGroup([
      { id: '1', command: 'ls -la', completed: true, content: 'a\nb', rawPath: '/tmp/bash-a.txt', startMs: Date.now() - 1000 },
      { id: '2', command: 'pwd', completed: true, content: '/home', rawPath: '/tmp/bash-b.txt', startMs: Date.now() - 500 },
      { id: '3', command: 'whoami', completed: true, content: 'user', rawPath: '/tmp/bash-c.txt', startMs: Date.now() - 100 },
      { id: '4', command: 'date', completed: true, content: 'now', rawPath: '/tmp/bash-d.txt', startMs: Date.now() - 50 },
    ])

    const rendered = formatCollapsedBashGroup({ group, expanded: false, theme, columns: 80 })
    const lines = rendered.map(stripAnsi)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes('Ran 4 shell commands'), 'count summary')
    assert.match(lines[0]!, / · \d+(?:\.\d+)?(?:ms|s)/, 'elapsed time')
    assert.ok(lines[0]!.includes('ctrl+o 展开'), 'expand hint stays on the summary line')
    assert.ok(!lines[0]!.includes('ls -la') && !lines[0]!.includes('pwd'), 'no individual cards')
    assert.ok(!lines[0]!.includes('/home'), 'no output preview')
    assert.ok(!rendered.some(line => line.includes('/tmp/bash-')), 'rawPath is expanded-only')
  })

  it('keeps only the tool title for a single successful result', () => {
    for (const content of ['body line 1\nbody line 2', '']) {
      const group = makeGroup([
        { id: '1', command: 'printf secret', completed: true, content, rawPath: '/tmp/bash-full.txt', startMs: Date.now() - 1000 },
      ])
      const rendered = formatCollapsedBashGroup({ group, expanded: false, theme, columns: 80 })
      const lines = rendered.map(stripAnsi)
      assert.equal(lines.length, 1)
      assert.ok(lines[0]!.includes('Run'), 'action')
      assert.ok(lines[0]!.includes('printf secret'), 'object')
      assert.ok(lines[0]!.includes('完成'), 'status')
      assert.ok(!lines[0]!.includes('body line'), 'no body')
      assert.ok(!lines[0]!.includes('(无输出)'), 'no empty-output placeholder')
      assert.ok(!rendered.some(line => line.includes('/tmp/bash-full.txt')), 'no rawPath')
    }
  })

  it('retains every error title and only its last three diagnostic lines', () => {
    const group = makeGroup([
      { id: '1', command: 'pwd', completed: true, content: '/home', rawPath: '/tmp/bash-success.txt', startMs: Date.now() - 1000 },
      { id: '2', command: 'npm run build', completed: true, isError: true, content: 'noise-1\nnoise-2\ndiag-1\ndiag-2\ndiag-3', rawPath: '/tmp/bash-error.txt', startMs: Date.now() - 900 },
      { id: '3', command: 'ls', completed: true, content: 'a\nb', startMs: Date.now() - 800 },
      { id: '4', command: 'false', completed: true, isError: true, content: 'final-1\nfinal-2', startMs: Date.now() - 700 },
    ])

    const rendered = formatCollapsedBashGroup({ group, expanded: false, theme, columns: 100 })
    const lines = rendered.map(stripAnsi)
    assert.equal(lines.length, 8)
    assert.ok(lines[0]!.includes('2 failed'), 'failure count')
    assert.ok(lines[1]!.includes('npm run build') && lines[1]!.includes('失败'), 'first error title')
    assert.deepEqual(lines.slice(2, 5), ['  diag-1', '  diag-2', '  diag-3'])
    assert.ok(lines[5]!.includes('false') && lines[5]!.includes('失败'), 'second error title')
    assert.deepEqual(lines.slice(6), ['  final-1', '  final-2'])
    const output = lines.join('\n')
    assert.ok(!output.includes('/home') && !output.includes('a\nb'), 'success output stays hidden')
    assert.ok(!output.includes('noise-1') && !output.includes('noise-2'), 'only error tails remain')
    assert.ok(!rendered.some(line => line.includes('/tmp/')), 'rawPath is expanded-only for mixed groups')
  })

  it('renders complete cards with exactly one rawPath per entry in expanded mode', () => {
    const group = makeGroup([
      { id: '1', command: 'ls -la', completed: true, content: 'a1\na2\na3\na4\na5', rawPath: '/tmp/bash-a.txt', startMs: Date.now() - 1000 },
      { id: '2', command: 'pwd', completed: true, content: 'b1\nb2', rawPath: '/tmp/bash-b.txt', startMs: Date.now() - 500 },
    ])

    const lines = formatCollapsedBashGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(!lines.some(l => /[│├╰]/.test(l)), 'no nested frame')
    assert.ok(lines.some(l => l.includes('ls -la')), 'first command')
    assert.ok(lines.some(l => l.includes('pwd')), 'last command')
    for (const content of ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2']) {
      assert.ok(lines.some(line => line.includes(content)), `expanded content: ${content}`)
    }
    const output = lines.join('\n')
    for (const rawPath of ['/tmp/bash-a.txt', '/tmp/bash-b.txt']) {
      assert.equal(output.split(rawPath).length - 1, 1, `${rawPath} appears exactly once`)
    }
  })

  it('shows a collapsed error title with at most three tail diagnostics', () => {
    const group = makeGroup([
      { id: '1', command: 'bad', completed: true, isError: true, content: 'noise-1\nnoise-2\nerror-1\nerror-2\nerror-3', rawPath: '/tmp/bash-bad.txt', startMs: Date.now() - 1000 },
    ])
    const rendered = formatCollapsedBashGroup({ group, expanded: false, theme, columns: 80 })
    const lines = rendered.map(stripAnsi)
    assert.equal(lines.length, 4)
    assert.ok(/[x✗].*失败/.test(lines[0]!), 'error marker and status')
    assert.deepEqual(lines.slice(1), ['  error-1', '  error-2', '  error-3'])
    assert.ok(!rendered.some(line => line.includes('/tmp/bash-bad.txt')), 'no rawPath')
  })

  it('keeps the expand hint ahead of secondary summary text at 40 and 20 columns', async () => {
    const { displayWidth } = await import('../../width.js')
    const previousWidthMode = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    try {
      for (const testCase of [
        { columns: 40, expandHint: undefined, expectedHint: 'ctrl+o 展开' },
        { columns: 20, expandHint: '/pager → Enter 查看详情', expectedHint: '/pager' },
      ]) {
        const group = makeGroup([
          { id: '1', command: 'git status --short --branch', completed: true, content: 'a', startMs: Date.now() - 1000 },
          { id: '2', command: 'pwd', completed: true, content: 'b', startMs: Date.now() - 500 },
        ])
        const lines = formatCollapsedBashGroup({ group, expanded: false, theme, ...testCase }).map(stripAnsi)
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
          { id: '1', command: 'bad', completed: true, isError, content: 'noise-1\nnoise-2\ndiag-1\ndiag-2\ndiag-3', rawPath: '/tmp/bash-full.txt', startMs: Date.now() - 1000 },
        ])
        const lines = formatCollapsedBashGroup({ group, expanded: false, theme, ...testCase }).map(stripAnsi)
        const hint = testCase.expandHint ?? 'ctrl+o 展开'
        assert.equal(lines.length, isError ? 4 : 1, lines.join('|'))
        assert.ok(lines[0]!.includes(hint), lines[0])
        assert.ok(!lines.some(line => line.includes('/tmp/bash-full.txt')), lines.join('|'))
        assert.ok(!lines.some(line => line.includes('noise-')), lines.join('|'))
        if (isError) assert.deepEqual(lines.slice(1), ['  diag-1', '  diag-2', '  diag-3'])
        else assert.ok(!lines.some(line => line.includes('diag-')), lines.join('|'))
      }
    }
  })
})

describe('formatCollapsedBashGroupLive', () => {
  it('renders only one active aggregate line', () => {
    const group = makeGroup([
      { id: '1', command: 'ls', completed: true, content: 'result tail 1\nresult tail 2', startMs: Date.now() - 1000 },
    ])
    const lines = formatCollapsedBashGroupLive(group, theme, 80).map(stripAnsi)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes('Ran 1 shell command'), 'live summary')
    assert.ok(!lines[0]!.includes('result tail'), 'no recent-result preview')
  })
})
