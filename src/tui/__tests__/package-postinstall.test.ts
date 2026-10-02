import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * npm 全局安装（`npm i -g`，/update 触发）时 postinstall 的执行环境：
 * devDependencies 不安装 → 其 bin 不在 PATH。PATH 只有系统路径 + node 安装目录。
 * 2026-08-14 缺陷：postinstall 首段裸调 patch-package（devDependency），
 * 全局安装 exit 127 整链失败（sh: patch-package: command not found）。
 */
function simulateGlobalInstallPath(): string {
  const parts = [dirname(process.execPath)]
  const systemPaths = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']
  for (const p of systemPaths) {
    if (!parts.includes(p)) parts.push(p)
  }
  return parts.join(delimiter)
}

/**
 * 拆出 postinstall 链中「未被容错保护」的命令。
 * 段含 `||`（如 `node scripts/x.mjs || node -e 1`）左侧失败有恒成功兜底，
 * 命令允许不存在；无 `||` 的段失败会中断整条 `&&` 链，命令必须可解析。
 */
function unguardedCommands(postinstall: string): string[] {
  return postinstall
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1).trim() : s))
    .filter((s) => !s.includes('||'))
    .map((s) => s.split(/\s+/)[0])
    .filter((c): c is string => Boolean(c))
}

test('postinstall 裸命令在全局安装环境（无 devDeps bin）中必须可解析', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: { postinstall?: string }
  }
  const postinstall = pkg.scripts?.postinstall
  assert.ok(postinstall, 'package.json 必须声明 postinstall')

  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = simulateGlobalInstallPath()
  for (const cmd of unguardedCommands(postinstall)) {
    let resolvable = false
    try {
      if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), [cmd], { env, stdio: 'pipe', windowsHide: true })
      else execFileSync('sh', ['-c', `command -v ${cmd}`], { env, stdio: 'pipe' })
      resolvable = true
    } catch {
      resolvable = false
    }
    assert.ok(
      resolvable,
      `postinstall 裸命令 "${cmd}" 在全局安装环境（无 devDeps bin）中不可解析 → npm i -g 将 exit 127`,
    )
  }
})
