/**
 * User hooks — .rivet/hooks.json event→script mapping.
 *
 * Runs external shell scripts on agent lifecycle events. Scripts receive
 * event context via environment variables and stdin JSON.
 */

import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { extname, isAbsolute, join, win32 } from 'node:path'
import { startHookProcess, type HookProcessHandle } from './hook-process.js'
import { loadHooksConfig } from './hooks-config.js'
import type { HookCleanupResult, HookStatus } from './external-hook-types.js'
export { loadHooksConfig } from './hooks-config.js'
import { ANTI_INTERACTIVE_ENV } from '../tools/resolved-env.js'
import { sanitizeEnv } from '../tools/sanitize-env.js'
import { isProjectTrusted } from '../config/project-trust.js'

export type HookEvent =
  | 'preTurn'
  | 'postTurn'
  | 'postTool'
  | 'postSession'
  | 'onError'

export interface HookEntry {
  event: HookEvent
  /** Script path relative to project root or absolute. */
  script: string
  /** Optional timeout in ms. Default 5000. */
  timeoutMs?: number
}

export interface HooksConfig {
  hooks: HookEntry[]
  diagnostics?: string[]
}

export interface HookContext {
  event: HookEvent
  cwd: string
  sessionId?: string
  turn?: number
  toolName?: string
  toolResult?: string
  error?: string
}

export interface HookResult {
  script: string
  ok: boolean
  output: string
  status?: HookStatus
  reason?: string
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
  truncated?: boolean
  cleanup?: HookCleanupResult | 'pending'
}

export const VALID_EVENTS = new Set<HookEvent>(['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'])

/** A hook contributed by a plugin (absolute script path + source plugin name).
 *  Mirrors PluginHookEntry from plugin-loader but kept structural to avoid the
 *  hooks layer importing the plugins layer. */
export interface PluginHook {
  pluginName: string
  event: HookEvent
  /** Absolute path to the script (plugin-loader resolved it). */
  script: string
  timeoutMs?: number
}

export type HookCommandResolution =
  | { ok: true; cmd: string; args: string[]; shell: boolean }
  | { ok: false; error: string }

export interface HookCommandDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  /** 运行中的 node 可执行文件——`.js`/`.mjs`/`.cjs`/`.ts` 用它，保证一定存在。 */
  execPath?: string
}

// 这两个 helper 只在 platform==='win32' 分支可达。路径拼接必须用 win32.join 而非
// join：在 macOS/Linux 上跑「模拟 win32」的测试时，POSIX join 产出 'C:\\tools/bash.exe'
// 混合分隔符，与测试断言的原生路径字符串不等；真实 Windows 上 join === win32.join，
// 行为不变。
function findOnPath(names: string[], env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform): string | undefined {
  const dirs = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const p = win32.join(dir, name)
      if (exists(p)) return p
    }
  }
  return undefined
}

/** Git for Windows 的 bash：先查已知安装位置，再查 PATH。 */
function resolveBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform): string | undefined {
  const localPrograms = env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs') : undefined
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], localPrograms]) {
    if (!root) continue
    for (const rel of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe']) {
      const p = win32.join(root, rel)
      if (exists(p)) return p
    }
  }
  return findOnPath(['bash.exe'], env, exists, platform)
}

/**
 * 给 hook 脚本解析「命令 + 参数」。
 *
 * 为什么不能继续用 `shell: true`（issue #198）：Windows 上那等价于
 * `cmd /d /s /c "<scriptPath>"`。`.sh` 没有注册关联处理程序时，cmd 找不到解释器会走
 * shell 的「打开」语义——弹出「选取应用」对话框并且**阻塞**：hook 永远不执行，桌面上
 * 还留下一个由 shell 持有、调用方回收不了的窗口。（PR #195 修的是同族的另一处落点。）
 *
 * Windows 上按扩展名选解释器；解释器缺失时 **fail-closed 报错**，绝不把脚本路径交给
 * shell 去「打开」。POSIX 参数化脚本路径，保留脚本自身的 shebang。
 */
export function resolveHookCommand(scriptPath: string, deps: HookCommandDeps = {}): HookCommandResolution {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  if (platform !== 'win32') return { ok: true, cmd: '/bin/sh', args: ['-c', 'exec "$1"', 'rivet-hook', scriptPath], shell: false }

  const ext = extname(scriptPath).toLowerCase()
  switch (ext) {
    case '.bat':
    case '.cmd':
      return { ok: true, cmd: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath], shell: false }
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.ts':
      return { ok: true, cmd: deps.execPath ?? process.execPath, args: [scriptPath], shell: false }
    case '.py': {
      const python = findOnPath(['python.exe', 'py.exe'], env, exists, platform)
      return python
        ? { ok: true, cmd: python, args: [scriptPath], shell: false }
        : { ok: false, error: `hook 未执行：Windows 上找不到 python（脚本 ${scriptPath}）` }
    }
    case '.sh':
    case '.bash':
    case '.zsh': {
      const bash = resolveBash(env, exists, platform)
      return bash
        ? { ok: true, cmd: bash, args: [scriptPath], shell: false }
        : { ok: false, error: `hook 未执行：Windows 上找不到 bash（需 Git for Windows；脚本 ${scriptPath}）` }
    }
    default:
      return {
        ok: false,
        error: `hook 未执行：Windows 上没有为 "${ext || '(无扩展名)'}" 注册解释器（脚本 ${scriptPath}）。`
          + '直接交给 shell 会弹出「选取应用」并阻塞（issue #198），故此处 fail-closed。',
      }
  }
}

export interface HookRunnerOptions {
  config?: HooksConfig
  signal?: AbortSignal
  deadlineAt?: number
  results?: HookResult[]
  onProcess?: (process: HookProcessHandle) => void
  validatePlugin?: (hook: PluginHook) => boolean
}

async function resolveCommand(script: string): Promise<HookCommandResolution> {
  const candidates = new Set<string>()
  resolveHookCommand(script, { exists: path => { candidates.add(path); return false } })
  const present = new Set<string>()
  await Promise.all([...candidates].map(async path => {
    try { await access(path); present.add(path) } catch { /* Missing interpreter. */ }
  }))
  return resolveHookCommand(script, { exists: path => present.has(path) })
}

export async function runHooksForEvent(cwd: string, ctx: HookContext, pluginHooks: PluginHook[] = [], options: HookRunnerOptions = {}): Promise<HookResult[]> {
  const results = options.results ?? []
  const deadlineAt = options.deadlineAt ?? performance.now() + 10_000
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort('group_timeout'), Math.max(1, deadlineAt - performance.now()))
  let current: HookProcessHandle | undefined
  const cancel = () => current?.cancel(typeof signal.reason === 'string' ? signal.reason : 'cancelled')
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) return results
    const config = options.config ?? await loadHooksConfig(cwd, signal)
    if (signal.aborted) return results
    for (const diagnostic of config.diagnostics ?? []) results.push({ script: '.rivet/hooks.json', ok: false, output: diagnostic, status: 'skipped', reason: 'invalid_config' })
    const entries: Array<HookEntry & { plugin?: PluginHook }> = [
      ...config.hooks.filter(h => h.event === ctx.event),
      ...pluginHooks.filter(h => h.event === ctx.event).map(h => ({ ...h, plugin: h })),
    ]
    if (entries.length > 128) {
      results.push({ script: '', ok: false, output: 'Too many hooks (maximum 128)', status: 'skipped', reason: 'config_limit' })
      return results
    }
    let outputBytes = 0
    for (const entry of entries) {
      if (signal.aborted || performance.now() >= deadlineAt) break
      if (entry.plugin ? options.validatePlugin && !options.validatePlugin(entry.plugin) : !isProjectTrusted(cwd)) {
        results.push({ script: entry.script, ok: false, output: 'Hook authorization revoked', status: 'skipped', reason: 'authorization_revoked' })
        continue
      }
      const scriptPath = isAbsolute(entry.script) ? entry.script : join(cwd, entry.script)
      let resolved: HookCommandResolution
      try { await access(scriptPath); resolved = await resolveCommand(scriptPath) }
      catch { resolved = { ok: false, error: `Script not found: ${scriptPath}` } }
      if (signal.aborted || performance.now() >= deadlineAt) break
      if (!resolved.ok) {
        results.push({ script: entry.script, ok: false, output: resolved.error, status: 'failed', reason: 'command_unavailable' })
        continue
      }
      const env = { ...sanitizeEnv(process.env), ...ANTI_INTERACTIVE_ENV,
        RIVET_HOOK_EVENT: ctx.event, RIVET_SESSION_ID: ctx.sessionId ?? '',
        RIVET_TURN: String(ctx.turn ?? ''), RIVET_TOOL_NAME: ctx.toolName ?? '' }
      const input = JSON.stringify(ctx)
      if (Buffer.byteLength(input) > 65_536) {
        results.push({ script: entry.script, ok: false, output: 'Hook input exceeds 64KiB', status: 'skipped', reason: 'input_limit' })
        break
      }
      const remaining = 262_144 - outputBytes
      if (remaining <= 0) break
      current = startHookProcess({ cmd: resolved.cmd, args: resolved.args, cwd, env, input,
        timeoutMs: Math.max(1, Math.min(entry.timeoutMs ?? 5_000, deadlineAt - performance.now())),
        maxOutputBytes: Math.min(65_536, remaining) })
      options.onProcess?.(current)
      if (signal.aborted) cancel()
      const execution = await current.result
      results.push({ script: entry.script, ok: execution.status === 'completed', ...execution })
      outputBytes += execution.outputBytes ?? Buffer.byteLength(execution.output)
      const cleanup = await current.reaped
      results[results.length - 1]!.cleanup = cleanup
      if (cleanup === 'unknown' || outputBytes >= 262_144) break
      current = undefined
    }
    return results
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
