import { shellWord } from './test-command-words.js'

/** Display/execution renderers never replace filename bytes to make a command appear safe. */
export function renderTestCommand(argv: readonly string[], shell: 'bash' | 'sh' | 'powershell' | 'cmd'): string | undefined {
  if (argv.some(word => /[\x00\r\n]/.test(word))) return undefined
  if (shell === 'cmd') {
    if (argv.some(word => /[%"!]/.test(word))) return undefined
    return argv.map(word => /^[\w./:@=\\-]+$/.test(word) ? word : `"${word}"`).join(' ')
  }
  if (shell === 'powershell') return '& ' + argv.map(word => "'" + word.replaceAll("'", "''") + "'").join(' ')
  return argv.map(word => /^[\w./:@=-]+$/.test(word) ? word : shellWord(word)).join(' ')
}
