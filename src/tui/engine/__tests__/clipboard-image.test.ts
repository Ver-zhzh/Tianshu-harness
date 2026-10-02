/**
 * clipboard-image.ts RED tests.
 *
 * Wave 1 — 先写失败用例形成契约，再写实现（GREEN）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { copyTextToClipboard } from '../clipboard-text.js'

// ── RED #1: 模块尚不存在，import 会失败（测试框架报错 = RED） ──
// 此 import 在 clipboard-image.ts 创建前会抛 MODULE_NOT_FOUND。
// 创建模块后：至少导出 readImageFromClipboard, tryNativeClipboard, tryShellClipboard,
// ClipboardImage, ClipboardReader。

// 1x1 transparent PNG (valid)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

test('Linux clipboard preserves PNG bytes and requests no added newline', async () => {
  const { tryShellClipboard, setClipboardImageShrinker } = await import('../clipboard-image.js')
  const png = Buffer.from(PNG_B64, 'base64')
  setClipboardImageShrinker(async b => b)
  try {
    const result = await tryShellClipboard({ platform: 'linux', execFile: async (bin, args) => {
      assert.equal(bin, 'wl-paste'); assert.ok(args.includes('--no-newline'))
      return { stdout: png }
    } })
    assert.equal(result?.dataUrl, PNG_DATA_URL)
  } finally { setClipboardImageShrinker(null) }
})

test('Linux clipboard rejects non-image output and tries X11', async () => {
  const { tryShellClipboard } = await import('../clipboard-image.js')
  const calls: string[] = []
  const image = await tryShellClipboard({ platform: 'linux', execFile: async bin => {
    calls.push(bin); return { stdout: bin === 'wl-paste' ? Buffer.from('not PNG') : Buffer.from(PNG_B64, 'base64') }
  } })
  assert.deepEqual(calls, ['wl-paste', 'xclip']); assert.equal(image?.dataUrl, PNG_DATA_URL)
})

for (const [platform, env, expected] of [
  ['darwin', {}, 'pbcopy'], ['win32', {}, 'powershell.exe'],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'wl-copy'],
  ['linux', { DISPLAY: ':1' }, 'xclip'], ['linux', { TERMUX_VERSION: '0.118' }, 'termux-clipboard-set'],
] as const) test(`native copy uses ${expected} without shell interpolation`, async () => {
  const text = '你好 🎉\n$(untouched) `test`'
  const terminal: string[] = []; const calls: string[] = []
  assert.equal(await copyTextToClipboard(text, s => terminal.push(s), { platform, env,
    run: async (bin, _args, input) => { calls.push(bin); assert.equal(input, text); return true },
  }), 'native')
  assert.deepEqual(calls, [expected]); assert.deepEqual(terminal, [])
})

test('SSH copy targets the client terminal without touching server clipboard', async () => {
  const terminal: string[] = []
  assert.equal(await copyTextToClipboard('你好', s => terminal.push(s), { platform: 'darwin', env: { SSH_TTY: '/dev/pts/1' },
    run: async () => { assert.fail('remote native copy must not run'); return false },
  }), 'terminal')
  assert.equal(terminal[0], `\x1b]52;c;${Buffer.from('你好').toString('base64')}\x07`)
})

test('missing Linux clipboard providers fall back to a terminal request', async () => {
  const calls: string[] = []; const terminal: string[] = []
  await copyTextToClipboard('hello', s => terminal.push(s), { platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':1' },
    run: async bin => { calls.push(bin); return false },
  })
  assert.deepEqual(calls, ['wl-copy', 'xclip', 'xsel']); assert.equal(terminal.length, 1)
})

test('rapid copies preserve request order when the first native writer is slow', async () => {
  const writes: string[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const run = async (_bin: string, _args: string[], text: string) => {
    if (text === 'first') await pending
    writes.push(text); return true
  }
  const options = { platform: 'darwin' as const, env: {}, run }
  const first = copyTextToClipboard('first', () => {}, options)
  const second = copyTextToClipboard('second', () => {}, options)
  try { await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(writes, []) }
  finally { release(); await Promise.all([first, second]) }
  assert.deepEqual(writes, ['first', 'second'])
})

test('Wayland text paste requests text only and preserves existing newlines', async () => {
  const { readTextFromClipboard } = await import('../clipboard-image.js')
  const text = '你好 🎉\nline 2\n'
  assert.equal(await readTextFromClipboard({ platform: 'linux', execFile: async (bin, args) => {
    assert.equal(bin, 'wl-paste'); assert.deepEqual(args, ['--no-newline', '--type', 'text']); return { stdout: text }
  } }), text)
})

// We'll import after the module exists. For now this file documents the contract.

test('RED #1: readImageFromClipboard returns ClipboardImage when native reader succeeds', async () => {
  // 契约：传入 mock reader 返回固定 dataUrl → 函数应返回该 ClipboardImage
  // 此测试在模块不存在时必定失败（import error = RED）。
  // 模块创建后：通过 setClipboardReader 注入 mock → 验证返回结构。
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return {
        dataUrl: PNG_DATA_URL,
        mime: 'image/png',
        name: 'clipboard.png',
        source: 'png' as const,
      }
    },
  })

  const result = await readImageFromClipboard()
  assert.ok(result, 'expected non-null result when reader returns image')
  assert.equal(result!.dataUrl, PNG_DATA_URL)
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.name, 'clipboard.png')
  assert.equal(result!.source, 'png')

  // 清理
  setClipboardReader(null)
})

test('RED #2: readImageFromClipboard returns null when clipboard has no image → caller must fallback to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return null // 剪贴板里是文本，没有图片
    },
  })

  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('RED #3: readImageFromClipboard returns null when reader throws → no crash, caller falls back to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      throw new Error('osascript missing')
    },
  })

  // 不应 throw；应静默返回 null（调用方走文本 fallback）
  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('RED #4: tryShellClipboard returns null when no shell tools available', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  // 覆盖 shell 命令路径使其全部失败 → 应返回 null
  const result = await tryShellClipboard({
    execFile: async (_bin: string, _args: string[]) => {
      throw new Error('command not found')
    },
    platform: 'linux',
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.equal(result, null)
})

test('RED #5: macOS 单次 osascript 嵌套 coercion（PNGf 命中）→ PNG dataUrl', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const osascriptCalls: string[][] = []
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') {
      osascriptCalls.push(args)
      // 嵌套 try 脚本：PNGf 命中后回显类名
      return { stdout: 'PNGf' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    assert.ok(p.endsWith('.png'), `expected .png temp path, got ${p}`)
    return pngBuf
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.ok(result, 'expected non-null on macOS with osascript')
  assert.ok(result!.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.source, 'png')
  // 契约：clipboard info + write 两次 spawn 合并为一次嵌套脚本
  assert.equal(osascriptCalls.length, 1, 'macOS 读图应只 spawn 一次 osascript')
  const script = osascriptCalls[0]?.[1] ?? ''
  assert.ok(script.includes('PNGf'), '脚本应含 PNGf coercion（«class PNG» 是语法错误，不能用）')
})

test('RED #6: JPEG picture 剪贴板（clipboard info 文本判定漏掉的类型）→ JPEG dataUrl', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  // 真实 JPEG 文件头（FF D8 FF E0 ... JFIF）
  const jpegBuf = Buffer.from('ffd8ffe000104a46494600010100004800480000', 'hex')
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') {
      // PNGf/TIFF coercion 失败后 JPEG 命中
      return { stdout: 'JPEG' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    assert.ok(p.endsWith('.jpg'), `expected .jpg temp path, got ${p}`)
    return jpegBuf
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.ok(result, 'expected JPEG read to succeed (browser-copied images advertise JPEG picture)')
  assert.ok(result!.dataUrl.startsWith('data:image/jpeg;base64,'))
  assert.equal(result!.mime, 'image/jpeg')
  assert.equal(result!.source, 'jpeg')
})

test('RED #7: 剪贴板无图 → osascript 回显 none → null 且不读文件', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const readFileCalls: string[] = []
  const execFile = async (bin: string, _args: string[]) => {
    if (bin === 'osascript') return { stdout: 'none' }
    throw new Error(`unexpected exec: ${bin}`)
  }
  const readFile = async (p: string) => {
    readFileCalls.push(p)
    throw new Error('no temp file should be read when clipboard has no image')
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.equal(result, null)
  assert.equal(readFileCalls.length, 0, 'none 回显时不应读任何临时文件')
})

test('RED #8: TIFF 剪贴板 → 单次读回后经 sips 转 PNG', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  // TIFF little-endian 头（II*\0），长度 ≥8 让 detectImageMime 识别为 image/tiff
  const tiffBuf = Buffer.from('49492a000800000000000000', 'hex')
  let uuidSeq = 0
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') return { stdout: 'TIFF' }
    if (bin === 'sips') {
      assert.ok(args.join(' ').includes('format png'), 'sips 应转 PNG')
      return { stdout: '' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    if (p.endsWith('.tiff')) return tiffBuf
    if (p.endsWith('.png')) return pngBuf // sips 转换输出
    throw new Error(`unexpected readFile: ${p}`)
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => `u${++uuidSeq}`,
  } as any)
  assert.ok(result, 'expected TIFF → sips → PNG pipeline to succeed')
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.source, 'png')
  assert.ok(uuidSeq >= 2, 'TIFF 转换应再生成独立输出路径')
})

test('TIFF→sips 转换守卫看注入的 platform 而非 process.platform（ubuntu CI 复现回归）', async () => {
  // RED #8 在维护者的 Mac 上永远绿：convertToPng 的守卫曾偷查真实
  // process.platform（linux 上直接 return null，跳过 sips 转换返回原始 TIFF），
  // 违背 ShellClipboardOpts.platform 的注入契约。本测试临时把真实平台改写为
  // linux 复现 CI 条件——任何平台上都能抓住该回归。
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const tiffBuf = Buffer.from('49492a000800000000000000', 'hex')
  let sipsCalls = 0
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') return { stdout: 'TIFF' }
    if (bin === 'sips') {
      sipsCalls++
      return { stdout: '' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    if (p.endsWith('.tiff')) return tiffBuf
    if (p.endsWith('.png')) return pngBuf
    throw new Error(`unexpected readFile: ${p}`)
  }

  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    const result = await tryShellClipboard({
      execFile,
      platform: 'darwin',
      readFile,
      tmpdir: '/tmp',
      randomUUID: () => 'u',
    } as any)
    assert.ok(result, '注入 darwin 平台时 TIFF 流程应成功')
    assert.equal(sipsCalls, 1, 'TIFF 应调用 sips 转换（守卫须看注入的 platform）')
    assert.equal(result!.mime, 'image/png', '转换后应得到 PNG 而非原始 TIFF')
    assert.equal(result!.source, 'png')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
})

// ── looksLikeBinaryPaste：粘贴文本的乱码判定（决定是否为它去读剪贴板） ──

test('looksLikeBinaryPaste：正常文本一律 false（否则普通粘贴会被拖进 0.5s 读图路径）', async () => {
  const { looksLikeBinaryPaste } = await import('../clipboard-image.js')
  const normal = [
    'hello world',
    'const a = 1\nconst b = 2',
    '第一行 🎉\r\nsecond line',
    'if (x <= 0x9f) return true;',
    'emoji 代理对：👨‍👩‍👧‍👦',
    '',
  ]
  for (const t of normal) {
    assert.equal(looksLikeBinaryPaste(t), false, `正常文本误判为乱码: ${JSON.stringify(t)}`)
  }
})

test('looksLikeBinaryPaste：解码残渣一律 true（防乱码防御的触发条件）', async () => {
  const { looksLikeBinaryPaste } = await import('../clipboard-image.js')
  assert.equal(looksLikeBinaryPaste('\ufffd'), true, 'U+FFFD 是 UTF-8 解码失败标记')
  assert.equal(looksLikeBinaryPaste('abc\ufffddef'), true, '混在文本中的 FFFD 也要命中')
  assert.equal(looksLikeBinaryPaste('\u0080\u009f'), true, 'C1 控制符（单字节解释残渣）')
  assert.equal(looksLikeBinaryPaste('\ue000'), true, '私用区')
})


test('TIFF→PNG 转换失败 → 返回 null，不得把 TIFF 原样泄漏给模型', async () => {
  // provider 对 tiff/bmp 常态拒收：原样返回会触发客户端「全量剥图重试」，
  // 用户这一轮所有图都看不到。转换失败时宁可放弃本次读图。
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod
  const tiffBuf = Buffer.from('49492a000800000000000000', 'hex')
  const execFile = async (bin: string, _args: string[]) => {
    if (bin === 'osascript') return { stdout: 'TIFF' }
    if (bin === 'sips') throw new Error('sips conversion failed')
    throw new Error(`unexpected exec: ${bin}`)
  }
  const readFile = async (p: string) => {
    if (p.endsWith('.tiff')) return tiffBuf
    throw new Error(`unexpected readFile: ${p}`)
  }
  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'u',
  } as any)
  assert.equal(result, null, '转换失败时不得回退返回 image/tiff')
})

// ── ingest 归一化：大截图在粘贴出口就压到软目标（Grok/Kimi 同款） ──

test('大图剪贴板：读图出口先过 ingest 归一化（注入 shrinker 验证接线）', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard, setClipboardImageShrinker } = mod
  const big = Buffer.alloc(4 * 1024 * 1024) // > TARGET_IMAGE_BYTES(3.75MB)
  Buffer.from(PNG_B64, 'base64').copy(big)
  let calls = 0
  setClipboardImageShrinker(async (buf: Buffer) => {
    calls++
    assert.equal(buf.length, big.length, 'shrink 钩子必须拿到原始 buffer')
    return Buffer.from(PNG_B64, 'base64')
  })
  try {
    const result = await tryShellClipboard({
      execFile: async (bin: string) =>
        ({ stdout: bin === 'wl-paste' ? big : '' }),
      platform: 'linux',
      tmpdir: '/tmp',
      randomUUID: () => 'u',
    } as any)
    assert.equal(calls, 1, '大图必须走归一化')
    assert.ok(result?.dataUrl.startsWith('data:image/png;base64,'))
  } finally {
    setClipboardImageShrinker(null)
  }
})

test('小图剪贴板：shrinkClipboardImage 原样返回（零系统工具调用）', async () => {
  const { shrinkClipboardImage } = await import('../clipboard-image.js')
  const small = Buffer.from(PNG_B64, 'base64')
  assert.equal(await shrinkClipboardImage(small), small, '≤ 软目标必须返回同一引用，不付压缩成本')
})
