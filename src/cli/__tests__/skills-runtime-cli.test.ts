import { after } from 'node:test'
const priorProjectTrust = process.env.RIVET_TRUST_PROJECT
process.env.RIVET_TRUST_PROJECT = '1'
after(() => { if (priorProjectTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = priorProjectTrust })
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSkillsCLI } from '../skills-cli.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { detectPythonInterpreter } from '../../skills/runtime/interpreter.js'

const RUNTIME_YAML = `version: 1
python:
  entries:
    fail:
      script: scripts/fail.py
    echo:
      script: scripts/echo.py
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skills-runtime-cli-'))
  const cwd = join(root, 'project'), home = join(root, 'home'), external = join(root, 'external')
  mkdirSync(cwd, { recursive: true }); mkdirSync(home); mkdirSync(external)
  const skillDir = join(cwd, '.rivet', 'skills', 'calc')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: calc\ndescription: cli fixture\n---\nbody\n')
  writeFileSync(join(skillDir, 'runtime.yaml'), RUNTIME_YAML)
  writeFileSync(join(skillDir, 'scripts', 'echo.py'), 'import sys\nprint("argv:" + "|".join(sys.argv[1:]))\n')
  writeFileSync(join(skillDir, 'scripts', 'fail.py'), 'import sys\nsys.exit(3)\n')
  const management = new SkillManagement(home, external)
  return { root, cwd, management, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const hasPython = await detectPythonInterpreter().then(p => p.found)

describe('skills CLI — prepare/run（issue #523）', () => {
  it('非交互无 --yes → 拒绝并给预览；--source 缺 --allow-source-build → 拒绝', async () => {
    const f = fixture()
    try {
      // 测试环境 stdout 非 TTY → 非交互分支
      const noYes = await runSkillsCLI(['prepare', 'calc'], { cwd: f.cwd, management: f.management })
      assert.equal(noYes.exitCode, 1)
      assert.match(noYes.output, /--yes/)
      assert.match(noYes.output, /envKey/, '拒绝时带预览')

      const source = await runSkillsCLI(['prepare', 'calc', '--source'], { cwd: f.cwd, management: f.management })
      assert.equal(source.exitCode, 1)
      assert.match(source.output, /--allow-source-build/)
    } finally { f.cleanup() }
  })

  it('真机：prepare --yes → ready；run 退出码透传（exit 3）；run 未准备 → 非零+指引', { timeout: 150_000 }, async () => {
    if (!hasPython) return
    const f = fixture()
    try {
      // run 在准备之前 → 非零 + 准备指引
      const early = await runSkillsCLI(['run', 'calc', 'echo', '--', 'a'], { cwd: f.cwd, management: f.management })
      assert.equal(early.exitCode, 1)
      assert.match(early.output, /skills prepare/)

      const prep = await runSkillsCLI(['prepare', 'calc', '--yes', '--json'], { cwd: f.cwd, management: f.management })
      assert.equal(prep.exitCode, 0, prep.output)
      assert.match(prep.output, /环境准备完成/)

      // run 透传真实退出码（exit 3）
      const failed = await runSkillsCLI(['run', 'calc', 'fail'], { cwd: f.cwd, management: f.management })
      assert.equal(failed.exitCode, 3, JSON.stringify(failed))

      // run 成功 + args 透传
      const ok = await runSkillsCLI(['run', 'calc', 'echo', '--', 'x', 'y', '--json'], { cwd: f.cwd, management: f.management })
      assert.equal(ok.exitCode, 0)
      assert.match(ok.output, /argv:x\|y/)
    } finally { f.cleanup() }
  })
})
