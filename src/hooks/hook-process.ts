import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { ownedProcessTreeAliveAsync } from '../tools/process-group-state.js'
import { track } from '../tools/process-tracker.js'
import type { HookCleanupResult, HookStatus } from './external-hook-types.js'
import { startWindowsHook } from './windows-hook-process.js'

export interface HookProcessResult {
  status: HookStatus
  reason?: string
  output: string
  outputBytes?: number
  exitCode?: number | null
  signal?: string | null
  truncated: boolean
  durationMs: number
  cleanup: HookCleanupResult | 'pending'
}
export interface HookProcessHandle {
  result: Promise<HookProcessResult>
  reaped: Promise<HookCleanupResult>
  cancel(reason?: string): void
  forceExit(): void
}
export interface HookProcessOptions {
  cmd: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input: string
  timeoutMs: number
  maxOutputBytes?: number
  cleanupMs?: number
  termGraceMs?: number
  spawn?: typeof spawn
}

export function startHookProcess(options: HookProcessOptions): HookProcessHandle {
  if (process.platform === 'win32') return startWindowsHook(options)
  const started = performance.now()
  const maxOutput = options.maxOutputBytes ?? 65_536
  const chunks: Buffer[] = []
  let bytes = 0, truncated = false, settled = false, reaped = false, closed = false, stopping = false
  let code: number | null = null, exitSignal: string | null = null
  let child: ChildProcess | undefined
  let resolveResult!: (value: HookProcessResult) => void
  let resolveReaped!: (value: HookCleanupResult) => void
  const result = new Promise<HookProcessResult>(resolve => { resolveResult = resolve })
  const cleanup = new Promise<HookCleanupResult>(resolve => { resolveReaped = resolve })
  let deadline: ReturnType<typeof setTimeout> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let cleanupDeadline: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let checking = false
  const finish = (status: HookStatus, reason?: string, clean: HookCleanupResult | 'pending' = 'pending') => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    const decoder = new StringDecoder('utf8')
    const output = decoder.write(Buffer.concat(chunks)).trim()
    resolveResult({ status, reason, output, exitCode: code, signal: exitSignal, truncated,
      outputBytes: bytes, durationMs: performance.now() - started, cleanup: clean })
  }
  const reap = (state: HookCleanupResult) => {
    if (reaped) return
    reaped = true
    clearTimeout(deadline); clearTimeout(escalation); clearTimeout(cleanupDeadline); clearTimeout(poll)
    if (state === 'unknown') { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy() }
    resolveReaped(state)
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid || reaped) return
    try { process.kill(-child.pid, signal) } catch { /* Probe, not signal delivery, confirms cleanup. */ }
  }
  const check = async () => {
    if (checking || reaped) return
    checking = true
    try {
      const alive = child?.pid ? await ownedProcessTreeAliveAsync(child.pid) : false
      if (reaped) return
      if (!alive && closed) {
        finish(code === 0 ? 'completed' : 'failed', code === 0 ? undefined : 'exit_code', 'exited')
        reap('exited')
      } else if (alive && !stopping && (child?.exitCode !== null || child?.signalCode !== null)) {
        stop('background_process_left')
      }
    } finally {
      checking = false
      if (stopping && !reaped) poll = setTimeout(() => { void check() }, 40)
    }
  }
  const stop = (reason = 'cancelled') => {
    if (stopping || reaped) return
    stopping = true
    finish(reason === 'script_timeout' ? 'timed_out' : reason === 'cancelled' || reason === 'superseded' || reason === 'group_timeout' || reason === 'host_shutdown' || reason === 'owner_closed' ? 'cancelled' : 'failed', reason)
    signalGroup('SIGTERM')
    escalation = setTimeout(() => { signalGroup('SIGKILL'); void check() }, options.termGraceMs ?? 200)
    cleanupDeadline = setTimeout(() => { reap('unknown') }, options.cleanupMs ?? 2_000)
    void check()
  }
  try {
    const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, shell: false,
      detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    child = track((options.spawn ?? spawn)(options.cmd, options.args, spawnOptions))
    const append = (data: Buffer) => {
      if (settled) return
      const available = Math.max(0, maxOutput - bytes)
      const part = data.subarray(0, available)
      chunks.push(Buffer.from(part)); bytes += part.length
      if (data.length >= available) { truncated = true; stop('output_limit') }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('exit', (exitCode, signal) => { code = exitCode; exitSignal = signal; void check() })
    child.once('close', (exitCode, signal) => { closed = true; code = exitCode; exitSignal = signal; void check() })
    child.on('error', error => {
      if (!settled) chunks.push(Buffer.from(error.message).subarray(0, Math.max(0, maxOutput - bytes)))
      if (!child?.pid) { closed = true; finish('failed', 'spawn_error', 'exited'); reap('exited') }
      else stop('spawn_error')
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input, 'utf8')
    deadline = setTimeout(() => stop('script_timeout'), Math.max(1, options.timeoutMs))
  } catch (error) {
    chunks.push(Buffer.from(String(error)).subarray(0, maxOutput))
    finish('failed', 'spawn_error', 'exited'); reap('exited')
  }
  return { result, reaped: cleanup, cancel: stop, forceExit: () => signalGroup('SIGKILL') }
}
