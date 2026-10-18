import { getResolvedEnv } from './resolved-env.js'
import { testWorkspace } from './test-workspaces.js'
import { existsSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cachedTestScopes, cacheTestScopes } from './test-scope-cache.js'
import { createVitestDiscovery } from './test-vitest-discovery.js'
import { join, relative, resolve } from 'node:path'
import { installedTestRunner, resolveRunnerDependency } from './test-runner-module.js'
import { classifyVerificationCommand, type VerificationInvocation } from './verification-command.js'
import { createJestBridge } from './test-jest-bridge.js'
import { createScopeCatalog, discoveryArguments, invocationEnvironment, nativeDiscovery, readScopeList, removeTestOptions, runnerArguments, scopePreparationTimeout, scopeFile, testOption, type TestScope } from './test-scope-catalog.js'
import { normalizedProjectConfig, testScopeDigest } from './test-project-identity.js'
import { parseTestSelection } from './test-selection.js'
import { testRunnerPreload } from './test-runner-preload.js'

export function prepareFrameworkScopes(directory: string, cwd: string, root: string, runId: string, fingerprint: string, invocation: VerificationInvocation, deadline: number) {
  if (invocation.runner !== 'jest' && invocation.runner !== 'vitest') throw new Error('unsupported_scope_runner')
  const installed = installedTestRunner(cwd, invocation.runner), args = runnerArguments(invocation), selection = parseTestSelection(args)
  const config = testOption(args, '--config', '-c'), standard = classifyVerificationCommand('npm run test', cwd)
  const standardConfig = testOption(standard.resolvedArgv ?? standard.argv, '--config', '-c')
  const overrides = invocationEnvironment(invocation), standardOverrides = standard.runner === invocation.runner ? invocationEnvironment(standard) : {}
  if (overrides.NODE_OPTIONS !== undefined) throw new Error('scope_env_override: NODE_OPTIONS 在脚本内部被覆盖；请移到项目的执行环境配置以保留内部采证预加载。')
  const conditionKeys = ['--root','--dir','--environment','--env','--pool','--setupFiles','--setupFilesAfterEnv','--testMatch','--testRegex','--projects']
  const canonical = (!standard.runner || standard.runner === invocation.runner) && config === standardConfig && testScopeDigest(overrides) === testScopeDigest(standardOverrides) && conditionKeys.every(key => testOption(args, key) === testOption(standard.resolvedArgv ?? standard.argv, key))
  const environment = Object.entries({ ...getResolvedEnv(cwd), ...overrides }).filter(([key]) => !/^(?:RIVET_HOME$|RIVET_SESSION_DIR$|RIVET_TEST_COMPLETION_RUN$|PWD$|OLDPWD$|SHLVL$|_$|NODE_TEST_CONTEXT$)/.test(key)).sort().map(([key, value]) => [key, value?.split(root).join('<repository>')])
  const origin = JSON.stringify([process.platform, process.versions.node, testScopeDigest(environment), invocation.runner, relative(root, cwd).replaceAll('\\', '/'), config ?? '<default>',
    discoveryArguments(invocation).filter(arg => arg !== '--json').map(arg => arg.split(root).join('<repository>'))])
  const cacheKey = testScopeDigest([origin, fingerprint, installed.version]), cached = cachedTestScopes(cacheKey)
  let scopes: TestScope[], jest: ReturnType<typeof createJestBridge> | undefined
  if (invocation.runner === 'jest') {
    if (!installed.packageFile) throw new Error('missing_dependency')
    const core = resolveRunnerDependency(cwd, installed.packageFile, '@jest/core')
    const loader = resolveRunnerDependency(cwd, installed.packageFile, 'jest-config') ?? (core && resolveRunnerDependency(cwd, core, 'jest-config'))
    if (!loader) throw new Error('missing_dependency')
    // Native configuration resolves presets, TS/async configs and custom sequencers.
    // showConfig writes stdout; keep it separate from user JSON/report paths.
    const native = nativeConfig(installed.entry, parseTestSelection(args).rest.filter(arg => !invocation.targets.includes(arg)), cwd, deadline, overrides)
    const originalSequencer = native.globalConfig?.testSequencer
    if (!originalSequencer) throw new Error('scope_sequencer_unresolved')
    jest = createJestBridge(directory, { root, cwd, origin, runId, config, configLoader: loader, sequencer: originalSequencer,
      reporters: native.globalConfig?.reporters ?? ['default'], processor: native.globalConfig?.testResultsProcessor })
    const actualConfig = nativeConfig(installed.entry, [...removeTestOptions(discoveryArguments(invocation), ['--config', '-c']), '--config', jest.bridge], cwd, deadline, overrides)
    if (!Array.isArray(native.configs) || native.configs.length !== actualConfig.configs?.length) throw new Error('scope_changed')
    const identities = native.configs.map((config: any, slot: number) => {
      const digest = testScopeDigest(normalizedProjectConfig(config, root))
      if (digest !== testScopeDigest(normalizedProjectConfig(actualConfig.configs[slot], root))) throw new Error('scope_changed')
      return { id: actualConfig.configs[slot].id, digest, project: testScopeDigest([origin, slot, digest]) }
    })
    writeFileSync(join(directory, 'identities.json'), JSON.stringify(identities), { mode: 0o600 })
    if (cached) scopes = cached
    else {
      nativeDiscovery(installed.entry, [...removeTestOptions(discoveryArguments(invocation), ['--config', '-c']), '--config', jest.bridge, '--listTests', '--passWithNoTests'], cwd, deadline, overrides)
      scopes = readScopeList(jest.inventory, root)
      rmSync(jest.inventory); rmSync(jest.selected)
    }
    for (const file of ['processed.json', 'output-error', 'jest.json']) rmSync(join(directory, file), { force: true })
  } else {
    if (cached) scopes = cached
    else {
      const inventory = join(directory, 'vitest-inventory.json')
      const api = installed.packageFile && resolveRunnerDependency(cwd, installed.packageFile, 'vitest/node')
      if (!api) throw new Error('missing_dependency')
      const discovery = createVitestDiscovery(directory, api, root, discoveryArguments(invocation).filter(a => a !== '--json'), inventory)
      nativeDiscovery(discovery, [], cwd, deadline, overrides)
      scopes = readScopeList(inventory, root, row => ({ path: scopeFile(root, row.file), label: row.projectName ?? '', project: testScopeDigest([origin, row.projectName ?? '', row.projectConfig]) }))
    }
  }
  const output = invocation.runner === 'jest' && args.includes('--json') ? testOption(args, '--outputFile') : undefined
  const outputState = () => { try { const s = statSync(resolve(cwd, output!), { bigint: true }); return String(s.mtimeNs) + ':' + String(s.ctimeNs) } catch { return undefined } }
  const beforeOutput = output ? outputState() : undefined
  const targets = invocation.targets.map(path => scopeFile(root, resolve(cwd, path)))
  const bounded = targets.length && targets.every(path => scopes.some(s => s.path === path)) ? scopes.filter(s => targets.includes(s.path)) : scopes
  const catalog = createScopeCatalog(bounded, origin, fingerprint, installed.version, canonical, testScopeDigest(scopes))
  return { catalog, selection, jest,
    cache() { cacheTestScopes(cacheKey, scopes) },
    candidatesValid() {
      const actual = jest ? readScopeList(jest.inventory, root) : readScopeList(join(directory, 'actual-inventory.json'), root, row => ({ path: scopeFile(root, row.file), project: testScopeDigest([origin, row.projectName ?? '', row.projectConfig]) }))
      const paths = new Set(actual.map(s => s.path)), projects = new Set(actual.map(s => s.project))
      const targeted = invocation.targets.map(path => scopeFile(root, resolve(cwd, path)))
      const expected = scopes.filter(s => (!targeted.length || targeted.includes(s.path) || paths.has(s.path)) && (!(selection.projects.length || selection.ignoredProjects.length || selection.overrideProjects.length) || selection.allProjects || projects.has(s.project)))
      const key = (s: TestScope) => JSON.stringify([s.path,s.project])
      return actual.length === expected.length && expected.every(s => actual.some(a => key(a) === key(s)))
    },
    outputComplete(exitCode: number) {
      if (!jest) return true
      try { const processed = JSON.parse(readFileSync(join(directory, 'processed.json'), 'utf8'));
        return exitCode >= 0 && processed.runId === runId && !existsSync(join(directory, 'output-error')) && (!output || !!outputState() && outputState() !== beforeOutput)
      } catch { return false }
    },
    env: jest ? testRunnerPreload(directory, cwd, installed.entry, jest.bridge, 'jest') : undefined,
    mapVitest<T extends { path: string; project?: string; label?: string; projectConfig?: string }>(file: T) {
      const matches = scopes.filter(s => s.path === file.path && s.label === (file.label ?? file.project?.split(':')[0] ?? '') && s.project === testScopeDigest([origin, file.label ?? file.project?.split(':')[0] ?? '', file.projectConfig]))
      if (matches.length !== 1) throw new Error('project_identity_unresolved')
      const { projectConfig: _conditions, label: _label, ...facts } = file
      return { ...facts, project: matches[0]!.project }
    },
    selected() { return jest ? readScopeList(jest.selected, root) : readScopeList(join(directory, 'vitest-selected.json'), root, row => ({ path: scopeFile(root, row.file), project: testScopeDigest([origin, row.projectName ?? '', row.projectConfig]), label: row.projectName ?? '' })) },
  }
}

// Configuration queries use the same installed runner and PnP bootstrap as discovery.
function nativeConfig(entry: string, args: string[], cwd: string, deadline: number, environment: NodeJS.ProcessEnv): any {
  const pnp = join(testWorkspace(cwd).root, '.pnp.cjs')
  return JSON.parse(execFileSync(process.execPath, [...(existsSync(pnp) ? ['--require', pnp] : []), entry, ...args, '--showConfig'], {
    cwd, env: { ...getResolvedEnv(cwd), ...environment, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', timeout: scopePreparationTimeout(deadline), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  }))
}
