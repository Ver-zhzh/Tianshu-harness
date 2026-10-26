import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

const npmNodeShimPattern = /^@echo off goto start :find_dp0 set dp0=%~dp0 exit \/b :start setlocal call :find_dp0 if exist "%dp0%\\node\.exe" \( set "_prog=%dp0%\\node\.exe" \) else \( set "_prog=node" set pathext=%pathext:;\.js;=;% \) endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & "%_prog%"(?:\s+(--expose-gc))?(?:\s+(--max-old-space-size=\d+))? "%dp0%\\(\.\.|node_modules)\\(tianshu-harness|tianshu-tui)\\dist\\(cli\\entry|main)\.js" %\*$/i

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(';')) {
    if (!dir) continue
    for (const executable of extname(name) ? [name] : ['.exe', '.com', '.cmd', '.bat'].map((ext) => name + ext)) {
      const candidate = join(dir.replace(/^"|"$/g, ''), executable)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Resolve Windows Node shims to argv; prompts must never enter cmd.exe. */
export function resolveCliCommand(cli: string, args: string[], cwd: string): { command: string; args: string[] } {
  if (/\.(?:c|m)?js$/i.test(cli)) return { command: process.execPath, args: [resolve(cwd, cli), ...args] }
  if (process.platform !== 'win32') return { command: cli, args }
  const file = /[\\/]/.test(cli) ? resolve(cwd, cli) : onPath(cli) ?? cli
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args }
  const dir = dirname(file)
  const shim = readFileSync(file, 'utf8')
  const simple = shim.match(/^\s*@echo off\s*\r?\n\s*"([^"\r\n]+)"\s+"([^"\r\n]+)"\s+%\*\s*$/i)
  if (simple) {
    const expand = (value: string) => resolve(dir, value.replace(/%~dp0/gi, dir + '\\'))
    const node = expand(simple[1]!)
    const entry = expand(simple[2]!)
    if (basename(node).toLowerCase() === 'node.exe' && existsSync(node) && existsSync(entry)) {
      return { command: node, args: [entry, ...args] }
    }
  }
  // Accept complete known npm shims; extracting only the command could drop wrapper side effects.
  const normalized = shim.replace(/\s+/g, ' ').trim().toLowerCase()
  const match = normalized.match(npmNodeShimPattern)
  const entry = match
    ? resolve(dir, match[3]!, match[4]!, 'dist', ...match[5]!.split('\\')) + '.js'
    : undefined
  const nodeFlags = match ? [match[1], match[2]].filter((flag): flag is string => Boolean(flag)) : []
  const node = existsSync(join(dir, 'node.exe')) ? join(dir, 'node.exe') : onPath('node.exe')
  if (['rivet', 'tianshu'].includes(basename(file, extname(file)).toLowerCase()) &&
    entry && node && existsSync(entry)) {
    return { command: node, args: [...nodeFlags, entry, ...args] }
  }
  throw new Error('无法安全解析 CLI 的 cmd/bat 包装。请指定标准 rivet Node 运行时或可执行文件。')
}
