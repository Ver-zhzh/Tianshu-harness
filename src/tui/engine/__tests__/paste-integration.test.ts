/**
 * T9 bracketed paste 集成测试（C1）。
 *
 * 契约：
 * - start() 写 \x1B[?2004h，dispose() 写 \x1B[?2004l。
 * - 粘贴多行（含 \r）经 200~/201~ 包裹 → 整段插入输入框，不触发 submit。
 * - 「一整段图片路径」（单行或多行）→ 挂成附件而不是文本（见 image-paste.ts）。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { setClipboardReader } from '../clipboard-image.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

// 粘贴测试隔离系统剪贴板——onPaste 现在会先尝试读剪贴板图片（修复右键粘贴丢图），
// 测试环境注入「无图」reader 确保走文本路径，不受本机剪贴板当前内容影响。
beforeEach(() => { setClipboardReader({ readText: async () => null, readImage: async () => null }) })
afterEach(() => { setClipboardReader(null) })

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

test('start/dispose 切换 bracketed paste 模式', () => {
  const { app, out } = makeApp()
  app.start()
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004h')), 'start 启用 paste')
  app.dispose()
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004l')), 'dispose 关闭 paste')
})

test('多行粘贴整段进输入框，不触发 submit', async () => {
  const { app, stdin } = makeApp()
  let submits = 0
  app.onSubmit(() => { submits++ })

  stdin.dataHandler!('\x1B[200~line1\r\nline2\x1B[201~')
  await tick()

  assert.equal(app.getInputValue(), 'line1\nline2', '两行合一、CRLF 规范化')
  assert.equal(submits, 0, '粘贴不应触发 submit')
})

test('粘贴插入到光标处（已有文本之间）', async () => {
  const { app, stdin } = makeApp()
  app.setInput('AB')
  // 光标在末尾；先左移一位到 A|B
  stdin.dataHandler!('\x1B[D')
  await tick()
  stdin.dataHandler!('\x1B[200~X\x1B[201~')
  await tick()
  assert.equal(app.getInputValue(), 'AXB', '插入到光标处')
})

test('右键粘贴：剪贴板有图时附图，不插入乱码文本', async () => {
  // 模拟右键粘贴——终端把图片字节当文本注入 stdin（bracketed paste 包裹），
  // 同时系统剪贴板里确实有图。onPaste 应优先读剪贴板附图，吞掉乱码文本。
  setClipboardReader({ readText: async () => null, readImage: async () => ({ dataUrl: 'data:image/png;base64,iVBOR=', mime: 'image/png', name: 'clipboard.png', source: 'png' }) })
  const { app, stdin } = makeApp()
  app.start()
  // 模拟终端注入的图片字节乱码（实际是二进制被 UTF-8 解码的残留）
  stdin.dataHandler!('\x1B[200~\ufffd\ufffd\ufffd\x00\x01\x02\x1b[201~')
  await tick(30)
  // 图片被附加（不是文本）
  assert.equal(app.getInputImagesCount(), 1, '应附加 1 张图片')
  assert.equal(app.getInputValue(), '', '乱码文本不应进入输入框')
  app.dispose()
})

test('右键粘贴：剪贴板无图时正常插入文本', async () => {
  // 无图时 onPaste 应回退到文本路径（已由 beforeEach 的 null reader 覆盖，
  // 这里显式再测一次确保回退逻辑正确）
  setClipboardReader({ readText: async () => null, readImage: async () => null })
  const { app, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~hello world\x1B[201~')
  await tick(30)
  assert.equal(app.getInputValue(), 'hello world', '无图时文本正常插入')
  assert.equal(app.getInputImagesCount(), 0, '不应附加图片')
  app.dispose()
})

test('性能契约：普通文本粘贴不读剪贴板图片', async () => {
  // onPaste 只在粘贴文本像二进制乱码时才去读剪贴板。旧实现无条件读——
  // macOS 无 native 读图包时退化为 spawn osascript，本机实测每次普通文本粘贴
  // 被推迟 410–707ms（端到端中位 512ms，跳过读图后 5ms）。
  let readCalls = 0
  setClipboardReader({ readText: async () => null,
    readImage: async () => { readCalls++; return null },
  })
  const { app, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~const a = 1\x1B[201~')
  await tick(30)
  assert.equal(app.getInputValue(), 'const a = 1', '文本正常插入')
  assert.equal(readCalls, 0, '普通文本粘贴不应触发剪贴板读图（每次约 0.5s）')
  app.dispose()
})

test('性能契约：多行/中文粘贴同样走零等待快路径', async () => {
  let readCalls = 0
  setClipboardReader({ readText: async () => null,
    readImage: async () => { readCalls++; return null },
  })
  const { app, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~第一行 🎉\r\nsecond line\x1B[201~')
  await tick(30)
  assert.equal(app.getInputValue(), '第一行 🎉\nsecond line', 'CRLF 规范化 + 原样插入')
  assert.equal(readCalls, 0, '中文/emoji/多行仍属正常文本')
  app.dispose()
})

test('防乱码防御未退化：乱码粘贴仍读剪贴板并附图', async () => {
  let readCalls = 0
  setClipboardReader({ readText: async () => null,
    readImage: async () => {
      readCalls++
      return { dataUrl: 'data:image/png;base64,iVBOR=', mime: 'image/png', name: 'clipboard.png', source: 'png' }
    },
  })
  const { app, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~\ufffd\ufffd\ufffd\x00\x01\x02\x1b[201~')
  await tick(30)
  assert.equal(readCalls, 1, '乱码粘贴应尝试读剪贴板图片')
  assert.equal(app.getInputImagesCount(), 1, '应附加 1 张图片')
  assert.equal(app.getInputValue(), '', '乱码文本不应进入输入框')
  app.dispose()
})

// ── 图片路径粘贴（多行一次贴完）────────────────────────────────────────────────

// 1x1 透明 PNG：provider 安全格式、远小于软目标，加载不需要图像工具。
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function withPngFiles(names: string[], fn: (paths: string[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-paste-'))
  const paths = names.map((n) => join(dir, n))
  for (const p of paths) writeFileSync(p, Buffer.from(PNG_1X1, 'base64'))
  try {
    await fn(paths)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('多行图片路径一次粘贴 → 全部挂成附件，路径文本不进输入框', async () => {
  await withPngFiles(['a.png', 'b.png'], async ([a, b]) => {
    const { app, stdin } = makeApp()
    app.start()
    stdin.dataHandler!(`\x1B[200~${a}\r\n${b}\x1B[201~`)
    await tick(60)
    assert.equal(app.getInputImagesCount(), 2, '两行路径都要成为附件')
    assert.equal(app.getInputValue(), '', '路径文本不该进输入框')
    app.dispose()
  })
})

test('单行路径仍是老行为：1 张附件、无文本', async () => {
  await withPngFiles(['only.png'], async ([only]) => {
    const { app, stdin } = makeApp()
    app.start()
    stdin.dataHandler!(`\x1B[200~${only}\x1B[201~`)
    await tick(60)
    assert.equal(app.getInputImagesCount(), 1)
    assert.equal(app.getInputValue(), '')
    app.dispose()
  })
})

test('路径与文本混着粘 → 整段按文本插入（不挑路径、不吞行）', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~看这张\r\n/tmp/whatever.png\x1B[201~')
  await tick(60)
  assert.equal(app.getInputImagesCount(), 0, '混了文本就不是图片粘贴')
  assert.equal(app.getInputValue(), '看这张\n/tmp/whatever.png', '两行都得原样保留')
  assert.ok(!stripAnsi(out.chunks.join('')).includes('图片加载失败'))
  app.dispose()
})

test('部分加载失败：成功的挂上、失败的报错，路径文本不塞进输入框', async () => {
  const missing = join(tmpdir(), `rivet-missing-${Date.now()}.png`)
  await withPngFiles(['ok.png'], async ([ok]) => {
    const { app, out, stdin } = makeApp()
    app.start()
    stdin.dataHandler!(`\x1B[200~${ok}\r\n${missing}\x1B[201~`)
    await tick(60)
    assert.equal(app.getInputImagesCount(), 1, '成功的那张贴上')
    assert.equal(app.getInputValue(), '', '不能把失败的路径当文本插进去')
    assert.ok(stripAnsi(out.chunks.join('')).includes('图片加载失败'), '失败必须可见')
    app.dispose()
  })
})

test('全部加载失败 → 回退为普通文本粘贴（保留单图旧行为）', async () => {
  const missing = join(tmpdir(), `rivet-missing-${Date.now()}.png`)
  const { app, out, stdin } = makeApp()
  app.start()
  stdin.dataHandler!(`\x1B[200~${missing}\x1B[201~`)
  await tick(60)
  assert.equal(app.getInputImagesCount(), 0)
  assert.equal(app.getInputValue(), missing, '加载失败时路径仍作为文本可编辑')
  assert.ok(stripAnsi(out.chunks.join('')).includes('图片加载失败'))
  app.dispose()
})

test('超过 MAX_IMAGES：加载到上限并提示已跳过（不静默丢）', async () => {
  await withPngFiles(['1.png', '2.png', '3.png', '4.png', '5.png'], async (paths) => {
    const { app, out, stdin } = makeApp()
    app.start()
    stdin.dataHandler!(`\x1B[200~${paths.join('\r\n')}\x1B[201~`)
    await tick(120)
    assert.equal(app.getInputImagesCount(), 4, '上限 4 张')
    assert.equal(app.getInputValue(), '')
    assert.ok(stripAnsi(out.chunks.join('')).includes('已跳过 1 张'), '跳过多少要说明')
    app.dispose()
  })
})
