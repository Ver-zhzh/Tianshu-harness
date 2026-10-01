/**
 * 标准 Ctrl+T 打开任务；/thinking 只读查看已有内容，不 take 或重印主会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'

class MockOut {
  columns = 80
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
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
    cols: 80, rows: 24, modelName: 'test',
  })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic', bindings: {} })
  app.registerOverlays({})
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))
/** 终端把 Ctrl+T 送达为单控制字节 DC4(0x14)，走真实解析器。 */
const CTRL_T = '\x14'

interface Internals {
  thinkingReview: { save(r: { text: string; elapsedMs: number }): void; peek(): unknown }
  agentBusy: boolean
}

test('agent 忙时标准 ctrl+t 打开任务且不取走思考内容', async () => {
  const { app, stdin } = makeApp()
  const internals = app as unknown as Internals
  internals.thinkingReview.save({ text: '一段思考正文', elapsedMs: 3_000 })
  internals.agentBusy = true

  stdin.dataHandler!(CTRL_T)
  await tick()

  assert.notEqual(internals.thinkingReview.peek(), null, '忙时不得取走回看仓（重印不可撤回）')
  assert.equal(app.activeOverlayId(), 'tasks')
})

test('空闲时 /thinking 打开只读详情并保留回看仓', async () => {
  const { app, out, stdin } = makeApp()
  const internals = app as unknown as Internals
  internals.thinkingReview.save({ text: '一段思考正文', elapsedMs: 3_000 })
  internals.agentBusy = false

  stdin.dataHandler!('/thinking\r')
  await tick()

  assert.deepEqual(internals.thinkingReview.peek(), { text: '一段思考正文', elapsedMs: 3_000 }, '只读详情不 take')
  assert.equal(app.activeOverlayId(), 'pager')
  assert.ok(out.chunks.join('').includes('思考详情') && out.chunks.join('').includes('一段思考正文'), '显示真实已有内容')
})
