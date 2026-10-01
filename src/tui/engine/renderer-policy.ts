import type { FrontendPreferences } from '../frontend-preferences.js'

/** Auto rollout is limited to local Windows Terminal's ConPTY path; other hosts remain opt-in. */
export function resolveFrontendRenderer(mode: FrontendPreferences['renderer'], tty: boolean | undefined, screenReader: boolean,
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): 'classic' | 'fullscreen' {
  if (screenReader || tty !== true || mode === 'classic') return 'classic'
  if (mode === 'fullscreen') return 'fullscreen'
  return platform === 'win32' && tty === true && !!env.WT_SESSION && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY && !env.TMUX && !env.STY
    ? 'fullscreen' : 'classic'
}
