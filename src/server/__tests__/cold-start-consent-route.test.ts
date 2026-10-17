/**
 * POST /sessions/:id/cold-start-consent — resume 证据门的用户显式同意通道。
 *
 * 场景：旧版/损坏的冻结快照让会话被证据门砖死（desktop 错误卡「以当前配置
 * 继续」按钮调此路由）。写入 meta.coldStartConsentAt 后，下次构建 agent 时
 * readFrozenSnapshot 返回 undefined（全新装配，首请求开新缓存代次）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager } from '../session-manager.js'
import { SessionPersist } from '../../agent/session-persist.js'

const TOKEN = 'cold-start-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'rivet-cold-start-route-'))
  process.env.RIVET_SESSION_DIR = join(workspace, 'sessions')
  const manager = new RuntimeSessionManager({ createAgent: () => { throw new Error('no agent needed') }, defaultCwd: workspace })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, router, workspace }
}

describe('POST /sessions/:id/cold-start-consent', () => {
  it('写入 meta 同意标记，证据门随后绕行', async () => {
    const { manager, router, workspace } = setup()
    try {
      const s = manager.createSession({})
      const res = await router('POST', `/sessions/${s.id}/cold-start-consent`, {}, AUTH)
      assert.equal(res.status, 200)
      const persist = new SessionPersist(s.id, workspace)
      assert.equal(persist.hasColdStartConsent(), true, 'meta.coldStartConsentAt 必须已落盘')
    } finally {
      delete process.env.RIVET_SESSION_DIR
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('未知会话 404；无 token 401', async () => {
    const { router, workspace } = setup()
    try {
      const missing = await router('POST', '/sessions/nonexistent/cold-start-consent', {}, AUTH)
      assert.equal(missing.status, 404)
      const unauth = await router('POST', '/sessions/whatever/cold-start-consent', {}, {})
      assert.equal(unauth.status, 401)
    } finally {
      delete process.env.RIVET_SESSION_DIR
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
