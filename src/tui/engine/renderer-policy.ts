import type { FrontendPreferences } from '../frontend-preferences.js'

/** Use the same ANSI frontend on compatible local hosts; unknown/remote hosts stay opt-in. */
export function resolveFrontendRenderer(mode: FrontendPreferences['renderer'], tty: boolean | undefined, screenReader: boolean,
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): 'classic' | 'fullscreen' {
  if (screenReader || tty !== true || mode === 'classic' || env.TERM === 'dumb') return 'classic'
  if (mode === 'fullscreen') return 'fullscreen'
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.TMUX || env.STY || /^(screen|tmux)(-|$)/.test(env.TERM ?? '')) return 'classic'
  const knownProgram = ['Apple_Terminal', 'iTerm.app', 'WezTerm', 'vscode', 'Hyper', 'ghostty', 'Tabby'].includes(env.TERM_PROGRAM ?? '')
  const ansiTerminal = /^(xterm|rxvt|foot|alacritty|kitty|wezterm)(-|$)/.test(env.TERM ?? '')
  const compatible = !!env.WT_SESSION || knownProgram || ansiTerminal || Number(env.VTE_VERSION) > 0
  // A classic Windows console without a host marker cannot be assumed to support VT.
  return compatible && (platform !== 'win32' || !!env.WT_SESSION || knownProgram || ansiTerminal) ? 'fullscreen' : 'classic'
}
