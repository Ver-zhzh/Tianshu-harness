/**
 * Clipboard image reader — reads image data from the system clipboard.
 *
 * Tries native @mariozechner/clipboard first (optional dependency, silent fallback),
 * then falls back to platform-specific shell commands (osascript / xclip / wl-paste / PowerShell).
 *
 * Designed for testability: setClipboardReader() injects a mock for unit tests;
 * tryShellClipboard() accepts injectable execFile/platform/readFile for shell-path testing.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectImageMime, isProviderSafeImageMime, MAX_EDGE, TARGET_IMAGE_BYTES } from './image-attach.js'
import {
  makeImageTempDir,
  pickSmallerImage,
  pngHasAlpha,
  removeImageTempDir,
  resizeCandidates,
  resizeJpegCandidates,
  runImageTool,
  runImageToolAuto,
} from './image-tool.js'

const execFileAsync = promisify(execFile)

/** 焦点防抖窗口 (ms)：编辑器从 overlay 切回后 1s 内的 Ctrl+V 跳过剪贴板读图 */
export const FOCUS_DEBOUNCE_MS = 1_000

// ── Public types ──

export interface ClipboardImage {
  /** data:image/...;base64,... */
  dataUrl: string
  mime: string
  name: string
  source: 'png' | 'jpeg' | 'image'
}

export interface ClipboardReader {
  readImage(): Promise<ClipboardImage | null>
  /** 可选：文本读取也走注入（测试密封化——否则文本路径会调真实 pbpaste，
   *  剪贴板有内容时 RED 用例被环境扰动）。 */
  readText?(): Promise<string | null>
}

export interface ShellClipboardOpts {
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>
  platform?: NodeJS.Platform
  readFile?: (path: string) => Promise<Buffer>
  tmpdir?: string
  randomUUID?: () => string
}

// ── Reader injection (for testing) ──

let _reader: ClipboardReader | null = null

export function setClipboardReader(reader: ClipboardReader | null): void {
  _reader = reader
}

// ── 大图 ingest 归一化（Grok/Kimi 都在粘贴时做）──

/**
 * 粘贴的图先压到单图软目标（TARGET_IMAGE_BYTES）再交给模型。5K 截图 PNG 常有
 * 5–10MB，一张就顶满很多网关 4MB 的 body 上限；4 张更是 50MB+ base64。
 * 压不动时保留原图——丢给请求体护栏（provider.maxBodyBytes）/413 恢复兜底，
 * 绝不因为「没装图像工具」把粘贴变成静默失败。
 *
 * PNG 与 JPEG 各渲染一遍取更小者（同 image-attach 的选择律）：照片类图重编码成
 * PNG 常比原图还大，只走 PNG 等于白跑一趟。产物格式由 magic 判定，调用方
 * （bufToClipboardImage）据此标注 data URL，不必也不该在这里假定。
 */
export async function shrinkClipboardImage(buf: Buffer): Promise<Buffer> {
  if (buf.length <= TARGET_IMAGE_BYTES) return buf
  const dir = await makeImageTempDir()
  const inPath = join(dir, 'in.img')
  const pngPath = join(dir, 'out.png')
  const jpgPath = join(dir, 'out.jpg')
  try {
    await writeFile(inPath, buf)
    const png = await runImageTool(resizeCandidates(inPath, pngPath, MAX_EDGE), pngPath)
    // 带 alpha 的 PNG 不进 JPEG 阶梯：透明会被压成黑底（同 image-attach 的 allowJpeg 判据）。
    const allowJpeg = !(detectImageMime(buf, 'clipboard') === 'image/png' && pngHasAlpha(buf))
    const jpeg = allowJpeg
      ? (await runImageToolAuto(resizeJpegCandidates(inPath, jpgPath, MAX_EDGE), jpgPath))?.data ?? null
      : null
    // 只接受真的更小的产物：预算按原图字节算，压完没变小就保留原图。
    const picked = pickSmallerImage(png, jpeg, buf.length)
    return picked && picked.data.length < buf.length ? picked.data : buf
  } catch {
    return buf
  } finally {
    await removeImageTempDir(dir)
  }
}

let _imageShrinker: ((buf: Buffer) => Promise<Buffer>) | null = null

/** 测试注入：给定 buffer 返回归一化后的 buffer（默认真实系统工具链）。 */
export function setClipboardImageShrinker(fn: ((buf: Buffer) => Promise<Buffer>) | null): void {
  _imageShrinker = fn
}

function activeImageShrinker(): (buf: Buffer) => Promise<Buffer> {
  return _imageShrinker ?? shrinkClipboardImage
}

/**
 * 粘贴文本是否像「二进制被当文本送进来」的乱码——即右键粘贴图片时，终端把
 * 图片字节塞进 bracketed paste 的形态。
 *
 * 判定依据是字节经 UTF-8 解码后留下的固定痕迹：解码失败点变成 U+FFFD
 * （本仓库 paste-integration 的乱码样本即以此构造），按单字节解释的字节则
 * 落在 C1 控制符 (U+0080–U+009F)、私用区或缺代理对。
 *
 * 用途（性能前提，不是洁癖）：onPaste 只在命中时才去读系统剪贴板图片。无
 * native 读图包时 macOS 退化为 spawn osascript，本机实测中位 422ms——无条件
 * 调用等于给每次普通文本粘贴加半秒延迟（端到端实测 512ms vs 5ms）。
 * 代价不对称，故判定取宽：误判只是白读一次剪贴板（随后照常插入文本），
 * 漏判才会退化成「乱码进输入框」。
 */
export function looksLikeBinaryPaste(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0xfffd) return true // UTF-8 解码失败标记
    if (cp >= 0x80 && cp <= 0x9f) return true // C1 控制符（单字节解释的残渣）
    if (cp >= 0xd800 && cp <= 0xdfff) return true // 孤立代理
    if (cp >= 0xe000 && cp <= 0xf8ff) return true // 私用区
  }
  return false
}

// ── Main entry ──

export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
  // Test injection path
  if (_reader) {
    try {
      return await _reader.readImage()
    } catch {
      return null
    }
  }

  // 1. Try native (@mariozechner/clipboard) — silent fallback on any failure
  const native = await tryNativeClipboard()
  if (native) return native

  // 2. Shell fallback chain
  return tryShellClipboard()
}

/**
 * Read plain text from system clipboard.
 * Used as fallback when Ctrl+V finds no image in clipboard.
 */
export async function readTextFromClipboard(opts: Pick<ShellClipboardOpts, 'platform' | 'execFile'> = {}): Promise<string | null> {
  // Test injection path（与 readImageFromClipboard 同款）
  if (_reader?.readText) {
    try {
      return await _reader.readText()
    } catch {
      return null
    }
  }
  const pf = opts.platform ?? process.platform
  const ef = opts.execFile ?? (async (bin: string, args: string[]) => execFileAsync(bin, args, { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 }))
  try {
    if (pf === 'darwin') {
      const r = await ef('pbpaste', [])
      return r.stdout.toString()
    }
    if (pf === 'linux') {
      // Try wl-paste first (Wayland), then xclip (X11)
      try {
        const r = await ef('wl-paste', ['--no-newline', '--type', 'text'])
        return r.stdout.toString()
      } catch {
        const r = await ef('xclip', ['-selection', 'clipboard', '-o'])
        return r.stdout.toString()
      }
    }
    if (pf === 'win32') {
      const r = await ef('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-Clipboard -Raw'])
      return r.stdout.toString()
    }
  } catch {
    // No clipboard text tools available
  }
  return null
}

// ── Native path ──

async function tryNativeClipboard(): Promise<ClipboardImage | null> {
  try {
    // @ts-expect-error — optional dependency, may not be installed
    const clipboard = await import('@mariozechner/clipboard')
    if (typeof clipboard.readImage !== 'function') return null
    const raw: Buffer = await clipboard.readImage()
    if (!raw || raw.length === 0) return null
    const buf = await activeImageShrinker()(Buffer.from(raw))
    const img = bufToClipboardImage(buf, 'clipboard.png')
    // native 包理论恒回 PNG。若个别平台给 TIFF/BMP，返回 null 让位给 shell 路径
    // （macOS 侧有 sips 转换），绝不把 provider 不支持的原样格式塞进请求。
    if (!isProviderSafeImageMime(img.mime)) return null
    return img
  } catch {
    // Package not installed, native binding failed, or any other error — silent
    return null
  }
}

// ── Shell fallback (exported for testing) ──

export async function tryShellClipboard(opts?: ShellClipboardOpts): Promise<ClipboardImage | null> {
  const ef = opts?.execFile ?? (async (bin, args) => {
    const r = await execFileAsync(bin, args, { encoding: 'buffer', windowsHide: true, timeout: 15_000, maxBuffer: 50 * 1024 * 1024 })
    return { stdout: r.stdout, stderr: r.stderr }
  })
  const pf = opts?.platform ?? process.platform
  const rf = opts?.readFile ?? (async (p) => {
    const raw = await readFile(p)
    return Buffer.from(raw)
  })
  const td = opts?.tmpdir ?? tmpdir()
  const uuid = opts?.randomUUID ?? randomUUID

  try {
    if (pf === 'darwin') return await tryMacOSClipboard(pf, ef, rf, td, uuid)
    if (pf === 'linux') return await tryLinuxClipboard(ef)
    if (pf === 'win32') return await tryWindowsClipboard(ef, rf, td, uuid)
  } catch {
    // All shell methods failed or no tools available
  }
  return null
}

// ── macOS: osascript（单次嵌套 coercion）──

function appleScriptLiteral(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'
}

async function tryMacOSClipboard(
  pf: NodeJS.Platform,
  ef: (bin: string, args: string[]) => Promise<{ stdout: string | Buffer }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  // 单次 spawn 完成「分类 + 读字节」：嵌套 try 依次尝试 PNGf → TIFF → JPEG
  // coercion，命中者写入对应扩展名的临时文件并回显类名，全败回显 "none"。
  // 相比旧的「clipboard info 预检 + 再写文件」两次 spawn：省一次子进程往返，
  // 消除两次调用间剪贴板被改写的竞态窗口，且不再依赖 clipboard info 的可读名
  // 文本判定——浏览器复制的 JPEG（info 报 "JPEG picture"，旧逻辑漏判为文本）
  // 现在由 JPEG coercion 直接兜住。类名必须用四字符码 PNGf：
  // `as «class PNG»` 在 osascript 里是语法错误 -2741（2026-09-05 本机实测），
  // 旧实现的 PNG 读图分支因此实际从未生效（被 native 依赖路径掩盖）。
  const pngPath = `${td}/rivet-clip-${uuid()}.png`
  const tiffPath = `${td}/rivet-clip-${uuid()}.tiff`
  const jpgPath = `${td}/rivet-clip-${uuid()}.jpg`
  const script = [
    'try',
    '  set imgData to the clipboard as «class PNGf»',
    `  set filePath to POSIX file ${appleScriptLiteral(pngPath)} as text`,
    '  set fRef to open for access file filePath with write permission',
    '  set eof of fRef to 0',
    '  write imgData to fRef',
    '  close access fRef',
    '  return "PNGf"',
    'on error',
    '  try',
    '    set imgData to the clipboard as «class TIFF»',
    `    set filePath to POSIX file ${appleScriptLiteral(tiffPath)} as text`,
    '    set fRef to open for access file filePath with write permission',
    '    set eof of fRef to 0',
    '    write imgData to fRef',
    '    close access fRef',
    '    return "TIFF"',
    '  on error',
    '    try',
    '      set imgData to the clipboard as «class JPEG»',
    `      set filePath to POSIX file ${appleScriptLiteral(jpgPath)} as text`,
    '      set fRef to open for access file filePath with write permission',
    '      set eof of fRef to 0',
    '      write imgData to fRef',
    '      close access fRef',
    '      return "JPEG"',
    '    on error',
    '      return "none"',
    '    end try',
    '  end try',
    'end try',
  ].join('\n')

  let stdout: string
  try {
    const r = await ef('osascript', ['-e', script])
    stdout = r.stdout.toString()
  } catch {
    // osascript 缺失/执行失败（无工具/无剪贴板授权）→ 调用方走文本粘贴
    return null
  }
  try {
    const cls = stdout.trim()
    if (!cls || cls === 'none') return null
    const target = cls === 'TIFF' ? tiffPath : cls === 'JPEG' ? jpgPath : cls === 'PNGf' ? pngPath : null
    if (!target) return null
    const buf = await rf(target)
    if (!buf || buf.length === 0) return null

    // TIFF → PNG 自动转换：macOS 截图剪贴板原生格式是 TIFF，
    // 大多数视觉模型 API 不支持 TIFF，用 sips 转 PNG。
    const mime = detectImageMime(buf, 'clipboard.png')
    if (mime === 'image/tiff' || mime === 'image/bmp') {
      const pngBuf = await convertToPng(pf, buf, target, ef, td, uuid, rf)
      if (pngBuf) return bufToClipboardImage(await activeImageShrinker()(pngBuf), 'clipboard.png')
      // 转换失败：绝不把 provider 常态拒收的 tiff/bmp 原样交给调用方——发出去只会
      // 触发 400/413 → 客户端「全量剥图重试」，用户这一轮所有图都看不到。
      if (process.env['RIVET_DEBUG']) {
        console.error(`[clipboard] ${mime} → PNG 转换失败，放弃本次读图`)
      }
      return null
    }
    return bufToClipboardImage(await activeImageShrinker()(buf), 'clipboard.png')
  } finally {
    // 三条路径都清——嵌套脚本可能在任何一级命中或失败，残余文件不留
    await Promise.all([pngPath, tiffPath, jpgPath].map((p) => unlink(p).catch(() => {})))
  }
}

// ── Linux: xclip / wl-paste ──

async function tryLinuxClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string | Buffer }>,
): Promise<ClipboardImage | null> {
  // Wayland first (more common on modern desktops)
  const commands: [string, string[]][] = [
    ['wl-paste', ['--no-newline', '-t', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ]
  for (const [bin, args] of commands) {
    try {
      const r = await ef(bin, args)
      if (!r.stdout || r.stdout.length === 0) continue
      const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout, 'latin1')
      if (buf.length === 0) continue
      if (detectImageMime(buf, 'clipboard') !== 'image/png') continue
      return bufToClipboardImage(await activeImageShrinker()(buf), 'clipboard.png')
    } catch {
      // Try next
    }
  }
  return null
}

// ── Windows: PowerShell ──

async function tryWindowsClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string | Buffer }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  const tmpPath = `${td}\\rivet-clip-${uuid()}.png`
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }
else { exit 1 }
`.trim()
    await ef('powershell', ['-NoProfile', '-Command', script])
    const buf = await rf(tmpPath)
    if (!buf || buf.length === 0) return null
    return bufToClipboardImage(await activeImageShrinker()(buf), 'clipboard.png')
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => { /* best-effort */ })
  }
}

// ── Helpers ──

/** Convert TIFF/BMP buffer to PNG using macOS sips. Returns null on failure. */
async function convertToPng(
  pf: NodeJS.Platform,
  buf: Buffer,
  srcPath: string,
  ef: (bin: string, args: string[]) => Promise<{ stdout: string | Buffer }>,
  td: string,
  uuid: () => string,
  rf?: (path: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  // 守卫必须看注入的 platform（ShellClipboardOpts.platform 的契约）：查真实
  // process.platform 会让非 darwin 的测试/嵌入环境跳过转换，把 TIFF 原样返回
  // （ubuntu CI 上 RED #8 假红的根因）。运行时 pf === process.platform，语义不变。
  if (pf !== 'darwin') return null
  const pngPath = `${td}/rivet-clip-${uuid()}.png`
  try {
    await ef('sips', ['-s', 'format', 'png', srcPath, '--out', pngPath])
    const pngBuf = await (rf ?? readFile)(pngPath)
    return pngBuf.length > 0 ? pngBuf : null
  } catch {
    return null
  } finally {
    await unlink(pngPath).catch(() => {})
  }
}

function bufToClipboardImage(buf: Buffer, name: string): ClipboardImage {
  const mime = detectImageMime(buf, name) ?? 'image/png'
  const b64 = buf.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    name,
    source: mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'image',
  }
}
