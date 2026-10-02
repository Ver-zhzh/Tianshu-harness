import { spawn } from 'node:child_process'
import { osc52Clipboard } from './ansi.js'

type ClipboardCommand = [string, string[]]
type RunClipboard = (command: string, args: string[], text: string, signal?: AbortSignal) => Promise<boolean>
let copyQueue: Promise<unknown> = Promise.resolve()

async function runClipboard(command: string, args: string[], text: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    let failed = false
    const terminate = () => {
      failed = true
      // Reap the writer before releasing the queue; TERM can be ignored on POSIX.
      child.kill('SIGKILL')
    }
    const timer = setTimeout(terminate, 2_000)
    child.once('error', () => { failed = true })
    signal?.addEventListener('abort', terminate, { once: true })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', terminate)
      resolve(!failed && code === 0)
    })
    child.stdin!.on('error', terminate)
    child.stdin!.end(text, 'utf8')
  })
}

/** Native local copy avoids host-specific OSC 52 permissions; SSH targets the client terminal. */
export function copyTextToClipboard(text: string, writeTerminal: (sequence: string) => void,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: RunClipboard; signal?: AbortSignal } = {}): Promise<'native' | 'terminal' | 'cancelled'> {
  const next = copyQueue.then(() => copyText(text, writeTerminal, options))
  copyQueue = next.catch(() => {})
  return next
}

async function copyText(text: string, writeTerminal: (sequence: string) => void,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: RunClipboard; signal?: AbortSignal }): Promise<'native' | 'terminal' | 'cancelled'> {
  if (options.signal?.aborted) return 'cancelled'
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const commands: ClipboardCommand[] = []
  if (!env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY) {
    if (platform === 'darwin') commands.push(['pbcopy', []])
    else if (platform === 'win32') {
      const script = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);Set-Clipboard -Value ([Console]::In.ReadToEnd())'
      commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]])
    } else if (platform === 'linux') {
      if (env.TERMUX_VERSION) commands.push(['termux-clipboard-set', []])
      if (env.WAYLAND_DISPLAY) commands.push(['wl-copy', ['--type', 'text/plain;charset=utf-8']])
      if (env.DISPLAY) commands.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']])
    }
  }
  for (const [command, args] of commands) {
    try {
      const copied = await (options.run ?? runClipboard)(command, args, text, options.signal)
      if (options.signal?.aborted) return 'cancelled'
      if (copied) return 'native'
    }
    catch { /* Try the next clipboard provider. */ }
  }
  if (options.signal?.aborted) return 'cancelled'
  writeTerminal(osc52Clipboard(text))
  return 'terminal'
}
