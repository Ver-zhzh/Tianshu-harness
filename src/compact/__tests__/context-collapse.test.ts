import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collapseToolResult } from '../context-collapse.js'

describe('collapseToolResult', () => {
  it('returns null for small content', () => {
    assert.equal(collapseToolResult('grep', 'short', 5, 200_000), null)
  })

  it('returns null for recent results (turnAge < 2)', () => {
    assert.equal(collapseToolResult('grep', 'x'.repeat(500), 0, 200_000), null)
    assert.equal(collapseToolResult('grep', 'x'.repeat(500), 1, 200_000), null)
  })

  it('collapses grep results with file and match info', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `src/file${i % 5}.ts:${i}: const x = ${i}`,
    )
    const result = collapseToolResult('grep', lines.join('\n'), 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed grep'))
    assert.ok(result!.summary.includes('matches'))
    assert.ok(result!.summary.includes('files'))
    assert.ok(result!.collapsedTokens < result!.originalTokens)
  })

  it('counts only grep match records, excluding context, truncation and edit hints', () => {
    const matches = Array.from({ length: 20 }, (_, i) => `src/a.ts:${i + 1}: needle`)
    const result = collapseToolResult('grep', [
      ...matches, 'src/a.ts-21-context',
      '[truncated: showing 20 matches — result was cut short, use max_results to see more]',
      'hash_edit 锚点（src/a.ts）：', '  L1:abcdef',
    ].join('\n'), 5, 200_000)!
    assert.match(result.summary, /20 matches in 1 files: src\/a.ts/)
    assert.doesNotMatch(result.summary, /\[truncated|hash_edit|context/)
    assert.match(collapseToolResult('grep', 'src/a.ts:>   3│ needle\n' + 'x'.repeat(200), 5, 200_000)!.summary, /1 matches in 1 files/)
  })

  // ── 台账 F4：静默子集化（2026-09-14）────────────────────────────
  // 工具层对超大结果返回「head/tail 截断正文 + 全量统计 + artifact 引用」；
  // 折叠层若用截断后的正文重算行数，会把 head 的 8 行包装成「8 matches in
  // 4 files」的完整读数（实测 65/20 被抹成 8/4，且无任何残缺标记可辨）。
  it('含 artifact 的已截断 grep 结果：不重算残缺正文——沿用全量统计', () => {
    const truncatedHead = [
      '/repo/src/agent/evidence.ts:1: checkTddGate(',
      '/repo/src/agent/evidence.ts:2: checkTddGate(',
      '/repo/src/agent/tdd-gate.ts:215: export function checkTddGate(',
      '/repo/src/agent/tdd-gate.ts:245: checkTddGate',
      '/repo/src/agent/context.ts:1: checkTddGate(',
      '/repo/src/agent/context.ts:2: checkTddGate(',
      '/repo/src/agent/context.ts:3: checkTddGate(',
      '/repo/src/agent/turn-step-producer.ts:1132: checkTddGate(',
    ].join('\n')
    const content = [
      truncatedHead,
      '... (truncated, use offset/limit for more specific ranges)',
      'grep "checkTddGate|filesRead": 65 matches in 20 files. Files: src/agent/evidence.ts (+15)',
      '使用 read_section(artifactId="grep:abc", section="L1-L500") 获取完整匹配列表。',
      '[artifact:grep:abc]',
    ].join('\n')
    const result = collapseToolResult('grep', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(
      !result!.summary.includes('8 matches in 4 files'),
      `折叠不得重算残缺正文的统计：${result!.summary}`,
    )
    assert.ok(
      result!.summary.includes('65 matches in 20 files'),
      `应沿用工具层的全量统计：${result!.summary}`,
    )
    assert.ok(result!.summary.includes('artifact'), `应保留回读句柄：${result!.summary}`)
  })

  it('collapses read_file results with structural info', () => {
    const content = [
      'export class Foo {',
      '  constructor() {}',
      '}',
      'export function bar() {}',
      'export async function baz() {}',
      ...Array.from({ length: 50 }, (_, i) => `  line ${i}`),
    ].join('\n')
    const result = collapseToolResult('read_file', content, 4, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed read_file'))
    assert.ok(result!.summary.includes('lines'))
  })

  it('collapses bash results with tail lines', () => {
    const content = Array.from({ length: 30 }, (_, i) => `Building module ${i}...`).join('\n')
    const result = collapseToolResult('bash', content, 6, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed bash'))
    assert.ok(result!.summary.includes('lines output'))
  })

  it('collapses write_file results', () => {
    const result = collapseToolResult('write_file', 'x'.repeat(1000), 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed write_file'))
    assert.ok(result!.summary.includes('chars written'))
  })

  it('collapses unknown tool types with generic summary', () => {
    const content = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join('\n')
    const result = collapseToolResult('custom_tool', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed custom_tool'))
    assert.ok(result!.summary.includes('Preview'))
  })

  it('achieves significant compression ratio', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      `src/components/Widget${i}.tsx:${i * 10}: export const Widget${i} = () => <div>Widget ${i}</div>`,
    )
    const content = lines.join('\n')
    const result = collapseToolResult('grep', content, 5, 200_000)!
    assert.ok(result.collapsedTokens / result.originalTokens < 0.1, 'should achieve >90% compression')
  })

  it('handles search tool same as grep', () => {
    const content = 'src/a.ts:1: hello\nsrc/b.ts:2: world\n' + 'x'.repeat(200)
    const result = collapseToolResult('search', content, 4, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed search'))
  })

  // T7 layering: preserve artifact references so request-layer folding does not
  // become a recall blind spot.
  it('preserves an [artifact:id] reference in the collapsed summary', () => {
    const content = `[artifact:read_file:abc12345] big file summary\n${'x'.repeat(500)}`
    const result = collapseToolResult('read_file', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.match(result!.summary, /read_section artifact:read_file:abc12345/)
    // The recall hint stays inside the bracketed collapsed marker.
    assert.ok(result!.summary.endsWith(']'))
  })

  it('leaves the summary unchanged when there is no artifact reference', () => {
    const content = 'plain bash output\n' + 'x'.repeat(500)
    const result = collapseToolResult('bash', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.doesNotMatch(result!.summary, /artifact:/)
  })

  it('does not duplicate an artifact reference already present in the summary', () => {
    // generic collapse includes a content preview, which itself contains the marker
    const content = `[artifact:bash:dup99] line one\nline two\nline three\n${'x'.repeat(300)}`
    const result = collapseToolResult('custom_tool', content, 5, 200_000)
    assert.notEqual(result, null)
    const occurrences = (result!.summary.match(/bash:dup99/g) ?? []).length
    assert.equal(occurrences, 1, 'reference must not be appended twice')
  })

  // ── run_tests collapse ──

  it('collapses run_tests with passed/failed counts and exit code', () => {
    const content = [
      '退出码：1',
      '18 通过，2 失败，0 跳过',
      '',
      '✗ test at src/foo.test.ts:42 — should handle edge case',
      '✗ test at src/bar.test.ts:88 — timeout exceeded',
      ...Array.from({ length: 20 }, (_, i) => `detail line ${i}`),
    ].join('\n')
    const result = collapseToolResult('run_tests', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed run_tests'), `got: ${result!.summary}`)
    assert.ok(result!.summary.includes('18/20 passed'), `should show passed count, got: ${result!.summary}`)
    assert.ok(result!.summary.includes('2 failed'), `should show failed count, got: ${result!.summary}`)
    assert.ok(result!.summary.includes('exit 1'), `should show exit code, got: ${result!.summary}`)
  })

  it('run_tests collapse: all-pass result does NOT report failures', () => {
    const content = [
      '退出码：0',
      '20 通过，0 失败，0 跳过',
      ...Array.from({ length: 20 }, (_, i) => `detail line ${i}`),
    ].join('\n')
    const result = collapseToolResult('run_tests', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('20/20 passed'), `got: ${result!.summary}`)
    assert.ok(!result!.summary.includes('failed'), `should not mention failed when 0, got: ${result!.summary}`)
  })

  // ── delegate_task collapse ──

  it('collapses delegate_task with worker profile', () => {
    const content = [
      'profile: code_scout',
      '',
      'Found 3 matches for the query "authentication middleware" across the codebase.',
      'The auth middleware is implemented in src/auth/middleware.ts and handles',
      ...Array.from({ length: 20 }, (_, i) => `detail ${i}`),
    ].join('\n')
    const result = collapseToolResult('delegate_task', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed delegate_task'), `got: ${result!.summary}`)
    assert.ok(result!.summary.includes('code_scout'), `should include profile, got: ${result!.summary}`)
  })

  it('collapses delegate_batch same as delegate_task', () => {
    const content = [
      'worker: reviewer completed analysis',
      ...Array.from({ length: 30 }, (_, i) => `finding ${i}`),
    ].join('\n')
    const result = collapseToolResult('delegate_batch', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed delegate_batch'), `got: ${result!.summary}`)
    assert.ok(result!.summary.includes('reviewer'), `should include profile, got: ${result!.summary}`)
  })
})
