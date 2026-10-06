/**
 * Filter foreign-arch optional platform packages when staging the sidecar
 * node_modules tree. Shared by stage-runtime-deps.js and its tests.
 */

/**
 * @param {string} name package name, e.g. @esbuild/darwin-x64 or @ast-grep/napi-darwin-arm64
 * @param {'arm64'|'x64'} keepArch
 * @returns {boolean} true if this package is for a different CPU arch and must not be staged
 */
export function isForeignPlatformPackage(name, keepArch) {
  /** @type {RegExpMatchArray | null} */
  let m =
    name.match(/^@esbuild\/(?:darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix)-(arm64|x64|ia32|arm)$/) ||
    name.match(/^@ast-grep\/napi-(?:darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl))?$/) ||
    name.match(/^napi-(?:darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl))?$/) ||
    // @napi-rs 系（pdfjs-dist → @napi-rs/canvas 等）：命名 <pkg>-<os>-<arch>[-<libc>]，
    // win32 的 libc 是 msvc（非 musl/gnu，与 gnu 同视为可留）。
    name.match(/^@napi-rs\/[a-z0-9-]+-(?:darwin|linux|win32|android|freebsd)-(arm64|x64|ia32|arm)(?:-(gnu|musl|msvc))?$/)
  if (!m) return false
  const raw = m[1]
  // Desktop ships only arm64/x64. Treat ia32/armv7 as always foreign.
  if (raw === 'ia32' || raw === 'arm') return true
  // musl 变体永远 foreign：桌面基准是 glibc（ubuntu 构建），musl .node 会让
  // linuxdeploy 的 ldd 退出码 1 直接崩（2026-09-03 Linux AppImage 实证；
  // 2026-09-13 @napi-rs/canvas-linux-x64-musl 复发——pdfjs-dist 带入）。
  if (m[2] === 'musl') return true
  return raw !== keepArch
}

const ESBUILD_PLATFORMS = new Set(['win32', 'darwin', 'linux'])
const ESBUILD_ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['x86_64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
])

/**
 * Resolve the platform binary package that esbuild needs in the packaged sidecar.
 * TAURI_ENV_TARGET_TRIPLE takes precedence over the host for cross-builds.
 * Unknown or unsupported targets return null so staging can fail closed.
 *
 * @param {{ targetTriple?: string, platform: string, arch: string }} target
 * @returns {string | null}
 */
export function resolveEsbuildPlatformPackage({ targetTriple = '', platform, arch }) {
  const triple = String(targetTriple || '').trim().toLowerCase()
  let targetPlatform = platform

  if (triple) {
    if (/windows|win32|mingw/.test(triple)) targetPlatform = 'win32'
    else if (/darwin|apple/.test(triple)) targetPlatform = 'darwin'
    else if (/linux/.test(triple)) targetPlatform = 'linux'
    else return null
  }

  const normalizedArch = ESBUILD_ARCH_ALIASES.get(String(arch || '').toLowerCase())
  if (!ESBUILD_PLATFORMS.has(targetPlatform) || !normalizedArch) return null
  return `@esbuild/${targetPlatform}-${normalizedArch}`
}

/**
 * Resolve and check the target esbuild package without performing filesystem I/O.
 * The staging script injects its package lookup so this fail-closed gate is testable.
 *
 * @param {{ targetTriple?: string, platform: string, arch: string }} target
 * @param {(packageName: string) => boolean} packageExists
 * @returns {{ packageName: string | null, installed: boolean }}
 */
export function checkEsbuildPlatformPackage(target, packageExists) {
  const packageName = resolveEsbuildPlatformPackage(target)
  return {
    packageName,
    installed: packageName !== null && packageExists(packageName),
  }
}
