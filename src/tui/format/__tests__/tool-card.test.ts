import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCardLive, formatToolCard, isToolCardTruncated } from '../tool-card.js'
import { getTheme } from '../../theme.js'
import { ANSI_SEQ_RE } from '../../engine/ansi.js'
import { buildFileDiff } from '../../../tools/edit-diff.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ_RE, '')
}

describe('formatToolCardLive', async () => {
  it('returns a fixed height even without output tail', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: '',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('pads empty tail rows when output is short', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      outputTail: 'hello',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'fixed height')
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('hello')), 'content visible')
  })

  it('shows only the last tailLines of output', async () => {
    const output = 'line1\nline2\nline3\nline4'
    const lines = formatToolCardLive({
      toolName: 'bash',
      outputTail: output,
      columns: 80,
      tailLines: 2,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('line4')), 'last line visible')
    assert.ok(!plain.some(l => l.includes('line1')), 'first line dropped')
  })

  it('accepts pre-split outputTailLines and skips re-splitting outputTail', async () => {
    // live 区每帧渲染时调用方按累加器引用缓存切分结果；预切行必须与 outputTail 路径一致。
    const output = 'line1\nline2\nline3\nline4\n'
    const viaTail = formatToolCardLive({
      toolName: 'bash', outputTail: output, columns: 80, tailLines: 2,
    }, theme).map(stripAnsi)
    const viaLines = formatToolCardLive({
      toolName: 'bash', outputTail: output, outputTailLines: ['line1', 'line2', 'line3', 'line4'], columns: 80, tailLines: 2,
    }, theme).map(stripAnsi)
    assert.deepEqual(viaLines, viaTail)
  })

  it('pre-split empty outputTailLines falls back to the placeholder row', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash', outputTail: '', outputTailLines: undefined, columns: 80, tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('renders a spinner bullet when tick is provided', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'sleep 1' },
      columns: 80,
      tick: 1,
      tailLines: 3,
    }, theme)
    const header = stripAnsi(lines[0]!)
    assert.match(header, /Run\s+sleep 1.*运行中/, 'action, object and running status present')
    assert.equal(lines.length, 1 + 3, 'fixed height with spinner')
  })

  // tailLines=0 是并发折叠用的：live 区只给最新一张卡展开输出，其余仅标题行。
  // `slice(-0)` 等价于 `slice(0)`，天真实现会把整个 tail 全量摊开——与意图相反。
  it('tailLines=0 只出标题行，不摊开整个 tail', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: 'line1\nline2\nline3\nline4\nline5',
      columns: 80,
      tailLines: 0,
    }, theme)
    assert.equal(lines.length, 1, `应只有标题行，实得 ${lines.length} 行: ${lines.map(stripAnsi).join(' | ')}`)
    const plain = stripAnsi(lines[0]!)
    assert.ok(!plain.includes('line1') && !plain.includes('line5'), 'tail 内容不出现')
  })

  it('tailLines=0 且无输出时也不补占位行', async () => {
    const lines = formatToolCardLive({
      toolName: 'read', toolInput: { path: 'a.ts' }, outputTail: '', columns: 80, tailLines: 0,
    }, theme)
    assert.equal(lines.length, 1, '无输出也只有标题行')
  })
})

describe('formatToolCard — inline edit diff (write family + isDiffContent)', async () => {
  it('colors an edit_file uiContent diff and shows the +N −M summary', async () => {
    const diff = await buildFileDiff('src/foo.ts', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')
    const lines = formatToolCard({
      toolName: 'edit_file',
      content: diff,
      toolInput: { file_path: 'src/foo.ts' },
      elapsedMs: 12,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/, 'diff stat summary present')
    assert.ok(plain.includes('-beta'), 'removal line rendered')
    assert.ok(plain.includes('+BETA'), 'addition line rendered')
  })

  it('routes apply_patch output through the diff renderer', async () => {
    const diff = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n'
    const lines = formatToolCard({
      toolName: 'apply_patch',
      content: diff,
      elapsedMs: 5,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/)
  })
})

describe('formatToolCard — diff 内联阈值 (adds+dels ≤ 10)', () => {
  it('renders inline diff when adds+dels = 10', () => {
    // 构造恰好 10 行修改 (5 adds + 5 dels)
    const hunks = '@@ -1,5 +1,5 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e']
    const adds = ['+A', '+B', '+C', '+D', '+E']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+5 −5/, 'diff stat should be present')
    assert.ok(plain.includes('-a'), 'removal lines rendered inline')
    assert.ok(plain.includes('+A'), 'addition lines rendered inline')
  })

  it('renders summary when adds+dels > 10', () => {
    // 构造 12 行修改 (6 adds + 6 dels)
    const hunks = '@@ -1,6 +1,6 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e', '-f']
    const adds = ['+A', '+B', '+C', '+D', '+E', '+F']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /1 处修改/, 'summary with hunk count')
    assert.match(plain, /\+6 −6/, 'summary with line counts')
    assert.ok(!plain.includes('-a'), 'removal lines NOT rendered inline')
    assert.ok(!plain.includes('+A'), 'addition lines NOT rendered inline')
    assert.match(plain, /ctrl\+o 展开/, 'expand hint present')
  })

  it('isToolCardTruncated returns false for ≤10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+A\n+B\n+C\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), false)
  })

  it('isToolCardTruncated returns true for >10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,6 +1,6 @@\n-a\n-b\n-c\n-d\n-e\n-f\n+A\n+B\n+C\n+D\n+E\n+F\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), true)
  })
})

describe('派发预览：字段名必须与 delegate 工具 schema 对齐', async () => {
  // 这里曾读 `task.id` 与 `task.description`，而 delegate_batch 的任务 schema
  // 只有 `objective`（delegate-batch.ts required: ['objective']）。两个字段都不
  // 存在，于是每次批量派发都只渲染出 `• #1 • #2`：逐次一模一样、与真实任务无关。
  const preview = (toolName: string, toolInput: Record<string, unknown>): string =>
    formatToolCard({ toolName, toolInput, content: '', streaming: true }, theme)
      .map(stripAnsi).join('\n')

  it('delegate_batch 渲染每个任务的 objective', async () => {
    const out = preview('delegate_batch', {
      tasks: [{ objective: '审查缓存边界' }, { objective: '补 rewind 回归测试' }],
    })
    assert.match(out, /审查缓存边界/)
    assert.match(out, /补 rewind 回归测试/)
  })

  it('delegate_batch 两次不同派发渲染出不同内容', async () => {
    const a = preview('delegate_batch', { tasks: [{ objective: '审查缓存边界' }] })
    const b = preview('delegate_batch', { tasks: [{ objective: '补 rewind 回归测试' }] })
    assert.notEqual(a, b, '不同任务不得渲染成同一段文本')
  })

  it('objective 尚未流式到达时不报错，也不编造内容', async () => {
    const out = preview('delegate_batch', { tasks: [{}] })
    assert.match(out, /#1/, '编号仍要有，否则用户看不出派了几个')
    assert.doesNotMatch(out, /undefined/)
  })

  it('delegate_task 单任务渲染 objective', async () => {
    const out = preview('delegate_task', { objective: '定位 /tasks 舰队行的渲染函数' })
    assert.match(out, /定位 \/tasks 舰队行的渲染函数/)
  })

  it('delegate_task 参数未成形时退到 profile（schema 里没有 agent 字段）', async () => {
    const out = preview('delegate_task', { profile: 'reviewer' })
    assert.match(out, /reviewer/)
  })
})

describe('formatToolCard — compact 投影', () => {
  type Input = Parameters<typeof formatToolCard>[0]
  const render = (input: Input) => formatToolCard(input, theme).map(stripAnsi)
  const lines = (count: number, prefix = 'line') =>
    Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n')
  const expandHintCount = (rows: readonly string[]) =>
    rows.reduce((count, row) => count + (row.match(/ctrl\+o 展开/g) ?? []).length, 0)

  it('默认及显式 compact:false 保持原有字节输出', () => {
    const inputs: Input[] = [
      { toolName: 'bash', content: lines(12), rawPath: '/tmp/run.log', maxLines: 4 },
      { toolName: 'read_file', content: lines(12), rawPath: '/tmp/a.ts' },
      { toolName: 'edit_file', content: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new' },
    ]
    for (const input of inputs) {
      assert.deepEqual(formatToolCard({ ...input, compact: false }, theme), formatToolCard(input, theme))
    }
  })

  it('成功的 read/find 只留标题，不展示输出、来源或展开提示', () => {
    for (const toolName of ['read_file', 'web_fetch', 'grep', 'glob']) {
      const rows = render({ toolName, content: lines(9), compact: true, rawPath: '/tmp/full.txt' })
      assert.equal(rows.length, 1, `${toolName}: ${rows.join('|')}`)
      assert.ok(!rows.some(row => row.includes('line 0') || row.includes('line 8')), toolName)
      assert.ok(!rows.some(row => row.includes('全文来源') || row.includes('ctrl+o 展开')), toolName)
    }
  })

  it('成功空输出只留标题，非 compact 仍保留无输出占位', () => {
    for (const toolName of ['bash', 'read_file', 'grep', 'write_file', 'todo', 'browser_debug']) {
      const rows = render({ toolName, content: '\n', compact: true })
      assert.equal(rows.length, 1, toolName)
      assert.ok(!rows.some(row => row.includes('(无输出)')), toolName)
    }
    assert.ok(render({ toolName: 'bash', content: '' }).some(row => row.includes('(无输出)')))
  })

  it('run 成功输出保留末尾 2 行，省略计数准确且只有一条提示', () => {
    const rows = render({
      toolName: 'bash', toolInput: { command: 'npm test' }, content: lines(6),
      compact: true, rawPath: '/tmp/run.log', maxLines: 8,
    })
    assert.equal(rows.length, 4, rows.join('|'))
    assert.ok(rows[1]!.includes('… +4 行 · ctrl+o 展开'), rows.join('|'))
    assert.ok(rows[2]!.includes('line 4') && rows[3]!.includes('line 5'), rows.join('|'))
    assert.ok(!rows.some(row => /line [0-3](?:\D|$)/.test(row)), rows.join('|'))
    assert.equal(expandHintCount(rows), 1, rows.join('|'))
    assert.ok(!rows.some(row => row.includes('显示') || row.includes('/tmp/run.log')), rows.join('|'))
  })

  it('other 成功输出保留开头 2 行，最多一条省略提示', () => {
    const rows = render({ toolName: 'todo', content: lines(5), compact: true })
    assert.equal(rows.length, 4, rows.join('|'))
    assert.ok(rows[1]!.includes('line 0') && rows[2]!.includes('line 1'), rows.join('|'))
    assert.ok(rows[3]!.includes('… +3 行 · ctrl+o 展开'), rows.join('|'))
    assert.ok(!rows.some(row => row.includes('line 4')))
    assert.equal(expandHintCount(rows), 1)
    assert.ok(!rows.some(row => row.includes('显示') || row.includes('全文来源')))
  })

  it('短输出不产生省略提示', () => {
    const rows = render({ toolName: 'bash', content: 'one\ntwo', compact: true })
    assert.equal(rows.length, 3)
    assert.equal(expandHintCount(rows), 0)
    assert.ok(rows[1]!.includes('one') && rows[2]!.includes('two'))
  })

  it('所有家族的错误都保留末尾最多 4 行诊断', () => {
    for (const toolName of ['bash', 'read_file', 'grep', 'todo']) {
      const rows = render({
        toolName, content: `${lines(6, 'noise')}\nError: boom`, isError: true,
        compact: true, rawPath: '/tmp/error.log',
      })
      assert.equal(rows.length, 6, `${toolName}: ${rows.join('|')}`)
      assert.ok(rows[1]!.includes('… +3 行 · ctrl+o 展开'), rows.join('|'))
      assert.ok(rows[2]!.includes('noise 3') && rows[5]!.includes('Error: boom'), rows.join('|'))
      assert.ok(!rows.some(row => row.includes('noise 2')), rows.join('|'))
      assert.equal(expandHintCount(rows), 1)
      assert.ok(!rows.some(row => row.includes('显示') || row.includes('全文来源') || row.includes('raw:')))
    }
  })

  it('错误即使形似 diff 也按诊断尾部展示，不进入成功 diff 分支', () => {
    const rows = render({
      toolName: 'apply_patch',
      content: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\nError: patch failed',
      isError: true,
      compact: true,
    })
    assert.ok(rows.some(row => row.includes('Error: patch failed')), rows.join('|'))
    assert.ok(rows.some(row => row.includes('… +2 行 · ctrl+o 展开')), rows.join('|'))
    assert.ok(!rows.some(row => row.includes('diff:')), rows.join('|'))
  })

  it('小 diff 与大 diff 统计保持原有可见性', () => {
    const small = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'
    const large = [
      'diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,6 +1,6 @@',
      '-a', '-b', '-c', '-d', '-e', '-f', '+A', '+B', '+C', '+D', '+E', '+F',
    ].join('\n')
    for (const content of [small, large]) {
      assert.deepEqual(
        formatToolCard({ toolName: 'edit_file', content, compact: true }, theme),
        formatToolCard({ toolName: 'edit_file', content }, theme),
      )
    }
  })

  it('ask_user_question 在 compact 下仍完整且保留空内容占位', () => {
    const content = 'Choose:\n1. OpenAI\n2. Anthropic\n3. Google\n4. DeepSeek\n5. Local'
    for (const value of [content, '']) {
      assert.deepEqual(
        formatToolCard({ toolName: 'ask_user_question', content: value, compact: true }, theme),
        formatToolCard({ toolName: 'ask_user_question', content: value }, theme),
      )
    }
  })

  it('streaming 普通输出与派发预览不受 compact 影响', () => {
    const inputs: Input[] = [
      { toolName: 'bash', content: lines(20), streaming: true },
      {
        toolName: 'delegate_batch', content: '', streaming: true,
        toolInput: { tasks: [{ objective: '保留完整派发预览' }] },
      },
    ]
    for (const input of inputs) {
      assert.deepEqual(
        formatToolCard({ ...input, compact: true }, theme),
        formatToolCard(input, theme),
      )
    }
  })

  it('expanded:true 优先于 compact 并完整展开', () => {
    const input: Input = { toolName: 'read_file', content: lines(30), expanded: true }
    assert.deepEqual(
      formatToolCard({ ...input, compact: true }, theme),
      formatToolCard(input, theme),
    )
  })

  it('expanded 详情在末尾只显示一次完整 rawPath，覆盖普通/diff/browser 分支', () => {
    const inputs: Input[] = [
      { toolName: 'bash', toolInput: { command: 'npm test' }, content: lines(12) },
      { toolName: 'edit_file', toolInput: { file_path: 'src/x.ts' }, content: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new' },
      { toolName: 'browser_debug', toolInput: { action: 'console' }, content: '[log] ready' },
    ]
    for (const input of inputs) {
      const rows = render({ ...input, rawPath: '/tmp/source.log', expanded: true, compact: true })
      const output = rows.join('\n')
      assert.equal(output.split('全文来源: /tmp/source.log').length - 1, 1, `${input.toolName}: ${output}`)
      assert.equal(output.split('/tmp/source.log').length - 1, 1, `${input.toolName}: ${output}`)
      assert.ok(rows[rows.length - 1]!.includes('全文来源: /tmp/source.log'), output)
    }
  })

  it('expanded 标题已展示完整 rawPath 时不在末尾重复', () => {
    const rows = render({
      toolName: 'bash', content: 'done', rawPath: '/tmp/source.log', expanded: true,
    })
    const output = rows.join('\n')
    assert.ok(rows[0]!.includes('/tmp/source.log'), output)
    assert.equal(output.split('/tmp/source.log').length - 1, 1, output)
    assert.ok(!rows.some(row => row.includes('全文来源')), output)
  })

  it('isToolCardTruncated 与 compact 的实际投影一致', () => {
    assert.equal(isToolCardTruncated({ toolName: 'read_file', content: 'one', compact: true }), true)
    assert.equal(isToolCardTruncated({ toolName: 'read_file', content: 'one', isError: true, compact: true }), false)
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: '1\n2\n3', compact: true }), true)
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: '1\n2', compact: true }), false)
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: lines(5), isError: true, compact: true }), true)
    assert.equal(isToolCardTruncated({ toolName: 'todo', content: '1\n2\n3', compact: true }), true)
    assert.equal(isToolCardTruncated({ toolName: 'ask_user_question', content: lines(9), compact: true }), false)
  })

  it('compact 的 ANSI/CJK 行仍不超终端宽度', async () => {
    const { displayWidth } = await import('../../width.js')
    const rows = formatToolCard({
      toolName: 'bash', content: '旧输出\n' + '中文输出需要按显示宽度安全截断'.repeat(4) + '\n最后异常',
      compact: true, columns: 28,
    }, theme)
    for (const row of rows) {
      assert.ok(displayWidth(stripAnsi(row), { ambiguousAsWide: true }) <= 27, stripAnsi(row))
    }
  })

  it('普通 compact 省略行在 40/20 列保留完整详情键', async () => {
    const { displayWidth } = await import('../../width.js')
    const previousWidthMode = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    try {
      for (const columns of [40, 20]) {
        for (const expandHint of ['ctrl+o 展开', '/pager → Enter 查看详情']) {
          for (const input of [
            { toolName: 'bash', content: lines(5) },
            { toolName: 'todo', content: lines(5) },
            { toolName: 'browser_debug', content: lines(5) },
            { toolName: 'bash', content: lines(7), isError: true },
          ]) {
            const rows = render({ ...input, compact: true, columns, expandHint })
            const expectedHint = columns === 20 && expandHint.startsWith('/pager') ? '/pager' : expandHint
            const marker = rows.find(row => row.includes(expectedHint))
            assert.ok(marker, `${input.toolName}: ${rows.join('|')}`)
            assert.ok(marker.includes('+3'), marker)
            assert.ok(!marker.includes('ctrl+…') && !marker.includes('/page…'), marker)
            assert.ok(!marker.includes('……') && !marker.includes('+…'), marker)
            assert.ok(rows.every(row => displayWidth(row, { ambiguousAsWide: true }) <= columns - 1), rows.join('|'))
          }
        }
      }
    } finally {
      if (previousWidthMode === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
      else process.env.RIVET_AMBIGUOUS_WIDTH = previousWidthMode
    }
  })

  it('expanded 长单行保留尾部，非 expanded 仍按 columns 安全截断', async () => {
    const { displayWidth } = await import('../../width.js')
    const previousWidthMode = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    try {
      const longLine = `begin-${'x'.repeat(120)}-tail-marker`
      const expandedRows = render({ toolName: 'bash', content: longLine, expanded: true, compact: true, columns: 20 })
      assert.ok(expandedRows.some(row => row.includes(longLine)), expandedRows.join('|'))

      const collapsedRows = render({ toolName: 'bash', content: longLine, columns: 20 })
      assert.ok(!collapsedRows.some(row => row.includes(longLine)), collapsedRows.join('|'))
      assert.ok(!collapsedRows.some(row => row.includes('tail-marker')), collapsedRows.join('|'))
      for (const row of collapsedRows) {
        assert.ok(displayWidth(row, { ambiguousAsWide: true }) <= 19, row)
      }
    } finally {
      if (previousWidthMode === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
      else process.env.RIVET_AMBIGUOUS_WIDTH = previousWidthMode
    }
  })

  it('expanded 窄屏标题裁掉 rawPath 时补一次完整来源行', async () => {
    const { setHyperlinksEnabled } = await import('../../engine/ansi.js')
    setHyperlinksEnabled(true)
    try {
      const rawPath = `/tmp/${'nested/'.repeat(12)}source-with-a-long-name.log`
      const rendered = formatToolCard({ toolName: 'bash', content: 'done', rawPath, expanded: true, columns: 20 }, theme)
      assert.ok(rendered[0]!.includes(rawPath), 'OSC 8 target still carries the path while its visible label is clipped')
      const rows = rendered.map(stripAnsi)
      const output = rows.join('\n')
      assert.ok(!rows[0]!.includes(rawPath), output)
      assert.equal(output.split(rawPath).length - 1, 1, output)
      assert.ok(rows.some(row => row.includes(`全文来源: ${rawPath}`)), output)
    } finally {
      setHyperlinksEnabled(null)
    }
  })

  it('ask_user_question 错误在 compact 下也保留全部问题和选项', () => {
    const content = ['请选择修复方案：', '1. 保留完整输出', '2. 丢弃问题', '3. 只显示尾窗', '4. 停止响应', '5. 其他'].join('\n')
    const input: Input = { toolName: 'ask_user_question', content, compact: true, isError: true }
    const output = render(input).join('\n')
    for (const line of content.split('\n')) assert.ok(output.includes(line), output)
    assert.ok(!output.includes('… +'), output)
    assert.equal(isToolCardTruncated(input), false)
  })

  it('expanded 大 diff 保留全部修改与长行，截断状态同步为 false', () => {
    const longAddition = `+${'x'.repeat(100)}-diff-tail-marker`
    const diff = [
      'diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,6 +1,6 @@',
      '-a', '-b', '-c', '-d', '-e', '-f', '+A', '+B', '+C', '+D', '+E', longAddition,
    ].join('\n')
    const input: Input = { toolName: 'edit_file', content: diff, columns: 24 }
    const output = render({ ...input, expanded: true }).join('\n')
    for (const line of ['-a', '-f', '+A', longAddition]) assert.ok(output.includes(line), output)
    assert.equal(isToolCardTruncated(input), true)
    assert.equal(isToolCardTruncated({ ...input, expanded: true }), false)
  })
})
