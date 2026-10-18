import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const dependencies = process.env.TIANSHU_TEST_RUNNER_FIXTURES
export const available = (runner: string) => !!dependencies && existsSync(join(dependencies, 'node_modules', runner, 'package.json'))
export function fixture(runner: 'vitest' | 'jest' | 'node-test', workspace = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'framework-proof-'))
  const file = runner === 'vitest' ? 'src/a.spec.tsx' : runner === 'jest' ? 'src/a.test.cjs' : 'a.test.mjs'
  const directory = workspace ? join(cwd, 'packages/web') : cwd
  mkdirSync(join(directory, 'src'), { recursive: true })
  const write = (path: string, value: unknown) => writeFileSync(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value))
  const vitestMajor = dependencies && available('vitest') ? Number(JSON.parse(readFileSync(join(dependencies, 'node_modules/vitest/package.json'), 'utf8')).version.split('.')[0]) : 5
  write('package.json', { name: '@fixture/web', type: 'module', private: true, scripts: {
    pretest: 'node -e "require(\'fs\').appendFileSync(\'hooks.log\',\'pre\\n\')"',
    test: runner === 'vitest' ? 'vitest run --maxWorkers=1' + (vitestMajor < 4 ? ' --minWorkers=1' : '') : runner === 'jest' ? 'jest --runInBand' : 'node --test',
    posttest: 'node -e "require(\'fs\').appendFileSync(\'hooks.log\',\'post\\n\')"',
  } })
  if (runner === 'jest') write('jest.config.cjs', "module.exports={testMatch:['**/*.test.cjs']};")
  write(file, runner === 'vitest' ? "import {test,expect} from 'vitest';test('proof',()=>expect(1).toBe(1));" : runner === 'jest' ? "test('proof',()=>expect(1).toBe(1));" : "import {test} from 'node:test';test('proof',()=>{});")
  if (dependencies) symlinkSync(join(dependencies, 'node_modules'), join(directory, 'node_modules'), 'junction')
  if (workspace) {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.7.0', scripts: { test: 'pnpm --filter @fixture/web test' } }))
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    // pnpm initializes this even for `run`; initialize before binding the code/config fingerprint.
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/web: {}\n")
  }
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n**/node_modules\n*.log\n**/*.log\n')
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
  return { cwd, directory, file, path: workspace ? 'packages/web/' + file : file, write,
    dispose: () => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

