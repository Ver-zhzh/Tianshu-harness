import { verificationArgv } from './test-command-words.js'
import { parseTestSelection } from './test-selection.js'

/** Prefix both arrays together; original ENV and CLI pairing remains in its native order. */
export function nodeCompletionOutput(args: readonly string[], options: string, reporter: string, destination: string): string | undefined {
  const environment = options.trim() ? verificationArgv(options) : []
  if (!environment) return undefined
  const all = [...environment, ...args], reporters: string[] = [], destinations: string[] = []
  for (let i = 0; i < all.length; i++) {
    const arg = all[i]!, key = arg.split('=')[0]!
    if (!['--test-reporter', '--test-reporter-destination'].includes(key)) continue
    const value = arg.includes('=') ? arg.slice(key.length + 1) : all[++i]
    if (!value) return undefined
    ;(key === '--test-reporter' ? reporters : destinations).push(value)
  }
  if (reporters.length !== destinations.length && !(reporters.length === 1 && !destinations.length)) return undefined
  if (/--test-(?:name-pattern|skip-pattern|only|force-exit)(?:[=\s]|$)/.test(options) || parseTestSelection(environment).reason) return undefined
  const injected = ['--test-reporter=' + reporter, '--test-reporter-destination=' + destination]
  if (!reporters.length) injected.push('--test-reporter=spec', '--test-reporter-destination=stdout')
  else if (!destinations.length) injected.push('--test-reporter-destination=stdout')
  return `${injected.map(arg => JSON.stringify(arg)).join(' ')} ${options}`.trim()
}
