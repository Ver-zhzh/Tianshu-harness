import { after } from 'node:test'
const priorProjectTrust = process.env.RIVET_TRUST_PROJECT
process.env.RIVET_TRUST_PROJECT = '1'
after(() => { if (priorProjectTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = priorProjectTrust })
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSkillRuntimeRoutes } from '../skill-runtime-routes.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { detectPythonInterpreter } from '../../skills/runtime/interpreter.js'
import type { RuntimeSessionManager } from '../session-manager.js'

const AUTH = { authorization: 'Bearer rt-fixture' }
const RUNTIME_YAML = `version: 1
python:
  entries:
    echo:
      script: scripts/echo.py
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-runtime-routes-'))
  const cwd = join(root, 'project'), home = join(root, 'home'), external = join(root, 'external')
  mkdirSync(cwd, { recursive: true }); mkdirSync(home); mkdirSync(external)
  const skillDir = join(cwd, '.rivet', 'skills', 'calc')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: calc\ndescription: rt fixture\n---\nbody\n')
  writeFileSync(join(skillDir, 'runtime.yaml'), RUNTIME_YAML)
  writeFileSync(join(skillDir, 'scripts', 'echo.py'), 'import sys\nprint("ok:" + "|".join(sys.argv[1:]))\n')
  const management = new SkillManagement(home, external)
  // 库身份路径不需要真实会话——stub 掉会话面（会话路径的 fail-closed 另有断言）。
  const manager = { getAgentForSession: () => undefined, getSession: () => undefined } as unknown as RuntimeSessionManager
  const router = createRouter(buildSkillRuntimeRoutes(manager, 'rt-fixture', { management }))
  const skillId = management.list(cwd).skills.find(s => s.name === 'calc')!.skillId
  return { root, cwd, home, management, router, skillId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const hasPython = await detectPythonInterpreter().then(p => p.found)

async function pollOp(router: ReturnType<typeof createRouter>, id: string, timeoutMs = 90_000) {
  const start = Date.now()
  for (;;) {
    const res = await router('GET', `/skill-runtime/operations/${id}`, undefined, AUTH)
    const body = res.body as Record<string, unknown>
    if (body.status !== 'running') return body
    if (Date.now() - start > timeoutMs) throw new Error('operation did not settle in time')
    await new Promise(r => setTimeout(r, 200))
  }
}

describe('skill-runtime 路由 — 门与生命周期（issue #523）', () => {
  it('preview：库身份解析出声明 + 环境状态 + 命令形态', async () => {
    const f = fixture()
    try {
      const res = await f.router('POST', '/skill-runtime/preview', { skillId: f.skillId, cwd: f.cwd, entry: 'echo' }, AUTH)
      assert.equal(res.status, 200)
      const body = res.body as any
      assert.equal(body.skill.skillId, f.skillId)
      assert.ok(/^[a-f0-9]{64}$/.test(body.packageRef))
      assert.equal(body.diagnosis.status === 'not-prepared' || body.diagnosis.status === 'interpreter-missing', true)
      assert.equal(body.diagnosis.environment.status, 'not-prepared')
      assert.match(body.command.shape, /echo\.py/)
    } finally { f.cleanup() }
  })

  it('operations 门：无 confirm → 400；source 无 allowSourceBuild → 400；坏 entry → 400；坏目标 → 400', async () => {
    const f = fixture()
    try {
      const noConfirm = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'prepare' }, AUTH)
      assert.equal(noConfirm.status, 400)
      assert.match((noConfirm.body as any).error, /confirm/)

      const source = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'prepare', confirm: true, buildPolicy: 'source', ...await binding(f, 'prepare', { buildPolicy: 'source' }) }, AUTH)
      assert.equal(source.status, 400)
      assert.match((source.body as any).error, /allowSourceBuild/)

      const badEntry = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'run', confirm: true, entry: 'nope', ...await binding(f, 'run', { entry: 'echo' }) }, AUTH)
      assert.equal(badEntry.status, 400)
      assert.match((badEntry.body as any).error, /entry/)

      const badTarget = await f.router('POST', '/skill-runtime/operations', { action: 'prepare', confirm: true }, AUTH)
      assert.equal(badTarget.status, 400)
    } finally { f.cleanup() }
  })

  it('版本冲突 → 409；会话不存在 → 409 fail-closed（无审批通道）', async () => {
    const f = fixture()
    try {
      const stale = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'prepare', confirm: true, packageRef: 'a'.repeat(64), previewDigest: 'b'.repeat(64) }, AUTH)
      assert.equal(stale.status, 409)
      assert.match((stale.body as any).error, /重新 preview/)

      const noSession = await f.router('POST', '/skill-runtime/operations', { sessionId: 'sess-gone', skillName: 'calc', cwd: f.cwd, action: 'prepare', confirm: true }, AUTH)
      assert.equal(noSession.status, 409)
      assert.match((noSession.body as any).error, /fail-closed/)
    } finally { f.cleanup() }
  })

  it('未授权请求 → 401', async () => {
    const f = fixture()
    try {
      const res = await f.router('POST', '/skill-runtime/preview', { skillId: f.skillId, cwd: f.cwd }, { authorization: 'Bearer wrong' })
      assert.equal(res.status, 401)
    } finally { f.cleanup() }
  })

  it('真机生命周期：prepare op → ready → run op → 完成且输出可取', { timeout: 150_000 }, async () => {
    if (!hasPython) return
    const f = fixture()
    try {
      const preview = await f.router('POST', '/skill-runtime/preview', { skillId: f.skillId, cwd: f.cwd, entry: 'echo' }, AUTH)
      const packageRef = (preview.body as any).packageRef as string

      const prep = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'prepare', confirm: true, ...await binding(f, 'prepare') }, AUTH)
      assert.equal(prep.status, 200)
      const prepOp = await pollOp(f.router, (prep.body as any).operationId)
      assert.equal(prepOp.status, 'completed', JSON.stringify(prepOp.result))

      const run = await f.router('POST', '/skill-runtime/operations', { skillId: f.skillId, cwd: f.cwd, action: 'run', confirm: true, ...await binding(f, 'run', { entry: 'echo', args: ['a', 'b'] }), entry: 'echo', args: ['a', 'b'] }, AUTH)
      assert.equal(run.status, 200)
      const runOp = await pollOp(f.router, (run.body as any).operationId)
      assert.equal(runOp.status, 'completed', JSON.stringify(runOp.result))
      assert.match((runOp.result as any).stdout, /ok:a\|b/)
      assert.equal((runOp.result as any).packageVersion, packageRef)

      // 断线恢复查询：终态记录可读；取消一个不在运行的操作 → 409
      const cancel = await f.router('POST', `/skill-runtime/operations/${(run.body as any).operationId}/cancel`, {}, AUTH)
      assert.equal(cancel.status, 409)
    } finally { f.cleanup() }
  })
})

async function binding(f: ReturnType<typeof fixture>, action: string, extra: Record<string, unknown> = {}) {
  const response = await f.router('POST', '/skill-runtime/preview', { skillId: f.skillId, cwd: f.cwd, action, ...extra }, AUTH)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const preview = response.body as any
  return { packageRef: preview.packageRef, previewDigest: preview.previewDigest }
}
