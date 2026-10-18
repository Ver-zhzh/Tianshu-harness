import { parseTestSelection } from './test-selection.js'
import { testExecutable } from './test-package-command.js'

export type TestRunner = 'node-test' | 'vitest' | 'jest'
export interface RunnerSelection { runner: 'vitest' | 'jest'; targets: string[]; filtered: boolean; persistent: boolean; reason?: string }
const VALUES = new Set(['--config', '-c', '--root', '--dir', '--environment', '--env', '--pool', '--maxWorkers', '--minWorkers', '--maxConcurrency', '--testTimeout', '--hookTimeout', '--reporter', '--reporters', '--outputFile', '--project', '--selectProjects', '--testResultsProcessor', '--setupFiles', '--setupFilesAfterEnv', '--testPathPattern', '--testPathPatterns', '--testMatch', '--testRegex', '--shard', '--seed', '--timeout', '--bail'])
const BOOLEANS = new Set(['--forceExit', '--run', '--runInBand', '-i', '--runTestsByPath', '--passWithNoTests', '--no-file-parallelism', '--fileParallelism', '--coverage', '--silent', '--verbose', '--globals', '--isolate', '--no-isolate', '--no-cache', '--cache', '--ci', '--no-color', '--color', '--colors', '--no-colors', '--json', '--logHeapUsage', '--detectOpenHandles', '--watch=false', '--watchAll=false'])
const NAME = /^(?:--testNamePattern|--test-name-pattern|--test-skip-pattern|--testName|--test-tag|--grep|--tags|--excludeTaskLocation|-t|-k|-m)(?:=|$)/
export function modernRunnerSelection(argv: readonly string[], index: number): RunnerSelection | undefined {
  let runner = testExecutable(argv[index] ?? '')
  if (runner === 'node') {
    const next = argv[index + 1]?.replaceAll('\\', '/') ?? ''
    if (/(?:^|\/)(?:vitest\.mjs|vitest\/[^ ]*cli[^ ]*\.[cm]?js)$/.test(next)) { runner = 'vitest'; index++ }
    else if (/(?:^|\/)jest(?:\/bin)?\/jest\.js$/.test(next) || /(?:^|\/)jest\.js$/.test(next)) { runner = 'jest'; index++ }
  }
  if (!['vitest', 'jest'].includes(runner)) return undefined
  const selection = parseTestSelection(argv.slice(index + 1))
  if (selection.reason) return { runner: runner as 'vitest' | 'jest', targets: [], filtered: false, persistent: false, reason: selection.reason }
  argv = [...argv.slice(0, index + 1), ...selection.rest]
  let finite = runner === 'jest', persistent = false, filtered = false
  const targets: string[] = []
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i]!, key = arg.split('=')[0]!
    if (arg === 'run' && runner === 'vitest') { finite = true; continue }
    if (arg === '--run' || arg === '-r' && runner === 'vitest') { finite = true; continue }
    if (arg === '--') { targets.push(...argv.slice(i + 1)); break }
    if (/^(?:--watch|--watchAll|--watch-all|-w)(?:=|$)/.test(arg) && !arg.endsWith('=false')) { persistent = true; continue }
    if (['list', 'collect', 'bench', 'related', '--help', '--version', '--listTests', '--showConfig', '--merge-reports'].includes(key)) return { runner: runner as 'vitest' | 'jest', targets, filtered: true, persistent, reason: '查询、收集或合并报告不证明测试执行。' }
    if (NAME.test(arg)) { filtered = true; if (!arg.includes('=')) i++; continue }
    if (arg.startsWith('-')) {
      if (key === '--projects' || key === '--reporters' && runner === 'jest') {
        if (!arg.includes('=')) { const first = argv[++i]; if (!first || first.startsWith('-')) return { runner: runner as 'vitest' | 'jest', targets, filtered, persistent, reason: `选项缺少值：${key}` }; while (argv[i+1] && !argv[i+1]!.startsWith('-')) i++ }; continue
      }
      if (VALUES.has(key)) { if (!arg.includes('=')) { if (!argv[++i]) return { runner: runner as 'vitest' | 'jest', targets, filtered, persistent, reason: `选项缺少值：${arg}` } }; continue }
      if (BOOLEANS.has(arg) || BOOLEANS.has(key) && arg.includes('=') || /^--(?:coverage\.|outputFile\.)/.test(arg)) continue
      return { runner: runner as 'vitest' | 'jest', targets, filtered, persistent, reason: `未适配的运行器选项：${arg}` }
    }
    if (/:\d+(?::\d+)?$/.test(arg)) filtered = true
    targets.push(arg)
  }
  return { runner: runner as 'vitest' | 'jest', targets, filtered, persistent: persistent || !finite }
}
