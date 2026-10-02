import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
/**
 * ghost text（P3-2）渲染层集成测试。
 *
 * 契约：
 * - 「/命令名+空格」+ 光标行尾 → 输入行内 █ 后出现暗色 argsHint；
 * - ghost 不顶位硬件光标（caretCol 只量 █ 左侧，IME 锚定回归钉）；
 * - 输入参数首字符后 ghost 消失；光标不在行尾时不显示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp(cols = 80): { app: TuiApp; out: MockOut; stdin: MockIn } {
  const out = new MockOut(cols, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols, rows: 24, modelName: 'test',
  })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.setSlashCommands([
    { name: '/effort', description: 'Set reasoning effort', argsHint: 'off|low|max' },
    { name: '/help', description: 'Show all commands' },
  ])
  return { app, out, stdin }
}

const tick = (ms = 30) => delay(ms)

test('ghost text：/effort+空格 → 输入行出现暗色 argsHint，硬件光标列不被顶位', async () => {
  // parking 默认开启（2026-07-24 重开）：帧末硬件光标应锚在 █ 左缘（G 13）。
  const { app, out, stdin } = makeApp()
  app.start()
  out.clear()
  for (const ch of '/effort ') stdin.dataHandler!(ch)
  await tick()

  const frame = out.chunks.join('')
  assert.ok(frame.includes('off|low|max'), 'ghost 参数提示应出现在输入行')
  // caretCol = 左边框 2 + '❯ ' 2 + '/effort ' 8 = 12 → 帧末定位第 13 列（█ 左缘）
  assert.ok(frame.includes('\x1B[13G'), `硬件光标应锚在 █ 左缘（ghost 不顶位）: ${JSON.stringify(frame.slice(-120))}`)
  app.dispose()
})

test('ghost text：输入参数首字符后提示消失', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  for (const ch of '/effort ') stdin.dataHandler!(ch)
  await tick()
  out.clear()
  stdin.dataHandler!('m')
  await tick()

  const frame = out.chunks.join('')
  assert.ok(!frame.includes('off|low|max'), '参数输入后 ghost 应消失')
  app.dispose()
})

test('ghost text：光标不在行尾时不显示', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  for (const ch of '/effort ') stdin.dataHandler!(ch)
  await tick()
  out.clear()
  // 光标左移一格（离开行尾）——移动本身触发重绘，新帧不应含 ghost
  stdin.dataHandler!('\x1B[D')
  await tick()

  const frame = out.chunks.join('')
  assert.ok(!frame.includes('off|low|max'), '光标离开行尾后 ghost 不显示')
  app.dispose()
})

test('vim 模式标签：normal/visual/visual-line 前缀随模式切换', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  // 启用 vim（/vim 命令切换路径之外的直接 API：setVimEnabled）
  ;(app as unknown as { inputLine: { setVimEnabled(v: boolean): void } }).inputLine.setVimEnabled(true)
  for (const ch of 'hello') stdin.dataHandler!(ch)
  await tick()
  out.clear()
  stdin.dataHandler!('\x1B') // → normal
  await delay(120)
  assert.ok(out.chunks.join('').includes('-- NORMAL --'), 'normal 模式前缀')

  out.clear()
  stdin.dataHandler!('v')
  await tick()
  assert.ok(out.chunks.join('').includes('-- VISUAL --'), 'charwise visual 前缀')

  out.clear()
  stdin.dataHandler!('\x1B') // visual → normal
  await delay(120)
  stdin.dataHandler!('V')
  await tick()
  assert.ok(out.chunks.join('').includes('-- VISUAL LINE --'), 'linewise visual 前缀')
  app.dispose()
})
