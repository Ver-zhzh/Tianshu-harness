import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { makeApp } from './_harness.js'
import type { LiveRegionLine } from '../live-engine.js'
import { displayWidth } from '../../width.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const count = (text: string, needle: string) => text.split(needle).length - 1

test('hardware cursor remains visible at the composer without a software marker', t => {
  const { app, out } = makeApp()
  t.after(() => app.dispose())
  const rendered = out.chunks.join('')
  assert.match(rendered, /\x1b\[\d+G\x1b\[\?25h\x1b\[\?2026l/)
  assert.ok(!plain(rendered).includes('❯ █'))
})

for (const cols of [120, 40, 20]) {
  test(`${cols} 列经典主屏只在历史记录提问，活动状态贴近输入框`, async t => {
    const { app, stdin } = makeApp({ cols, rows: 30 })
    t.after(() => app.dispose())
    const live = (app as any).live as {
      render: (lines: LiveRegionLine[], options?: { reservedTail?: number }) => void
    }
    const original = live.render.bind(live)
    let frame: LiveRegionLine[] = [], reservedTail = 0
    live.render = (lines, options) => {
      frame = lines.map(line => ({ ...line }))
      reservedTail = options?.reservedTail ?? 0
      original(lines, options)
    }
    app.onSubmit(() => {})
    const prompt = 'tui的改造都改了什么'
    app.setInput(prompt)
    stdin.dataHandler!('\r')
    await tick()
    app.callbacks.onThinkingDelta('正在分析工具记录')
    await tick()

    const history = plain(app.getScrollbackContent()).replace(/\s+/g, '')
    assert.equal(count(history, prompt), 1, '用户提问只提交一次')
    assert.ok(!frame.some(line => line.livePart === 'pinned'), '经典 live 区不复写提问')
    const status = frame.findIndex(line => line.livePart === 'status')
    const mode = frame.findIndex(line => line.region === 'mode')
    const composer = frame.findIndex(line => line.region === 'composer')
    assert.ok(status >= frame.length - reservedTail && status < mode, '活动状态属于输入框上方 chrome')
    assert.ok(mode < composer, '指标行仍紧邻输入框')
    assert.ok(displayWidth(frame[status]!.text, { ambiguousAsWide: true }) < cols, '活动状态不能超出终端宽度')

    app.callbacks.onToolUse('tool', 'run_tests', { command: 'pwd' })
    app.callbacks.onToolResult('tool', 'run_tests', 'one\ntwo\nthree', false)
    assert.equal(count(plain(app.getScrollbackContent()).replace(/\s+/g, ''), prompt), 1, '工具提交不能重复提问')
  })
}

for (const outcome of ['complete', 'error', 'abort'] as const) {
  test(`${outcome} 后活动状态退场，历史提问保持一份`, async t => {
    const { app, stdin } = makeApp({ cols: 80, rows: 24 })
    t.after(() => app.dispose())
    const live = (app as any).live as { render: (lines: LiveRegionLine[], options?: { reservedTail?: number }) => void }
    const original = live.render.bind(live)
    let frame: LiveRegionLine[] = []
    live.render = (lines, options) => { frame = lines.map(line => ({ ...line })); original(lines, options) }
    app.onSubmit(() => {})
    app.setInput('检查状态收口')
    stdin.dataHandler!('\r')
    await tick()
    app.callbacks.onThinkingDelta('分析中')
    await tick()
    assert.ok(frame.some(line => line.livePart === 'status'))

    if (outcome === 'complete') {
      app.callbacks.onTurnComplete({}, 1, true)
      await tick()
      app.notifyRunSettled()
    } else if (outcome === 'error') app.callbacks.onError(new Error('测试错误'))
    else app.callbacks.onAbort('已中断')
    await tick()

    assert.ok(!frame.some(line => line.livePart === 'status'), '终态不能继续显示思考中')
    assert.equal(count(plain(app.getScrollbackContent()).replace(/\s+/g, ''), '检查状态收口'), 1)
    assert.ok(!frame.some(line => line.livePart === 'pinned'))
  })
}
