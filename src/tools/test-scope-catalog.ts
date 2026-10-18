import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseTestSelection } from './test-selection.js'
import { testScopeDigest } from './test-project-identity.js'
import { canonicalTestPath, insideTestRoot, testWorkspace } from './test-workspaces.js'
import { getResolvedEnv } from './resolved-env.js'
import type { TestCompletionCoverage } from './types.js'
import type { VerificationInvocation } from './verification-command.js'

export interface TestScope { path: string; project: string; label?: string }
export interface TestScopeCatalog { inventoryDigest: string; digest: string; fingerprint: string; runnerVersion: string; origin: string; canonical: boolean; scopes: TestScope[] }
export function runnerArguments(invocation: VerificationInvocation): string[] {
  const argv = invocation.resolvedArgv ?? invocation.argv
  const index = argv.findIndex(arg => /(?:^|[/\\])(?:vitest(?:\.mjs)?|jest(?:\.js)?)$/.test(arg))
  if (index < 0) throw new Error('runner_entry_unresolved')
  return argv.slice(index + 1)
}
export function testOption(args: readonly string[], ...keys: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) for (const key of keys) if (args[i] === key || args[i]!.startsWith(key + '=')) return args[i]!.includes('=') ? args[i]!.slice(key.length + 1) : args[i + 1]
  return undefined
}
export function testOptionValues(args: readonly string[], key: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith(key + '=')) values.push(args[i]!.slice(key.length + 1))
    else if (args[i] === key) while (args[i + 1] && !args[i + 1]!.startsWith('-')) values.push(args[++i]!)
  }
  return values
}
export function removeTestOptions(args: readonly string[], keys: readonly string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) { const key = args[i]!.split('=')[0]!; if (keys.includes(key)) { if (!args[i]!.includes('=')) { i++; if (key === '--reporters' || key === '--projects') while (args[i+1] && !args[i+1]!.startsWith('-')) i++ }; continue } result.push(args[i]!) }
  return result
}
export function scopePreparationTimeout(deadline: number): number { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('scope_discovery_budget_exhausted'); return Math.min(5000, remaining) }
export function invocationEnvironment(invocation: VerificationInvocation): Record<string, string> {
  const argv = invocation.resolvedArgv ?? invocation.argv, count = runnerArguments(invocation).length
  return Object.fromEntries(argv.slice(0, argv.length - count - 1).filter(arg => /^[A-Za-z_]\w*=/.test(arg)).map(arg => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]))
}
export function nativeDiscovery(entry: string, args: string[], cwd: string, deadline: number, environment: NodeJS.ProcessEnv = {}): void {
  const pnp = join(testWorkspace(cwd).root, '.pnp.cjs')
  execFileSync(process.execPath, [...(existsSync(pnp) ? ['--require', pnp, ...(existsSync(join(testWorkspace(cwd).root, '.pnp.loader.mjs')) ? ['--experimental-loader', join(testWorkspace(cwd).root, '.pnp.loader.mjs')] : [])] : []), entry, ...args], { cwd, env: { ...getResolvedEnv(cwd), ...environment, NODE_TEST_CONTEXT: undefined },
    timeout: scopePreparationTimeout(deadline), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
}
export function discoveryArguments(invocation: VerificationInvocation): string[] {
  const selection = parseTestSelection(runnerArguments(invocation))
  if (selection.reason) throw new Error(selection.reason)
  // Discovery observes the canonical complete scope, independent of this run's selectors.
  return removeTestOptions(selection.rest, ['--reporter', '--reporters', '--outputFile', '--testSequencer'])
    .filter(arg => arg !== 'run' && arg !== '--run' && arg !== '--runTestsByPath' && !invocation.targets.includes(arg))
}
export function readScopeList(path: string, root: string, map?: (row: any) => TestScope): TestScope[] {
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) throw new Error('scope_unresolved')
  const scopes: TestScope[] = rows.map(row => map ? map(row) : row)
  if (scopes.some(scope => typeof scope.path !== 'string' || typeof scope.project !== 'string' || !scope.project || !insideTestRoot(root, canonicalTestPath(resolve(root, scope.path))))) throw new Error('project_identity_unresolved')
  if (new Set(scopes.map(scope => JSON.stringify([scope.path, scope.project]))).size !== scopes.length) throw new Error('project_identity_unresolved')
  return scopes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function createScopeCatalog(scopes: TestScope[], origin: string, fingerprint: string, runnerVersion: string, canonical: boolean, inventoryDigest = testScopeDigest(scopes)): TestScopeCatalog {
  return { inventoryDigest, digest: testScopeDigest([origin, fingerprint, runnerVersion, inventoryDigest, scopes]), scopes, origin, fingerprint, runnerVersion, canonical }
}
export function bindScopeCoverage(proof: TestCompletionCoverage, catalog: TestScopeCatalog, selected: TestScope[], selection: ReturnType<typeof parseTestSelection>): TestCompletionCoverage {
  const key = (scope: TestScope) => JSON.stringify([scope.path, scope.project])
  const all = new Set(catalog.scopes.map(key)), expected = new Set(selected.map(key)), observed = new Set(proof.files.map(f => key({ ...f, project: f.project ?? '' })))
  const valid = selected.every(s => all.has(key(s))) && expected.size === observed.size && [...expected].every(s => observed.has(s))
  return { ...proof, version: 3, catalog, selectedScopes: selected, selection: { projects: selection.overrideProjects.length ? selection.overrideProjects : selection.projects, shard: selection.unsharded ? undefined : selection.shard },
    complete: proof.complete && valid && catalog.canonical, scopeError: !catalog.canonical ? 'noncanonical_config' : valid ? undefined : 'scope_changed' }
}
export const scopeFile = (root: string, path: string) => relative(root, canonicalTestPath(path)).replaceAll('\\', '/')
