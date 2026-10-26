/**
 * T9 Tool Group Buffer 集成测试 — app.ts 接线防回归。
 *
 * 覆盖 #1-#4 + G4：
 *  #1 异族打断 → flush 完整组
 *  #2 并行 id 绑定正确性
 *  #3 read+grep+read 统一组摘要
 *  #4 collapsible terminal result → pendingTools 清理
 *  G4 flush 后迟到 result → 自动开新组，不产生 orphan 单卡
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

// ── minimal mocks ──────────────────────────────────────────────

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  app.registerOverlays({})
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

// ── helpers ────────────────────────────────────────────────────

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

function detailPlain(app: TuiApp): string {
  return stripAnsi((app as any).getPagerContent()?.content ?? '')
}

/** onToolResult 必须显式传 isError=false 才是 terminal result；undefined 会被当 streaming chunk */
function tr(app: TuiApp, id: string, name: string, result: string) {
  app.callbacks.onToolResult(id, name, result, false)
}

// ── #1: 异族打断 → flush 完整组 ───────────────────────────────

test('#1 read×3 + write → write 到达时 flush 3 条 read 的组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  tr(app, 'r2', 'read_file', 'content b')
  tr(app, 'r3', 'read_file', 'content c')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 3 files'), `expected 'Read 3 files' in: ${text.slice(0, 500)}`)
  assert.ok(!text.includes('content a'), 'default success group hides full output')
  assert.ok(!text.includes('content b'), 'default success group hides full output')
  assert.ok(!text.includes('content c'), 'default success group hides full output')
})

// ── #2: 并行 id 绑定正确性 ────────────────────────────────────

test('#2 read(id=A)+read(id=B) 并行，result(B) 先到 → 按 id 正确绑定', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('id-A', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('id-B', 'read_file', { file_path: 'b.ts' })
  tr(app, 'id-B', 'read_file', 'content B')
  tr(app, 'id-A', 'read_file', 'content A')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 2 files'), '2 read files in group')
  assert.ok(!text.includes('content A'), 'default group hides successful output')
  assert.ok(!text.includes('content B'), 'default group hides successful output')
  const group = (app as any).toolGroupController.getLastCollapsedGroup()
  assert.deepEqual(group.entries.map((entry: any) => [entry.id, entry.input.file_path, entry.content, entry.completed]), [
    ['id-A', 'a.ts', 'content A', true],
    ['id-B', 'b.ts', 'content B', true],
  ], 'out-of-order results must retain their tool id and file identity')
  ;(app as any).expandLastTruncatedTool()
  assert.equal(app.activeOverlayId(), 'pager')
  assert.match(detailPlain(app), /Write\s+out\.ts/, 'the newer ordinary result is the first detail target')
  app.deactivateOverlay()
  ;(app as any).expandLastTruncatedTool()
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal(scrollbackPlain(app), text, 'read-only detail must not append scrollback')
  const details = detailPlain(app)
  assert.match(details, /Read\s+a\.ts[^\n]*完成\n[^\n]*content A/, 'content A should be attached to a.ts when expanded')
  assert.match(details, /Read\s+b\.ts[^\n]*完成\n[^\n]*content B/, 'content B should be attached to b.ts when expanded')
})

// ── #3: read+grep+read 统一组 ─────────────────────────────────

test('#3 read+grep+read → 统一摘要含 Searched 1, Read 2', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'src/foo.ts' })
  tr(app, 'r1', 'read_file', 'foo')
  app.callbacks.onToolUse('g1', 'grep', { pattern: 'TODO', path: 'src/' })
  tr(app, 'g1', 'grep', 'match1')
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'src/bar.ts' })
  tr(app, 'r2', 'read_file', 'bar')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Searched 1 pattern'), `expected 'Searched 1 pattern': ${text.slice(0, 500)}`)
  assert.ok(text.includes('Read 2 files'), `expected 'Read 2 files': ${text.slice(0, 500)}`)
})

// ── #4: collapsible terminal result → pendingTools 清理 ───────

test('#4 collapsible terminal result 后 pendingTools 不残留', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.match(text, /Read\s+a\.ts · 完成/, 'completed read should be flushed')
  assert.equal((app as any).toolGroupController.getPendingSize(), 0, 'terminal tools must not leave pending cards')
  assert.equal((app as any).toolGroupController.isActiveGroup(), false, 'completed group must be flushed')
})

// ── G4: flush 后迟到 result → 自动开新组 ──────────────────────

test('G4 flush 后迟到 collapsible result → 自动开新组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  // r2 尚未完成，write 打断 → flush
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  // r2 迟到结果
  tr(app, 'r2', 'read_file', 'content b late')
  // 再打断 flush 新组
  app.callbacks.onToolUse('w2', 'write_file', { file_path: 'out2.ts' })
  tr(app, 'w2', 'write_file', 'ok2')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 1 file'), 'interrupted mixed group keeps an aggregate summary')
  assert.match(text, /Read\s+b\.ts · 完成/, 'late result opens and flushes its own group')
  assert.ok(!text.includes('content a'), 'default success output stays out of scrollback')
  assert.ok(!text.includes('content b late'), 'late success output also stays out of scrollback')
})

// ── 并行迟到：组活跃但不含该 id（比 G4 更窄的缺口）────────────
// 判据只问「有没有活跃组」时，err→ok→err 的第三跳会把结果丢进虚空：
// 第②跳成功开了新组且组仍活跃，第③跳错误的 id 属于已 flush 的旧组
// → 既不 pushUse（因为"有活跃组"）也不 attach（组里查无此人），结果静默丢弃。

test('并行 read 乱序 err→ok→err：第三个结果不丢（活跃组不含该 id）', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })

  app.callbacks.onToolResult('r1', 'read_file', 'boom a', true) // ① 错误 → 开组并立即 flush
  tr(app, 'r2', 'read_file', 'content b') // ② 成功 → 开新组，保持活跃
  app.callbacks.onToolResult('r3', 'read_file', 'boom c', true) // ③ 错误迟到 → 活跃组里没有 r3

  const text = scrollbackPlain(app)
  assert.ok(
    text.includes('c.ts'),
    `第三个结果必须出现在主屏（不能因为"有活跃组"就跳过登记）；实际前 400 字：${text.slice(0, 400)}`,
  )
  // 补：第三个结果落地不能以吞掉第二个结果为代价——第②跳的 r2 与迟到的 r3 同组，
  // 组因 isError flush，两条都要进来（成功项不逐条列名，聚合数 "Read 2 files" 即证据）。
  assert.ok(
    text.includes('Read 2 files'),
    `第二个结果（成功）也必须留在组里，否则只剩 Read 1 file；实际前 400 字：${text.slice(0, 400)}`,
  )
  ;(app as any).expandLastTruncatedTool()
  const details = detailPlain(app)
  assert.match(details, /boom c/, '第三个结果的内容必须能在详情里读到')
  assert.match(details, /content b/, '第二个结果的内容也必须保留在详情里')
  app.deactivateOverlay()
})

// 同族第二形态：第③跳是**成功**时错误路径不会替这组收尾，归组是否正确只能靠
// 主动 flush 照出来。修复前 r3 被丢，组里只剩 r2 —— 摘要显示「Read 1 file」。
test('并行 read 乱序 err→ok→ok：两跳成功结果都保留在同一组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })

  app.callbacks.onToolResult('r1', 'read_file', 'boom a', true) // ① 错误 → 开组并立即 flush
  tr(app, 'r2', 'read_file', 'content b') // ② 成功 → 开新组
  tr(app, 'r3', 'read_file', 'content c') // ③ 成功迟到 → 活跃组里没有 r3
  app.callbacks.onAbort() // 没有错误跳替它收尾，主动 flush 才能观察组内容

  const text = scrollbackPlain(app)
  assert.ok(
    text.includes('Read 2 files'),
    `两跳成功结果必须同组落地（修复前丢 r3 只剩 Read 1 file）；实际前 400 字：${text.slice(0, 400)}`,
  )
  assert.ok(!text.includes('content b'), '默认成功组隐藏正文')
  assert.ok(!text.includes('content c'), '默认成功组隐藏正文')
  ;(app as any).expandLastTruncatedTool()
  const details = detailPlain(app)
  assert.match(details, /content b/, '第二个结果的内容必须保留')
  assert.match(details, /content c/, '第三个结果的内容必须保留')
})

// ── turn 边界 flush ───────────────────────────────────────────

test('turnComplete 时 flush 残余折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)

  const text = scrollbackPlain(app)
  assert.match(text, /Read\s+a\.ts · 完成/, 'read should be flushed on turnComplete')
  assert.ok(!text.includes('content'), 'default scrollback keeps only the successful read title')
})

// ── abort 后 flush ────────────────────────────────────────────

test('abort 时 flush 残余折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  tr(app, 'r2', 'read_file', 'content b')
  // abort 应在清理前 flush 组
  app.callbacks.onAbort()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 2 files'), 'group should be flushed on abort')
  assert.ok(!text.includes('content a'), 'default success group hides full output')
  assert.ok(!text.includes('content b'), 'default success group hides full output')
  ;(app as any).expandLastTruncatedTool()
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal(scrollbackPlain(app), text, 'detail must not append scrollback after abort')
  const details = detailPlain(app)
  assert.match(details, /Read\s+a\.ts[^\n]*完成\n[^\n]*content a/, 'r1 content should be preserved after abort')
  assert.match(details, /Read\s+b\.ts[^\n]*完成\n[^\n]*content b/, 'r2 content should be preserved after abort')
})

// ── ctrl+o 展开 lastCollapsedGroup ────────────────────────────

test('flush 后 scrollback 中折叠组渲染正确，含 ctrl+o 提示', () => {
  const { app } = makeApp()
  app.setFrontendPreferences({ ...app.getFrontendPreferences(), keymap: 'legacy', bindings: {} })

  // read×4（超过 3 条）→ group flushed by write
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'line1\nline2\nline3\nline4\nline5')
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r2', 'read_file', 'b content')
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })
  tr(app, 'r3', 'read_file', 'c content')
  app.callbacks.onToolUse('r4', 'read_file', { file_path: 'd.ts' })
  tr(app, 'r4', 'read_file', 'd content')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 4 files'), 'collapsed group summary')
  assert.ok(text.includes('ctrl+o 展开'), 'should hint ctrl+o for >3 entries')
  assert.ok(!text.includes('a.ts'), 'multi-entry success summary omits individual paths')
  assert.ok(!text.includes('b.ts'), 'multi-entry success summary omits individual paths')
})



// ── zen_unlock：虚拟工具的结果不落 scrollback（改走 glance bar 限时提示） ──
// 用户报告「禅解除提示一直挂在推理区下面」：该虚拟工具没有第二次回调，普通结果
// 渲染路径会把它累积进 live 工具卡并永远等不到终态。

test('zen_unlock 结果不落 scrollback（相位状态由徽章表达，通知走限时提示）', () => {
  const { app } = makeApp()
  app.callbacks.onToolResult('u1', 'zen_unlock', '禅模式已解除：全量工具面已恢复，可调用任意工具。', false)

  assert.ok(
    !scrollbackPlain(app).includes('禅模式已解除'),
    'zen_unlock 的结果不得进 scrollback（此前会永久悬停在 live 区）',
  )
})

test('对照：普通工具的 terminal 结果照常落 scrollback（防上面的断言空对空）', () => {
  const { app } = makeApp()
  // 与 #1 同款：先 onToolUse 注册，再由异族工具到达触发组 flush
  app.callbacks.onToolUse('t1', 'read_file', { file_path: 'zen-notice-control.ts' })
  tr(app, 't1', 'read_file', 'file content here')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const plain = scrollbackPlain(app)
  assert.ok(
    plain.includes('zen-notice-control.ts'),
    `普通工具结果必须进 scrollback，否则对照失效。实际前 200 字：${plain.slice(0, 200)}`,
  )
})

// ── zen_unlock 虚拟工具：不进 pending、结果不挂卡 ─────────────
// 回归锚（用户实测「zen_unlock (22m48s) 仍无输出」悬停卡）：虚拟工具的 TTL 提示
// 拦截了结果渲染，但 pending 条目没人清——live 卡永远等不到终态。

test('zen_unlock：onToolUse 不建 pending，结果只留 TTL 提示', () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('z1', 'zen_unlock', {})
  assert.equal((app as any).toolGroupController.getPendingSize(), 0, '虚拟工具不得建 pending 卡')
  tr(app, 'z1', 'zen_unlock', '禅模式已解除')
  assert.equal((app as any).toolGroupController.getPendingSize(), 0)
  assert.ok((app as any).zenUnlockNoticeUntil > Date.now(), 'TTL 提示应已设置')
})

test('zen_unlock：即便 pending 被其它路径建过，结果到达时也防御性清除', () => {
  const { app } = makeApp()
  ;(app as any).toolGroupController.setPending('z9', { name: 'zen_unlock', input: {}, startMs: Date.now() })
  tr(app, 'z9', 'zen_unlock', '禅模式已解除')
  assert.equal((app as any).toolGroupController.getPendingSize(), 0, '悬停卡必须清除')
})
