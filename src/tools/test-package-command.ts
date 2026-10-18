import { basename, resolve } from 'node:path'
import { readTestPackage, selectTestPackages, type TestPackageManager } from './test-workspaces.js'
import { shellWord } from './test-command-words.js'

export const testExecutable = (value: string) => basename(value.replaceAll('\\', '/')).replace(/\.(exe|cmd|bat)$/i, '')
export function testCommandIndex(argv: readonly string[]): number {
  let index = 0
  if (testExecutable(argv[index] ?? '') === 'rtk') { index++; if (argv[index] === 'proxy') index++ }
  if (['env', 'cross-env'].includes(testExecutable(argv[index] ?? ''))) index++
  while (/^[A-Za-z_]\w*=/.test(argv[index] ?? '')) index++
  return index
}
export interface PackageTestCommand { cwd: string; script: string; rest: string[]; manager: TestPackageManager; scriptName?: string }
/** Only literal package selection and argument forwarding. No shell evaluation. */
export function resolvePackageTestCommand(argv: readonly string[], cwd: string): PackageTestCommand | undefined {
  let index = testCommandIndex(argv)
  const manager = testExecutable(argv[index] ?? '') as TestPackageManager
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) return undefined
  index++
  let directory = cwd
  const selectors: string[] = []
  while (index < argv.length) {
    const option = argv[index]!
    if (['--prefix', '--dir', '-C', '--cwd'].includes(option)) { if (!argv[index + 1]) return undefined; directory = resolve(directory, argv[index + 1]!); index += 2 }
    else if (/^--(?:prefix|dir|cwd)=/.test(option)) { directory = resolve(directory, option.slice(option.indexOf('=') + 1)); index++ }
    else if (['--filter', '-F', '--workspace', '-w'].includes(option)) { if (!argv[index + 1]) return undefined; selectors.push(argv[index + 1]!); index += 2 }
    else if (/^--(?:filter|workspace)=/.test(option)) { selectors.push(option.slice(option.indexOf('=') + 1)); index++ }
    else break
  }
  if (argv[index] === 'workspace' && manager === 'yarn') { if (!argv[index + 1]) return undefined; selectors.push(argv[index + 1]!); index += 2 }
  if (selectors.length) {
    const packages = selectTestPackages(directory, selectors)
    if (packages.length !== 1) return undefined
    directory = packages[0]!.root
  }
  const verb = argv[index]
  if (manager === 'bun' && verb === 'test') return undefined // Native bun:test is not a package script.
  if (verb === 'exec' || verb === 'x') {
    index++; if (argv[index] === '--') index++
    return { cwd: directory, script: argv.slice(index).map(shellWord).join(' '), rest: [], manager }
  }
  if (verb === 'run' || verb === 'run-script') index++
  const name = argv[index++]
  if (!name || name.startsWith('-')) return undefined
  const rest = argv.slice(index).filter(a => a !== '--')
  const script = readTestPackage(directory)?.scripts?.[name]
  if (script) return { cwd: directory, script, rest, manager, scriptName: name }
  // Yarn and Bun resolve a local binary when no script has that name.
  if (['yarn', 'bun'].includes(manager) && ['vitest', 'jest'].includes(name)) return { cwd: directory, script: [name, ...rest].map(shellWord).join(' '), rest: [], manager }
  return undefined
}
