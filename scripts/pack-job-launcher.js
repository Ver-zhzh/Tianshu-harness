import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertNativeBinary } from '../src/platform/native-binary.ts'
import { packedSqlitePath } from './native-pack-paths.js'
import { resolveTargetPlatform } from './runtime-platform-filter.js'

export function packJobLauncher(repoRoot, target = resolveTargetPlatform(), { host = { os: process.platform, arch: process.arch }, run = execFileSync } = {}) {
  if (target.os !== 'win32') return null
  if (!['x64', 'arm64'].includes(target.arch)) throw new Error(`pack-job-launcher: unsupported Windows architecture ${target.arch}`)
  const destination = join(dirname(packedSqlitePath(repoRoot, target, host)), 'job-launch.exe')
  let source
  if (host.os === 'win32') {
    const native = join(repoRoot, 'native')
    for (const file of ['job-launch.c', 'job-hook-supervisor.h', 'build-windows.bat']) {
      if (!existsSync(join(native, file))) throw new Error(`pack-job-launcher: missing tracked native/${file}`)
    }
    const output = `win32-${target.arch}`
    run(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', ['/d', '/c', 'build-windows.bat', target.arch, output], {
      cwd: native, stdio: 'inherit', windowsHide: true, timeout: 120_000,
    })
    source = join(native, output, 'job-launch.exe')
  } else {
    source = join(repoRoot, 'native', `win32-${target.arch}`, 'job-launch.exe')
    if (!existsSync(source)) {
      if (!existsSync(destination)) return null
      assertNativeBinary(destination, target)
      return destination
    }
  }
  assertNativeBinary(source, target)
  mkdirSync(dirname(destination), { recursive: true })
  // 临时名 + rename：先删后拷的中途失败会丢掉原先有效的 helper（审查 nit）。
  const staging = `${destination}.tmp-${process.pid}`
  try {
    copyFileSync(source, staging)
    assertNativeBinary(staging, target)
    renameSync(staging, destination)
  } finally {
    rmSync(staging, { force: true })
  }
  assertNativeBinary(destination, target)
  return destination
}
