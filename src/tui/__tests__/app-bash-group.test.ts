/**
 * T9 Bash Group Buffer 集成测试 — app.ts 接线。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

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
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

/** terminal result */
function tr(app: TuiApp, id: string, name: string, result: string, isError = false) {
  app.callbacks.onToolResult(id, name, result, isError)
}

// ── 基本折叠 ───────────────────────────────────────────────────

test('3 个短 bash 命令折叠为 "Ran 3 shell commands"', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  app.callbacks.onToolUse('b3', 'bash', { command: 'whoami' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt\nb.txt')
  tr(app, 'b3', 'bash', 'user')
  // 用一个 write 打断 flush
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 3 shell commands'), `expected summary in: ${text.slice(0, 500)}`)
  assert.ok(!text.includes('/home/user'), 'default success group hides full output')
  assert.ok(!text.includes('a.txt'), 'default success group hides full output')
})

// ── 变更型 bash 打断折叠 ───────────────────────────────────────

test('变更型 bash 打断前面的可折叠 bash 组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  // rm 不可折叠，应 flush 前面 2 条 bash 组，再单独渲染 rm
  app.callbacks.onToolUse('b3', 'bash', { command: 'rm -rf temp' })
  tr(app, 'b3', 'bash', '', false)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'first 2 bash should be grouped')
  // rm 应作为独立 tool card 渲染（包含命令摘要）
  assert.ok(text.includes('rm -rf temp'), 'rm command should be rendered individually')
})

// ── 错误命令打断折叠 ───────────────────────────────────────────

test('bash 错误命令把前面成功命令摘要后单独渲染错误卡片', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  app.callbacks.onToolUse('b3', 'bash', { command: 'cat missing' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  tr(app, 'b3', 'bash', 'No such file', true)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'first 2 success should be grouped')
  assert.ok(text.includes('No such file'), 'error output should be visible')
  assert.ok(text.includes('cat missing'), 'error command should be visible')
})

// ── read/search 与 bash 汇入统一执行过程 ───────────────────────

test('read 与 bash 交替时合并为统一执行过程，详情保留全部结果', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  tr(app, 'b1', 'bash', '/home/user')
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b2', 'bash', 'b.txt')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)

  const text = scrollbackPlain(app)
  assert.match(text, /执行过程 · 3 工具 · 阅读 1 · 命令 2/, 'alternating families share one process summary')
  assert.equal(text.split('执行过程 ·').length - 1, 1, 'only one process summary is committed')
  assert.ok(!/Run\s+pwd · 完成/.test(text), 'individual group titles are folded into the process summary')

  ;(app as any).expandLastTruncatedTool()
  const detail = stripAnsi((app as any).detailPager?.content ?? '')
  for (const content of ['/home/user', 'content a', 'b.txt']) {
    assert.ok(detail.includes(content), `process detail must retain ${content}`)
  }
  app.deactivateOverlay()
})

// ── turn 边界 flush ────────────────────────────────────────────

test('turnComplete 时 flush 残余 bash 折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  tr(app, 'b1', 'bash', '/home/user')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)

  const text = scrollbackPlain(app)
  assert.match(text, /Run\s+pwd · 完成/, 'command should be flushed on turnComplete')
  assert.ok(!text.includes('/home/user'), 'default scrollback keeps only the successful command title')
})

// ── abort flush ───────────────────────────────────────────────

test('abort 时 flush 残余 bash 折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  app.callbacks.onAbort()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'group should be flushed on abort')
})

// ── 非折叠 bash 不进入组 ───────────────────────────────────────

test('单个变更型 bash 直接渲染 tool card，不生成折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'git commit -m "x"' })
  tr(app, 'b1', 'bash', '[main abc123] x')

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('Ran 1 shell command'), 'should not create a collapsed bash group')
  assert.ok(text.includes('git commit'), 'should render command as tool card')
})
