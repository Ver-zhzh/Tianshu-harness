/**
 * 流式文本 ↔ 工具组的 commit 顺序契约。
 *
 * 事故形状（用户 2026-09-26 报告，本会话实况）：agent 给出交付结论 → 系统注入
 * 「还有内容没处理」→ agent 跑工具核对 → 再给结论。用户最后只看到第二段结论，
 * 第一段的尾段像被工具组吞掉。
 *
 * 机制：`handleToolUse` 在工具开始时不 flush 前面的文本流，而 `streamRenderer`
 * 只在**回合结束**（handleTurnComplete）才 finalize。BlockStreamWriter 的出口
 * 阈值（首块 15 字符、之后 100 字符 / 段落切点须落在 minChars*0.5 之后）意味着
 * 长文本会被切成多块依次落盘，**最后一块不足阈值则滞留在 buffer 里**——工具组
 * 抢先 commit 到 scrollback，顺序颠倒成「工具组 → 文本尾」。
 *
 * 注意构造：测试文本必须长到能触发吐块（否则整体滞留，那只是缓冲未满，属另一个
 * 现象，会掩盖本缺陷）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

// ── minimal mocks（与 app-tool-group.test.ts 同构）──────────────

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
  app.start()
  return { app }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

/** 一次「折叠型工具 + 非折叠工具」的最小序列，确保工具组落到 scrollback。 */
function runOneToolPair(app: TuiApp): void {
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolResult('r1', 'read_file', 'content a', false)
  // write_file 非同族 → 打断并 flush 前面的 read 组
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'b.ts' })
  app.callbacks.onToolResult('w1', 'write_file', 'ok', false)
}

/** 足长到触发吐块：稳定部分落盘，尾段（不足出口阈值）仍留在 buffer。 */
const TAIL = 'TAIL_MARKER 尾段内容。'
const LONG_TEXT = `### 做了什么\n\n提交 abc1234。\n\n### 后续建议\n\n${TAIL}`

// ── 核心回归：尾段不得被工具组抢位 ────────────────────────────

test('文本尾段先于工具组落盘——不得被工具输出劈成两半', () => {
  const { app } = makeApp()

  app.callbacks.onTextDelta(LONG_TEXT)
  runOneToolPair(app)

  const text = stripAnsi(app.getScrollbackContent())
  const toolAt = text.search(/Read\s+a\.ts · 完成/)
  assert.ok(toolAt >= 0, `工具组应已落盘：${JSON.stringify(text.slice(0, 400))}`)
  const tailAt = text.indexOf(TAIL)
  assert.ok(
    tailAt >= 0,
    `尾段必须已落盘，不能滞留到回合结束：${JSON.stringify(text.slice(0, 400))}`,
  )
  assert.ok(
    tailAt < toolAt,
    `尾段必须排在工具组之前，不能被工具组劈开。实际：${JSON.stringify(text.slice(0, 400))}`,
  )
})

test('前置稳定块也已落盘，且序在工具组之前', () => {
  const { app } = makeApp()

  app.callbacks.onTextDelta(LONG_TEXT)
  runOneToolPair(app)

  const text = stripAnsi(app.getScrollbackContent())
  const headAt = text.indexOf('提交 abc1234。')
  const toolAt = text.search(/Read\s+a\.ts · 完成/)
  assert.ok(headAt >= 0 && headAt < toolAt, `稳定块应序在工具组之前：${JSON.stringify(text.slice(0, 400))}`)
})

// ── 反向守卫：文本不被重复 commit ─────────────────────────────

test('尾段落盘后不重复出现', () => {
  const { app } = makeApp()

  app.callbacks.onTextDelta(LONG_TEXT)
  runOneToolPair(app)

  const text = stripAnsi(app.getScrollbackContent())
  const occurrences = text.split(TAIL).length - 1
  assert.equal(occurrences, 1, `尾段不得重复 commit，实际出现 ${occurrences} 次`)
})
