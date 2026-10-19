/** Restore each misleading feedback path in memory; never rewrite a shared checkout. */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const { transformSync } = createRequire(join(root, 'package.json'))('esbuild')
const feedbackTest = 'src/tools/__tests__/execution-feedback.test.ts'
const cases = [
  ['bash exonerates code', 'src/tools/bash.ts', feedbackTest, 'real missing command', s => s.replace(/modelBody = `执行入口问题：[^\n]+/, 'modelBody = `环境依赖缺失，非代码缺陷。${filtered}`')],
  ['exit 126 fabricates permissions as root cause', 'src/tools/bash.ts', feedbackTest, 'exit 126 does not fabricate', s => s.replace('command could not be executed (exit 126)', 'command found but not executable (permission denied)')],
  ['unprobed Python installation', 'src/tools/env-check.ts', 'src/tools/__tests__/env-check.test.ts', 'checks existing Python', s => s.replace(/return `\\n\[入口核查\] 先核对项目虚拟环境[^\n]+/, 'return `\\n[环境缺失] ${getInstallCommand("python", platform)}`')],
  ['Windows executable rejection called missing', 'src/tools/powershell-filter.ts', 'src/tools/__tests__/powershell-filter.test.ts', 'exit 126', s => s.replace('recoveryHint(body, ctx.command, ctx.exitCode)', 'recoveryHint(body, ctx.command, 127)')],
  ['background start suggests a completion pattern', 'src/tools/bash.ts', feedbackTest, 'background start recommends', s => s.replace('job(action="await", id="${snap.id}") 等待退出', 'job(action="await", id="${snap.id}", pattern="Ready|listening|compiled") 等待就绪/退出')],
  ['job match masks failed terminal state', 'src/tools/job-tool.ts', feedbackTest, 'job output pattern', s => s.replace("const verdict = job.status !== 'running'", "const verdict = !matched && job.status !== 'running'")],
  ['job UI masks failed terminal state', 'src/tools/job-tool.ts', feedbackTest, 'job output pattern', s => s.replace("job.status !== 'running' ? fmtStatus(job) :", 'false ? fmtStatus(job) :')],
  ['generic timeout invents durable worker state', 'src/agent/tool-pipeline.ts', feedbackTest, 'actual pipeline timeout', s => s.replace(/export const TOOL_TIMEOUT_RECOVERY_HINT =\n  '[^']*'/, "export const TOOL_TIMEOUT_RECOVERY_HINT =\n  '— worker 写入已落盘，可用 executePlanWaves fromWave=N 续跑'")],
  ['sandbox denial exonerates code and licenses replay', 'src/tools/sandbox-diagnose.ts', 'src/tools/__tests__/sandbox-diagnose.test.ts', 'names the path', s => s.replace(/const antiPattern = '[^']*'/, "const antiPattern = '不是代码缺陷，批准后直接重跑即可。'")],
  ['detached plan suggests concurrent redispatch', 'src/tools/plan-task.ts', 'src/tools/__tests__/plan-task-timeout.test.ts', '到点立即返回', s => s.replace('后台仍在执行时不要再次派发；等完成通知。', '可用 executePlanWaves fromWave=N 续跑。')],
  ['typecheck timeout immediately repeats the execution', 'src/lsp/typecheck-cache.ts', feedbackTest, 'typecheck timeout checks', s => s.replace('确认原执行已结束且无可复用结果，再按剩余预算', '立即')],
]

if (process.env.EXECUTION_FEEDBACK_RESTORED_DEFECT !== undefined) {
  const entry = cases[Number(process.env.EXECUTION_FEEDBACK_RESTORED_DEFECT)]
  assert.ok(entry, 'unknown restored defect')
  registerHooks({ load(url, context, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== join(root, entry[1])) return next(url, context)
    const source = readFileSync(new URL(url), 'utf8')
    const restored = entry[4](source)
    assert.notEqual(restored, source, 'restoration anchor missing')
    return { shortCircuit: true, format: 'module', source: transformSync(restored, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  const home = mkdtempSync(join(tmpdir(), 'rivet-feedback-mutation-'))
  writeFileSync(join(home, 'config.json'), '{}')
  try {
    for (const [i, [name, , file, pattern]] of cases.entries()) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', import.meta.filename, '--test', '--test-name-pattern=' + pattern, file], {
        cwd: root, env: { ...process.env, RIVET_HOME: home, RIVET_SESSION_DIR: join(home, 'sessions'), EXECUTION_FEEDBACK_RESTORED_DEFECT: String(i) },
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      const output = result.stdout + result.stderr
      assert.ok(result.status === 1 && output.includes('AssertionError') && !output.includes('restoration anchor missing'), `${name}: expected assertion RED\n${output.slice(-2500)}`)
      console.log('ASSERTION RED: ' + name)
    }
    console.log(`${cases.length} restored defects caught; checkout untouched`)
  } finally { rmSync(home, { recursive: true, force: true }) }
}
