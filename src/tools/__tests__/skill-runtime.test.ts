import { after } from 'node:test'
const priorProjectTrust = process.env.RIVET_TRUST_PROJECT
process.env.RIVET_TRUST_PROJECT = '1'
after(() => { if (priorProjectTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = priorProjectTrust })
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILL_RUNTIME_TOOL } from '../skill-runtime.js'
import { SkillRegistry } from '../../skills/skill-loader.js'
import { recordSkillInvoked, clearSkillGate } from '../../agent/skill-gate.js'
import { detectPythonInterpreter } from '../../skills/runtime/interpreter.js'
import type { ToolCallParams } from '../types.js'

const SKILL_MD = (name: string, extra = '') => `---\nname: ${name}\ndescription: runtime fixture\n${extra}---\nbody\n`
const RUNTIME_YAML = `version: 1
python:
  entries:
    echo:
      script: scripts/echo.py
      timeoutSeconds: 60
    fail:
      script: scripts/fail.py
`

function fixture(opts: { mode?: string; runtimeYaml?: string | false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-runtime-tool-'))
  const cwd = join(root, 'project'), home = join(root, 'home'), external = join(root, 'external')
  mkdirSync(cwd, { recursive: true }); mkdirSync(home); mkdirSync(external)
  const skillDir = join(cwd, '.rivet', 'skills', 'calc')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD('calc', opts.mode === 'manual' ? 'disable-model-invocation: true\n' : ''))
  if (opts.runtimeYaml !== false) writeFileSync(join(skillDir, 'runtime.yaml'), opts.runtimeYaml ?? RUNTIME_YAML)
  writeFileSync(join(skillDir, 'scripts', 'echo.py'), 'import sys, os\nprint("argv:" + "|".join(sys.argv[1:]))\nprint("stdin:" + sys.stdin.read())\nprint("PYTHONPATH=" + str(os.environ.get("PYTHONPATH")))\nprint("RESOURCE_DIR=" + str(os.environ.get("RIVET_SKILL_RESOURCE_DIR") is not None))\n')
  writeFileSync(join(skillDir, 'scripts', 'fail.py'), 'import sys\nsys.exit(3)\n')

  const registry = new SkillRegistry()
  const { loaded, errors } = registry.loadFromDirectory(join(cwd, '.rivet', 'skills'), 'rivet')
  assert.deepEqual(errors, [])
  assert.ok(loaded.includes('calc'))
  return { root, cwd, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function params(f: ReturnType<typeof fixture>, input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'rt-test', cwd: f.cwd, skillRegistry: f.registry, sessionId: 'rt-test-session' } as ToolCallParams
}

// 真实解释器（本机 /usr/bin/python3）；缺席则跳过执行类用例。
const hasPython = await detectPythonInterpreter().then(p => p.found)

describe('skill_runtime 工具契约', () => {
  it('审批面：prepare/run 恒需审批，doctor 免审；concurrency 不安全', () => {
    const p = (input: Record<string, unknown>) => ({ input }) as ToolCallParams
    assert.equal(SKILL_RUNTIME_TOOL.requiresApproval(p({ action: 'doctor', name: 'x' })), false)
    assert.equal(SKILL_RUNTIME_TOOL.requiresApproval(p({ action: 'prepare', name: 'x' })), true)
    assert.equal(SKILL_RUNTIME_TOOL.requiresApproval(p({ action: 'run', name: 'x', entry: 'e' })), true)
    assert.equal(SKILL_RUNTIME_TOOL.isConcurrencySafe(), false)
    // run 的管线超时随 timeoutSeconds 推导（+30s 边际）
    assert.equal(SKILL_RUNTIME_TOOL.timeoutMs?.(p({ action: 'run', name: 'x', entry: 'e', timeoutSeconds: 60 })), 90_000)
    assert.equal(SKILL_RUNTIME_TOOL.timeoutMs?.(p({ action: 'prepare', name: 'x' })), 900_000)
  })

  it('doctor：聚合声明/解释器/环境状态（免审批只读）', async () => {
    const f = fixture()
    try {
      const result = await SKILL_RUNTIME_TOOL.execute(params(f, { action: 'doctor', name: 'calc' }))
      assert.ok(!result.isError, result.content)
      const payload = JSON.parse(result.content)
      assert.equal(payload.name, 'calc')
      assert.equal(payload.declaration.python.entries.echo.script, 'scripts/echo.py')
      assert.ok(payload.interpreter !== undefined)
      assert.equal(payload.environment.status, 'not-prepared')
    } finally { f.cleanup() }
  })

  it('未声明（无 runtime.yaml）→ undeclared 指引；声明坏 → invalid_declaration', async () => {
    const f = fixture({ runtimeYaml: false })
    const bad = fixture({ runtimeYaml: 'version: 2\npython: {}\n' })
    try {
      const undeclared = await SKILL_RUNTIME_TOOL.execute(params(f, { action: 'prepare', name: 'calc' }))
      assert.equal(undeclared.isError, true)
      assert.match(undeclared.content, /undeclared|未声明/)
      const invalid = await SKILL_RUNTIME_TOOL.execute(params(bad, { action: 'run', name: 'calc', entry: 'echo' }))
      assert.equal(invalid.isError, true)
      assert.match(invalid.content, /invalid_declaration/)
    } finally { f.cleanup(); bad.cleanup() }
  })

  it('off 硬拒；manual 未加载拒、本会话加载后放行到环境检查', async () => {
    const off = fixture({ mode: 'off' })
    const manual = fixture({ mode: 'manual' })
    try {
      // off：mode 字段由技能记录层给；这里直接置定义 mode 模拟
      const offSkill = off.registry.get('calc')!
      offSkill.mode = 'off'
      const r1 = await SKILL_RUNTIME_TOOL.execute(params(off, { action: 'run', name: 'calc', entry: 'echo' }))
      assert.match(r1.content, /已停用/)

      const r2 = await SKILL_RUNTIME_TOOL.execute(params(manual, { action: 'run', name: 'calc', entry: 'echo' }))
      assert.match(r2.content, /仅手动使用/)
      // 本会话显式加载（/skill 落点）后：过模式门，落到环境未准备指引
      recordSkillInvoked('calc', 'rt-test-session')
      const r3 = await SKILL_RUNTIME_TOOL.execute(params(manual, { action: 'run', name: 'calc', entry: 'echo' }))
      assert.match(r3.content, /环境未准备|interpreter/)
      clearSkillGate('rt-test-session')
    } finally { off.cleanup(); manual.cleanup() }
  })

  it('未知入口 → 列出可用入口', async () => {
    const f = fixture()
    try {
      const result = await SKILL_RUNTIME_TOOL.execute(params(f, { action: 'run', name: 'calc', entry: 'nope' }))
      assert.equal(result.isError, true)
      assert.match(result.content, /入口「nope」不在声明内.*echo.*fail/s)
    } finally { f.cleanup() }
  })
})

describe('skill_runtime 真机执行（/usr/bin/python3 在场才跑）', () => {
  it('prepare → run：argv 字面传递（无 shell 展开）、stdin、env 剥离、非零退出判失败', { timeout: 120_000 }, async () => {
    if (!hasPython) return
    const f = fixture()
    const prevPath = process.env['PYTHONPATH']
    process.env['PYTHONPATH'] = '/evil-marker'
    try {
      const prepare = await SKILL_RUNTIME_TOOL.execute(params(f, { action: 'prepare', name: 'calc' }))
      assert.ok(!prepare.isError, prepare.content)
      const prepPayload = JSON.parse(prepare.content)
      assert.equal(prepPayload.status, 'ready')
      assert.equal(typeof prepPayload.sandbox, 'string', 'sandbox 字段如实回报')

      // run echo：argv 里的 $(...) 载荷必须按字面传递（无 shell）
      const run = await SKILL_RUNTIME_TOOL.execute(params(f, {
        action: 'run', name: 'calc', entry: 'echo',
        args: ['$(touch /tmp/pwned-523)', 'plain'], stdin: 'hello-stdin',
      }))
      assert.ok(!run.isError, run.content)
      const payload = JSON.parse(run.content)
      assert.equal(payload.exitCode, 0)
      assert.match(payload.stdout, /argv:\$\(touch \/tmp\/pwned-523\)\|plain/)
      assert.match(payload.stdout, /stdin:hello-stdin/)
      assert.match(payload.stdout, /PYTHONPATH=None/, 'PYTHONPATH 被剥离')
      assert.match(payload.stdout, /RESOURCE_DIR=True/, '资源目录注入')

      // run fail：exit 3 → script_failed + 退出码透传
      const failed = await SKILL_RUNTIME_TOOL.execute(params(f, { action: 'run', name: 'calc', entry: 'fail' }))
      assert.equal(failed.isError, true)
      const failPayload = JSON.parse(failed.content)
      assert.equal(failPayload.errorCode, 'script_failed')
      assert.equal(failPayload.exitCode, 3)
    } finally {
      if (prevPath === undefined) delete process.env['PYTHONPATH']
      else process.env['PYTHONPATH'] = prevPath
      f.cleanup()
    }
  })
})
