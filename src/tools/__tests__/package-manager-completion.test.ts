import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_TESTS_TOOL } from '../run-tests.js'

// Matrix setup is explicit and external to the runtime; default tests never install dependencies.
const profile = process.env.TIANSHU_TEST_PACKAGE_MANAGER
const dependencies = process.env.TIANSHU_TEST_RUNNER_FIXTURES
for (const runner of ['vitest', 'jest'] as const) test(`${profile ?? 'package manager'} / ${runner} actual package execution`, { skip: !profile || !dependencies, timeout: 240_000 }, async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'manager-proof-')))
  const manager = profile!.startsWith('yarn') ? 'yarn' : profile!
  const pnp = profile === 'yarn-pnp'
  const file = runner === 'vitest' ? 'src/中文 space & percent%20.spec.ts' : 'src/中文 space & percent%20.test.cjs'
  try {
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'manager-proof', private: true, type: 'module',
      packageManager: manager === 'yarn' ? pnp ? 'yarn@4.13.0' : 'yarn@1.22.22' : manager === 'pnpm' ? 'pnpm@11.7.0' : undefined,
      scripts: { test: runner === 'vitest' ? 'vitest run --maxWorkers=1 --config custom.config.mjs --shard=1/1' : 'jest --runInBand --shard=1/1' },
      ...(pnp ? { devDependencies: { [runner]: runner === 'vitest' ? '^5.0.5' : '^30.5.2', ...(runner === 'vitest' ? { vite: '^8.0.0' } : {}) } } : {}) }))
    writeFileSync(join(cwd, file), runner === 'vitest' ? "import {test,expect} from 'vitest';test('proof',()=>expect(globalThis.managerSetup).toBe(true));" : "test('proof',()=>{});")
    if (runner === 'vitest') {
      writeFileSync(join(cwd, 'custom.config.mjs'), "export default {test:{setupFiles:['./setup.mjs']}};")
      writeFileSync(join(cwd, 'setup.mjs'), 'globalThis.managerSetup=true;')
    }
    if (runner === 'jest') writeFileSync(join(cwd, 'jest.config.cjs'), "module.exports={testMatch:['**/*.test.cjs']};")
    if (pnp) {
      writeFileSync(join(cwd, '.yarnrc.yml'), 'nodeLinker: pnp\npnpEnableEsmLoader: true\nenableGlobalCache: false\n')
      // Only this opted-in integration fixture performs an installation, before proof binding.
      execFileSync(manager, ['install', '--mode=skip-build'], { cwd, timeout: 180_000, stdio: 'pipe', shell: process.platform === 'win32' })
      assert.ok(existsSync(join(cwd, '.pnp.cjs')), 'matrix setup must produce an actual PnP map')
      execFileSync(process.execPath, ['--require', join(cwd, '.pnp.cjs'), '-p', `require('node:module').createRequire(${JSON.stringify(join(cwd, 'package.json'))}).resolve(${JSON.stringify(runner + '/package.json')})`], { cwd, encoding: 'utf8', stdio: 'pipe' })
    } else {
      symlinkSync(join(dependencies!, 'node_modules'), join(cwd, 'node_modules'), 'junction')
      if (manager === 'pnpm') execFileSync(manager, ['install', '--lockfile-only', '--ignore-scripts'], { cwd, timeout: 30_000, stdio: 'pipe', shell: process.platform === 'win32' })
    }
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n.yarn\n*.log\n')
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
    const result = await RUN_TESTS_TOOL.execute({ cwd, toolUseId: 'package-manager-proof', input: { files: [file], projects: [], shard: false, timeout: 30_000 } })
    assert.equal(result.isError, false, result.content)
    assert.equal(result.verification?.coverage?.complete, true, JSON.stringify(result.verification))
    assert.equal(result.verification?.coverage?.files[0]?.path, file)
  } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
