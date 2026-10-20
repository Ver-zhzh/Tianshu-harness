/** Restore missing scope at the real consumers in memory; checkout stays intact. */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const { transformSync } = createRequire(join(root, 'package.json'))('esbuild')
const promptTest = 'src/prompt/__tests__/domain-task-boundary.test.ts'
const cases = [
  ['main loses shared boundary', 'src/prompt/volatile.ts', promptTest, 'qisha: main actual request', s => s.replace('${DOMAIN_TASK_BOUNDARY}', '')],
  ['worker loses shared boundary', 'src/prompt/volatile.ts', 'src/agent/__tests__/domain-task-boundary-integration.test.ts', 'actual reviewer worker', s => s.replace('${DOMAIN_TASK_BOUNDARY}', '')],
  ['Qisha treats nomination as universal completion', 'src/agent/star-domain-data.ts', promptTest, 'Qisha nomination-only completion', s => s.replaceAll('以下提名与报告的交付标准仅适用于减法审查。明确要求实施、修复或验证时，按当前任务目标交付；审查提名不授予删除权限，星域身份不改变原有授权。\n\n', '')],
  ['unclassified input overrides explicit read-only constraint', 'src/agent/discipline-eligibility.ts', 'src/agent/__tests__/discipline-eligibility.test.ts', 'explicitNoMutation overrides fallback', s => s.replace('if (!hasAnyKind && !explicitNoMutation)', 'if (!hasAnyKind)')],
]

if (process.env.DOMAIN_BOUNDARY_RESTORED_DEFECT !== undefined) {
  const entry = cases[Number(process.env.DOMAIN_BOUNDARY_RESTORED_DEFECT)]
  assert.ok(entry, 'unknown restored defect')
  registerHooks({ load(url, context, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== join(root, entry[1])) return next(url, context)
    const source = readFileSync(new URL(url), 'utf8')
    const restored = entry[4](source)
    assert.notEqual(restored, source, 'restoration anchor missing')
    return { shortCircuit: true, format: 'module', source: transformSync(restored, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  const home = mkdtempSync(join(tmpdir(), 'rivet-domain-mutation-'))
  writeFileSync(join(home, 'config.json'), '{}')
  try {
    for (const [i, [name, , file, pattern]] of cases.entries()) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', import.meta.filename, '--test', '--test-name-pattern=' + pattern, file], {
        cwd: root, env: { ...process.env, RIVET_HOME: home, RIVET_SESSION_DIR: join(home, 'sessions'), DOMAIN_BOUNDARY_RESTORED_DEFECT: String(i) },
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      const output = result.stdout + result.stderr
      assert.ok(result.status === 1 && output.includes('AssertionError') && !output.includes('restoration anchor missing'), `${name}: expected assertion RED\n${output.slice(-2500)}`)
      console.log('ASSERTION RED: ' + name)
    }
    console.log(`${cases.length} restored defects caught; checkout untouched`)
  } finally { rmSync(home, { recursive: true, force: true }) }
}
