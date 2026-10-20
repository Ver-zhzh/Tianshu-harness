import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPackage } from '../../skills/skill-package.js'
import { createRouter } from '../index.js'
import { buildSkillRuntimeRoutes } from '../skill-runtime-routes.js'
import { SkillManagement } from '../../skills/skill-management.js'

it('HTTP hard deny, preview binding, truthful outcomes and log retention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-http-closure-'))
  const previousHome = process.env.RIVET_HOME, previousTrust = process.env.RIVET_TRUST_PROJECT
  process.env.RIVET_HOME = join(root, 'home'); process.env.RIVET_TRUST_PROJECT = '1'
  const home = process.env.RIVET_HOME, cwd = join(root, 'project'), pkg = join(cwd, '.rivet', 'skills', 'calc')
  mkdirSync(home); mkdirSync(join(pkg, 'scripts'), { recursive: true })
  writeFileSync(join(pkg, 'SKILL.md'), '---\nname: calc\ndescription: fixture\n---\nbody\n')
  writeFileSync(join(pkg, 'runtime.yaml'), 'version: 1\npython:\n  entries:\n    run:\n      script: scripts/run.py\n')
  writeFileSync(join(pkg, 'scripts', 'run.py'), 'print(1)\n')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { permissions: { deny: [{ tool: 'skill_runtime' }] } } }))
  try {
    const management = new SkillManagement(home, join(root, 'external'))
    const skillId = management.list(cwd).skills.find(s => s.name === 'calc')!.skillId
    const router = createRouter(buildSkillRuntimeRoutes({ getSession: () => undefined } as any, 'fixture', { management }))
    const auth = { authorization: 'Bearer fixture' }
    const request = { skillId, cwd, action: 'run', entry: 'run', confirm: true }
    assert.equal((await router('POST', '/skill-runtime/operations', request, auth)).status, 403)
    writeFileSync(join(home, 'config.json'), '{}')
    assert.equal((await router('POST', '/skill-runtime/operations', request, auth)).status, 400)
    const preview = (await router('POST', '/skill-runtime/preview', { ...request }, auth)).body as any
    const created = await router('POST', '/skill-runtime/operations', { ...request, packageRef: preview.packageRef, previewDigest: preview.previewDigest }, auth)
    assert.equal(created.status, 200)
    const id = (created.body as any).operationId
    let op: any
    for (let n = 0; n < 100; n++) {
      op = (await router('GET', `/skill-runtime/operations/${id}`, undefined, auth)).body
      if (op.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal(op.status, 'failed')
    assert.equal(op.result.errorCode, 'environment_not_prepared')
    const ops = join(home, 'skill-runtime-ops'), activeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    writeFileSync(join(ops, activeId + '.json'), JSON.stringify({ id: activeId, status: 'running', createdAt: new Date().toISOString() }))
    writeFileSync(join(ops, activeId + '.log'), 'active log')
    await router('POST', '/skill-runtime/operations', {}, auth)
    assert.equal(existsSync(join(ops, activeId + '.log')), true)
    const log = await router('GET', `/skill-runtime/operations/${activeId}/log?cursor=0`, undefined, auth)
    assert.equal(log.status, 200)
    assert.equal((log.body as any).text, 'active log')
    const text = '中'.repeat(23000) + '🙂尾'
    writeFileSync(join(ops, activeId + '.log'), text)
    let cursor = 0, all = ''
    while (cursor < Buffer.byteLength(text)) {
      const chunk = (await router('GET', `/skill-runtime/operations/${activeId}/log?cursor=${cursor}`, undefined, auth)).body as any
      assert.ok(chunk.nextCursor > cursor)
      assert.ok(chunk.nextCursor - cursor <= 65536)
      assert.ok(!chunk.text.includes('\ufffd'))
      all += chunk.text; cursor = chunk.nextCursor
    }
    assert.equal(all, text)
    assert.equal((await router('GET', `/skill-runtime/operations/${activeId}/log?cursor=1`, undefined, auth)).status, 400)
    const expired = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    writeFileSync(join(ops, expired + '.json'), JSON.stringify({ id: expired, status: 'completed', finishedAt: new Date(Date.now() - 90_000_000).toISOString() }))
    writeFileSync(join(ops, expired + '.log'), 'expired')
    await router('POST', '/skill-runtime/operations', {}, auth)
    assert.equal(existsSync(join(ops, expired + '.log')), false)
    assert.equal(existsSync(join(ops, activeId + '.log')), true)
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = previousHome
    if (previousTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = previousTrust
    rmSync(root, { recursive: true, force: true })
  }
})

it('session HTTP enforces live Plan Mode, cwd, overlay and project trust; missing environments are not removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-session-closure-'))
  const previousHome = process.env.RIVET_HOME, previousTrust = process.env.RIVET_TRUST_PROJECT
  const home = join(root, 'home'), cwd = join(root, 'project'), pkg = join(cwd, '.rivet', 'skills', 'calc')
  process.env.RIVET_HOME = home; process.env.RIVET_TRUST_PROJECT = '1'
  mkdirSync(home); mkdirSync(join(pkg, 'scripts'), { recursive: true })
  writeFileSync(join(home, 'config.json'), '{}')
  writeFileSync(join(pkg, 'SKILL.md'), '---\nname: calc\ndescription: fixture\n---\nbody\n')
  writeFileSync(join(pkg, 'runtime.yaml'), 'version: 1\npython:\n  entries:\n    run:\n      script: scripts/run.py\n')
  writeFileSync(join(pkg, 'scripts/run.py'), 'print(1)\n')
  try {
    const skill = { ...readPackage(pkg).definition, source: 'rivet', skillDir: pkg }
    const record = { cwd, planMode: 'off' }
    const live = { planMode: 'planning', overlay: { allow: [], deny: [] as Array<{ tool: string }>, bashAllow: [], bashDeny: [] } }
    const router = createRouter(buildSkillRuntimeRoutes({ getSession: () => record, getAgentForSession: () => ({ getSkillSnapshot: () => [skill], getRuntimePolicyContext: () => live }) } as any, 'fixture'))
    const auth = { authorization: 'Bearer fixture' }, target = { sessionId: 'session', skillName: 'calc' }
    assert.equal((await router('POST', '/skill-runtime/preview', target, auth)).status, 200)
    assert.equal((await router('POST', '/skill-runtime/operations', { ...target, action: 'prepare', confirm: true }, auth)).status, 403)
    assert.equal((await router('POST', '/skill-runtime/remove-env', { ...target, confirm: true }, auth)).status, 403)
    assert.equal((await router('POST', '/skill-runtime/preview', { ...target, cwd: join(root, 'other') }, auth)).status, 400)
    live.planMode = 'off'; live.overlay.deny.push({ tool: 'skill_runtime' })
    assert.equal((await router('POST', '/skill-runtime/operations', { ...target, action: 'prepare', confirm: true }, auth)).status, 403)
    live.overlay.deny = []; process.env.RIVET_TRUST_PROJECT = '0'
    assert.equal((await router('POST', '/skill-runtime/preview', target, auth)).status, 403)
    process.env.RIVET_TRUST_PROJECT = '1'
    const preview = (await router('POST', '/skill-runtime/preview', { ...target, action: 'remove-env' }, auth)).body as any
    const result = await router('POST', '/skill-runtime/remove-env', { ...target, confirm: true, packageRef: preview.packageRef, previewDigest: preview.previewDigest, envKey: preview.envKey }, auth)
    assert.equal(result.status, 409)
    assert.equal((result.body as any).removed, false)
    writeFileSync(join(home, 'config.json'), JSON.stringify({ env: { pythonPath: join(root, 'missing-python') } }))
    const missing = await router('POST', '/skill-runtime/preview', target, auth)
    assert.equal(missing.status, 200)
    assert.equal((missing.body as any).diagnosis.interpreter.found, false)
    assert.equal((missing.body as any).installPreview, undefined)
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = previousHome
    if (previousTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = previousTrust
    rmSync(root, { recursive: true, force: true })
  }
})
