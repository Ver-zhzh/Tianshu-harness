import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackage } from '../../skill-package.js'
import { SkillVersionStore } from '../../skill-version-store.js'
import { buildRuntimeExecutionPlan, revalidateRuntimePlan } from '../operation.js'
import { prepareSkillRuntime, resolveRuntimeSkill } from '../executor.js'
import { SkillEnvironmentManager } from '../environment-manager.js'

it('lazy snapshots prepare from pinned bytes and immutable previews; library drift is rejected', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-pinned-'))
  const previousTrust = process.env.RIVET_TRUST_PROJECT
  process.env.RIVET_TRUST_PROJECT = '1'
  try {
    const pkg = join(root, 'pkg')
    mkdirSync(join(pkg, 'scripts'), { recursive: true })
    writeFileSync(join(pkg, 'SKILL.md'), '---\nname: calc\ndescription: fixture\n---\nbody\n')
    writeFileSync(join(pkg, 'runtime.yaml'), 'version: 1\npython:\n  requirements: requirements.txt\n  entries:\n    run:\n      script: scripts/run.py\n')
    writeFileSync(join(pkg, 'requirements.txt'), 'six==1.17.0\n')
    writeFileSync(join(pkg, 'scripts/run.py'), 'print(1)\n')
    const original = readPackage(pkg), store = new SkillVersionStore()
    const packageRef = store.put(original.files)
    const skill = { ...original.definition, source: 'rivet', skillDir: join(root, 'not-materialized'), packageRef }
    const registry = { get: () => skill, list: () => [skill] } as any
    const resolved = resolveRuntimeSkill(registry, 'calc', { userExplicit: true })
    assert.ok(resolved.ok)
    const context = { cwd: root, origin: 'user' as const }
    const plan = await buildRuntimeExecutionPlan(resolved.resolved, { action: 'prepare' }, context)
    writeFileSync(join(pkg, 'requirements.txt'), 'six==9.9.9\n')
    mkdirSync(skill.skillDir)
    writeFileSync(join(skill.skillDir, 'requirements.txt'), 'six==8.8.8\n')
    let installed = ''
    const exec = async (o: any) => {
      if (o.argv.includes('-r')) {
        installed = readFileSync(o.argv[o.argv.indexOf('-r') + 1], 'utf8')
        writeFileSync(o.argv[o.argv.indexOf('--report') + 1], JSON.stringify({ install: [] }))
      }
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: o.argv.includes('--help') ? '--report' : `Python ${plan.interpreter.version}`, stderr: '', durationMs: 1 }
    }
    const manager = new SkillEnvironmentManager({ home: join(root, 'home'), exec })
    const outcome = await prepareSkillRuntime(plan.resolved, { cwd: root, mirrors: { enabled: false } as any, plan, manager, exec })
    assert.equal(outcome.status, 'ready', outcome.result.message)
    assert.equal(installed, 'six==1.17.0\n')
    assert.equal(outcome.result.packageVersion, packageRef)
    assert.equal(original.definition.mode, undefined, 'freezing a plan must not freeze the live registry object')
    const live = { ...original.definition, source: 'rivet', skillDir: pkg }
    const liveResolved = resolveRuntimeSkill({ get: () => live, list: () => [live] } as any, 'calc', { userExplicit: true })
    assert.ok(liveResolved.ok)
    const livePlan = await buildRuntimeExecutionPlan(liveResolved.resolved, { action: 'prepare' }, context)
    writeFileSync(join(pkg, 'requirements.txt'), 'six==1.16.0\n')
    await assert.rejects(revalidateRuntimePlan(livePlan, context), /预览后发生变化/)
    assert.throws(() => { plan.preview.requirements!.normalized = 'changed' }, TypeError)
  } finally {
    if (previousTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = previousTrust
    rmSync(root, { recursive: true, force: true })
  }
})
