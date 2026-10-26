import { verificationArgv } from './verification-command.js'

// A whitelist of literal arguments. Unknown options or shell syntax remain serial.
const switches: Record<string, RegExp> = {
  pwd: /^-(?:L|P)$/,
  ls: /^(?:-[alhtrSdAF1]+|--(?:all|almost-all|human-readable|directory|color=(?:always|auto|never)))$/,
  cat: /^(?:-[nbsvET]+|--(?:number|number-nonblank|squeeze-blank))$/,
  head: /^(?:-[qv]+|-\d+|--(?:quiet|verbose))$/,
  tail: /^(?:-[qv]+|-\d+|--(?:quiet|verbose))$/,
  wc: /^(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length))$/,
  sort: /^(?:-[nruhVbfds]+|--(?:numeric-sort|reverse|unique|human-numeric-sort|version-sort))$/,
  uniq: /^(?:-[cdu]+|--(?:count|repeated|unique))$/,
  grep: /^(?:-[nrilcHvEFwoxsqab]+|--(?:line-number|ignore-case|files-with-matches|count|fixed-strings|extended-regexp|word-regexp|invert-match|only-matching|quiet|no-messages|text))$/,
  rg: /^(?:-[nrilcHvFwxqsaSUL]+|--(?:no-config|files|hidden|line-number|ignore-case|files-with-matches|count|fixed-strings|word-regexp|invert-match|only-matching|quiet|text|no-heading|heading|stats|json|sort=(?:path|none)|color=(?:never|always|auto)))$/,
}
const values: Record<string, RegExp> = {
  head: /^(?:-n|-c|--lines|--bytes)$/,
  tail: /^(?:-n|-c|--lines|--bytes)$/,
  grep: /^(?:-[ABCme]|--(?:after-context|before-context|context|max-count|regexp))$/,
  rg: /^(?:-[ABCmeg]|--(?:after-context|before-context|context|max-count|regexp|glob|iglob|type|type-not|max-depth|max-count|max-columns))$/,
}
function safeArgv(argv: string[]): boolean {
  if (argv[0] === 'rtk') argv = argv.slice(argv[1] === 'proxy' ? 2 : 1)
  const [name, ...args] = argv
  if (name === 'sed') return args.length >= 2 && args[0] === '-n' && /^\d+(?:,(?:\d+|\$))?p$/.test(args[1]!) && args.slice(2).every(a => !a.startsWith('-'))
  if (!name || !switches[name]) return false
  if (name === 'rg' && process.env.RIPGREP_CONFIG_PATH && !args.includes('--no-config')) return false
  let options = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (options && arg === '--') { options = false; continue }
    if (!options || !arg.startsWith('-') || arg === '-') continue
    if (switches[name]!.test(arg)) continue
    if (values[name]?.test(arg) && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) { i++; continue }
    if ((name === 'head' || name === 'tail') && /^-[nc]\d+$/.test(arg)) continue
    if ((name === 'rg' || name === 'grep') && /^-[ABCm]\d+$/.test(arg)) continue
    return false
  }
  return true
}
export function isLiteralReadShell(command: string): boolean {
  if (process.env.BASH_ENV || process.env.ENV || process.platform === 'win32') return false
  let quote = '', start = 0
  const parts: string[] = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") { if (++i >= command.length || /[\n\r]/.test(command[i]!)) return false; continue }
    if (quote) { if (c === quote) quote = ''; else if (quote !== "'" && /[$`]/.test(c)) return false; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (/[$`;&<>\n\r(){}*?\[\]~]/.test(c)) return false
    if (c === '|') { parts.push(command.slice(start, i)); start = i + 1 }
  }
  if (quote) return false
  parts.push(command.slice(start))
  return parts.every(part => { const argv = verificationArgv(part.trim()); return !!argv?.length && safeArgv(argv) })
}
