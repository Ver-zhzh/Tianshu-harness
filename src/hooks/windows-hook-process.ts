import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { HookProcessHandle, HookProcessOptions, HookProcessResult } from './hook-process.js'
import type { HookCleanupResult, HookStatus } from './external-hook-types.js'
import { HookFrame, hookFrame, hookFrameDecoder } from './hook-frames.js'
import { resolveHookLauncher } from './hook-job-launcher.js'
import { track } from '../tools/process-tracker.js'

export function startWindowsHook(options: HookProcessOptions): HookProcessHandle {
  const started = performance.now(), chunks: Buffer[] = []
  const limit = options.maxOutputBytes ?? 65_536
  let child: ChildProcess | undefined, bytes = 0, truncated = false, resultDone = false, reaped = false
  let hello = false, clean = false, exitCode: number | null = null, reason: string | undefined
  let resolveResult!: (result: HookProcessResult) => void, resolveReaped!: (state: HookCleanupResult) => void
  const result = new Promise<HookProcessResult>(resolve => { resolveResult = resolve })
  const cleanup = new Promise<HookCleanupResult>(resolve => { resolveReaped = resolve })
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => cancel('script_timeout'), Math.max(1, options.timeoutMs))
  const finish = (status: HookStatus, why?: string, state: HookCleanupResult | 'pending' = 'pending') => {
    if (resultDone) return
    resultDone = true; clearTimeout(timer)
    resolveResult({ status, reason: why, output: new StringDecoder('utf8').write(Buffer.concat(chunks)).trim(),
      exitCode, truncated, outputBytes: bytes, durationMs: performance.now() - started, cleanup: state })
  }
  const reap = (state: HookCleanupResult) => {
    if (reaped) return
    reaped = true; clearTimeout(timer); clearTimeout(cleanupTimer)
    child?.stdin?.destroy()
    if (state === 'unknown') { child?.stdout?.destroy(); child?.stderr?.destroy() }
    resolveReaped(state)
  }
  const cancel = (why = 'cancelled') => {
    if (reason || reaped) return
    reason = why
    finish(why === 'script_timeout' ? 'timed_out' : why === 'output_limit' || why === 'protocol_error' ? 'failed' : 'cancelled', why)
    if (!child) return
    child.stdin?.write(hookFrame(HookFrame.cancel))
    cleanupTimer = setTimeout(() => { child?.kill(); reap('unknown') }, options.cleanupMs ?? 2_000)
  }
  const append = (data: Buffer) => {
    if (resultDone) return
    const available = Math.max(0, limit - bytes)
    const part = data.subarray(0, available)
    chunks.push(Buffer.from(part)); bytes += part.length
    if (data.length >= available) { truncated = true; cancel('output_limit') }
  }
  const decode = hookFrameDecoder((kind, payload) => {
    if (kind === HookFrame.hello) {
      if (hello || payload.length !== 4 || payload.readUInt32LE(0) !== 1) throw new Error('Unsupported hook supervisor')
      hello = true
      if (reason) child?.stdin?.write(hookFrame(HookFrame.cancel))
      else child?.stdin?.write(hookFrame(HookFrame.input, Buffer.from(options.input)))
    } else if (!hello) throw new Error('Hook supervisor did not identify itself')
    else if (kind === HookFrame.stdout || kind === HookFrame.stderr) append(payload)
    else if (kind === HookFrame.done) {
      if (payload.length !== 6) throw new Error('Invalid hook cleanup frame')
      exitCode = payload.readInt32LE(0); clean = payload[4] === 1
      const flags = payload[5]!
      finish(flags & 2 ? 'timed_out' : flags & 1 ? 'failed' : exitCode === 0 ? 'completed' : 'failed',
        flags & 2 ? 'script_timeout' : flags & 1 ? 'background_process_left' : exitCode === 0 ? undefined : 'exit_code', clean ? 'exited' : 'unknown')
    } else throw new Error('Unexpected hook supervisor frame')
  })
  void resolveHookLauncher().then(launcher => {
    if (reason) { reap('exited'); return }
    if (!launcher) {
      finish('skipped', 'helper_unavailable', 'exited'); reap('exited'); return
    }
    child = track((options.spawn ?? spawn)(launcher, ['--hook-supervisor', '--cwd', options.cwd,
      '--parent-pid', String(process.pid), '--timeout-ms', String(Math.ceil(options.timeoutMs)), '--', options.cmd, ...options.args], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }))
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', (data: Buffer) => { try { decode(data) } catch { cancel('protocol_error') } })
    child.stderr?.on('data', append)
    child.on('error', error => {
      append(Buffer.from(error.message))
      finish('failed', 'spawn_error', child?.pid ? 'unknown' : 'exited')
      if (!child?.pid) reap('exited'); else cancel('protocol_error')
    })
    child.once('close', () => {
      finish('failed', hello ? 'supervisor_lost' : 'helper_incompatible', clean ? 'exited' : 'unknown')
      reap(clean ? 'exited' : 'unknown')
    })
  }).catch(error => { append(Buffer.from(String(error))); finish('failed', 'helper_unavailable', 'exited'); reap('exited') })
  return { result, reaped: cleanup, cancel, forceExit: () => { if (!reaped) child?.kill() } }
}
