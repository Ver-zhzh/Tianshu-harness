import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCompletionCoverage, type CompletionCapture } from './test-completion.js'
import type { VerificationInvocation } from './verification-command.js'
import { canonicalTestPath, insideTestRoot } from './test-workspaces.js'
import { installedTestRunner, resolveRunnerDependency } from './test-runner-module.js'
import { workspaceIdentity } from './test-completion-identity.js'
import { vitestReporterSource } from './test-reporter-source.js'
import type { TestCompletionCoverage } from './types.js'
import { hasFocusedTestDefinition } from './test-selection-guards.js'
import { vitestProjectIdentitySource } from './test-vitest-identity.js'
import { prepareFrameworkScopes } from './test-framework-scope.js'
import { bindScopeCoverage } from './test-scope-catalog.js'
import { testRunnerPreload } from './test-runner-preload.js'
import { renderTestCommand } from './test-command-render.js'

type Leaf = { command: string; cwd: string; wrap: (inner: string) => string }
function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.findIndex(arg => arg === name || arg.startsWith(name + '='))
  return index < 0 ? undefined : argv[index]!.includes('=') ? argv[index]!.slice(name.length + 1) : argv[index + 1]
}
function vitestBridge(directory: string, packageRoot: string, invocation: VerificationInvocation, runId: string, root: string): { argv: string[]; report: string; env?: NodeJS.ProcessEnv } | undefined {
  const leaf = invocation.resolvedArgv ?? invocation.argv
  const installed = installedTestRunner(packageRoot, 'vitest')
  const vite = installed.packageFile && resolveRunnerDependency(packageRoot, installed.packageFile, 'vite')
  if (!vite) return undefined
  let config = option(leaf, '--config') ?? option(leaf, '-c')
  if (config) config = resolve(packageRoot, config)
  else for (const name of ['vitest', 'vite']) {
    for (const ext of ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts']) if (existsSync(join(packageRoot, name + '.config.' + ext))) { config = join(packageRoot, name + '.config.' + ext); break }
    if (config) break
  }
  const report = join(directory, 'vitest.json'), reporter = join(directory, 'reporter.mjs'), bridge = join(directory, 'vitest.config.mjs')
  const workspace = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts', 'json'].map(ext => join(packageRoot, 'vitest.workspace.' + ext)).find(existsSync)
  writeFileSync(reporter, vitestReporterSource({ runId, root, path: report }), { mode: 0o600 })
  // CLI reporters override config reporters. Append on the same CLI surface instead.
  const cliReporter = !!(option(leaf, '--reporter') || option(leaf, '--reporters'))
  const nodeApi = installed.packageFile && resolveRunnerDependency(packageRoot, installed.packageFile, 'vitest/node')
  if (!nodeApi) return undefined
  // Keep this import dynamic: Vite must not bundle its own entire implementation into a config.
  writeFileSync(bridge, `import {writeFileSync,existsSync} from 'node:fs';
${vitestProjectIdentitySource(root)}
const nativeEntry=${JSON.stringify(pathToFileURL(nodeApi).href)};const nodeApi=await import(nativeEntry);
const entry=${JSON.stringify(pathToFileURL(vite).href)};
const api=await import(entry),loadConfigFromFile=api.loadConfigFromFile??api.default?.loadConfigFromFile;
export default async env=>{const loaded=${config ? `await loadConfigFromFile(env,${JSON.stringify(config)},${JSON.stringify(packageRoot)})` : 'undefined'};
const c=loaded?.config??{},test=c.test??{},sequence=test.sequence??{};
let Original=sequence.sequencer??nodeApi.BaseSequencer;
if(typeof Original==='string'){const url=Original.startsWith('.')?new URL(Original,${JSON.stringify(pathToFileURL(config ?? join(packageRoot, 'vitest.config.mjs')).href)}).href:Original;const mod=await import(url);Original=mod.default;}
const save=(path,specs)=>writeFileSync(path,JSON.stringify(specs.map(s=>({file:s.moduleId??s[1],projectName:s.project?.name??s[0]?.config?.name??'',projectConfig:projectConfig(s.project?.config??s[0]?.config)}))),{mode:0o600});
class Observer extends Original {
async shard(specs){save(${JSON.stringify(join(directory, 'actual-inventory.json'))},specs);return await super.shard(specs);}
async sort(specs){if(!existsSync(${JSON.stringify(join(directory, 'actual-inventory.json'))}))save(${JSON.stringify(join(directory, 'actual-inventory.json'))},specs);const result=await super.sort(specs);save(${JSON.stringify(join(directory, 'vitest-selected.json'))},result);return result;}
}
const reporters=Array.isArray(test.reporters)?test.reporters:test.reporters?[test.reporters]:['default'];
return {...c,test:{...test,sequence:{...sequence,sequencer:Observer},...(${JSON.stringify(workspace)}&&test.workspace===undefined?{workspace:${JSON.stringify(workspace)}}:{}),reporters:[...reporters,${JSON.stringify(reporter)}]}}};`, { mode: 0o600 })
  return { argv: cliReporter ? ['--reporter', reporter] : [], report, env: testRunnerPreload(directory, packageRoot, installed.entry, bridge, 'vitest') }
}
export function prepareFrameworkCompletion(leaf: Leaf, invocation: VerificationInvocation, shell: 'bash' | 'sh' | 'powershell' | 'cmd', repositoryRoot?: string, deadline = Date.now() + 10000): CompletionCapture | undefined {
  if (invocation.reason || invocation.filtered || invocation.persistent || !invocation.runner) return undefined
  const cwd = canonicalTestPath(invocation.resolvedCwd ?? leaf.cwd), installed = installedTestRunner(cwd, invocation.runner)
  if (installed.reason) return undefined
  let directory: string | undefined
  try {
    const root = canonicalTestPath(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim())
    const before = workspaceIdentity(root)
    if (!before) return undefined
    const runId = randomUUID()
    directory = mkdtempSync(join(tmpdir(), 'rivet-framework-proof-'))
    const argv = invocation.argv.slice()
    if (nativeForceExit(invocation)) throw new Error('forced_exit_unverifiable')
    const scoped = prepareFrameworkScopes(directory, cwd, root, runId, before, invocation, deadline)
    let report: string, additions: string[], bridgeEnv: NodeJS.ProcessEnv | undefined
    if (invocation.runner === 'vitest') {
      const bridge = vitestBridge(directory, cwd, invocation, runId, root)
      if (!bridge) { rmSync(directory, { recursive: true, force: true }); return undefined }
      additions = bridge.argv; report = bridge.report; bridgeEnv = bridge.env
    } else {
      report = scoped.jest!.report; additions = []
      bridgeEnv = scoped.env
    }
    if (invocation.resolvedArgv && invocation.packageScript && /(?:^|[/\\])npm(?:\.cmd)?$/.test(argv[0]??'') && !argv.includes('--')) argv.push('--')
    argv.push(...additions)
    const command = renderTestCommand(argv, shell)
    if (!command) { rmSync(directory, { recursive: true, force: true }); return undefined }
    const dir = directory
    return { command: leaf.wrap(command), env: { NODE_TEST_CONTEXT: undefined, ...bridgeEnv },
      read(exitCode) {
        const workspaceChanged = before !== workspaceIdentity(root)
        try {
          const data = JSON.parse(readFileSync(report, 'utf8'))
          let proof: TestCompletionCoverage | undefined
          if (invocation.runner === 'jest' && data.runId === runId) proof = { ...data, version: 2, runner: 'jest', executionComplete: data.complete }
          else if (data.runId === runId && canonicalTestPath(data.root) === root && data.path === report) proof = { ...data, version: 2, runner: 'vitest', executionComplete: data.complete }
          if (!proof) throw new Error('missing or foreign report')
          if (invocation.runner === 'vitest') proof.files = proof.files.map(file => scoped.mapVitest(file))
          proof = bindScopeCoverage(proof, scoped.catalog, scoped.selected(), scoped.selection)
          const targets = invocation.targets.filter(target => !/[*?[]/.test(target))
          if (!scoped.selection.shard && targets.some(target => !proof.files.some(file => canonicalTestPath(resolve(root, file.path)) === canonicalTestPath(resolve(cwd, target))))) proof.complete = false
          const paths = new Set<string>()
          for (const file of proof.files) {
            proof.filtered ||= hasFocusedTestDefinition(resolve(root, file.path))
            const key = JSON.stringify([file.path, file.project])
            if (!insideTestRoot(root, canonicalTestPath(resolve(root, file.path))) || paths.has(key)) proof.complete = false
            paths.add(key)
          }
          if (!scoped.candidatesValid()) { proof.complete = false; proof.scopeError = 'scope_changed' }
          if (!scoped.outputComplete(exitCode)) { proof.complete = false; proof.scopeError = 'output_error' }
          proof.complete &&= !workspaceChanged && (exitCode === 0 || exitCode > 0 && proof.files.some(file => file.outcome === 'failed'))
          const coverage = readCompletionCoverage({ ...proof, runId, cwd, repositoryRoot: canonicalTestPath(repositoryRoot ?? root), executionRoot: root, workspaceChanged })
          if (coverage?.complete && !coverage.filtered) scoped.cache()
          return coverage
        } catch { return { version: 3, catalog: scoped.catalog, selectedScopes: [], runId, runner: invocation.runner!, cwd, repositoryRoot: canonicalTestPath(repositoryRoot ?? root), executionRoot: root,
          executionComplete: false, workspaceChanged, scopeError: 'scope_receipt_invalid', complete: false, filtered: false, files: [] } }
      },
      dispose() { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) },
    }
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true })
    const reason = error instanceof Error && /^(?:forced_exit_|scope_|project_identity_|missing_dependency)/.test(error.message) ? error.message : 'scope_discovery_failed'
    return { command: leaf.wrap(leaf.command), env: {}, preparationError: reason, read: () => ({ version: 2, runner: invocation.runner!, runId: randomUUID(), cwd, repositoryRoot: canonicalTestPath(repositoryRoot ?? cwd), complete: false, filtered: false, scopeError: reason, files: [] }), dispose() {} }
  }
}

function nativeForceExit(invocation: VerificationInvocation): boolean { return (invocation.resolvedArgv ?? invocation.argv).includes('--forceExit') }
