/**
 * Goal 上下文接力 —— session 层端到端（真 RuntimeSessionManager + 假 agent）。
 *
 * 契约：
 * - goal run 收尾且 tracker 以 GOAL_ROLLOVER_REASON 暂停 → 同会话自动发起交接 run；
 * - 交接 run 收尾且文档已归档 → 同 cwd 新会话：原目标原话 + 剩余迭代预算 +
 *   generation+1，kickoff prompt 带交接文档；旧会话 goal 取消；两边都有 goal_rollover 事件；
 * - 中止的 run → 不开新会话，goal 保持暂停；
 * - 交接文档没写出来 → 仍接力，但不注入陈旧文档（会话目录自动快照 / 旧项目文档）。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager, type ManagedAgent, type GoalHandles } from '../session-manager.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { GoalTracker, GOAL_ROLLOVER_REASON } from '../../agent/goal-tracker.js'
import { getSessionDir } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

class FakeAgent implements ManagedAgent {
  prompts: string[] = []
  tracker: GoalTracker | null = null
  private resolveRun?: () => void
  run(p: string, _cb: AgentCallbacks) {
    this.prompts.push(p)
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.finish() }
  finish() { const r = this.resolveRun; this.resolveRun = undefined; r?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  setGoalTracker(t: GoalTracker | null) { this.tracker = t }
  getGoalTracker() { return this.tracker }
}

let home: string
let workDir: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rivet-rollover-home-'))
  workDir = mkdtempSync(join(tmpdir(), 'rivet-rollover-work-'))
  process.env.RIVET_SESSION_DIR = join(home, 'sessions')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
  delete process.env.RIVET_SESSION_DIR
})

function setup() {
  const agents = new Map<string, FakeAgent>()
  const handles = new Map<string, GoalHandles>()
  const manager = new RuntimeSessionManager({
    // 与 serve-agent 一致：goal handles 只在 agent 构建时登记——没建 agent 的会话 setGoal 返回 null。
    createAgent: (_cwd, sessionId) => {
      const a = new FakeAgent()
      agents.set(sessionId!, a)
      handles.set(sessionId!, { goalTrackerRef: { current: null }, sessionDir: join(home, 'goals') } as GoalHandles)
      return a
    },
    defaultCwd: workDir,
    resolveGoalHandles: (sid) => handles.get(sid),
  })
  const agentOf = (id: string) => agents.get(id)!
  return { manager, handles, agentOf }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

async function startGoal(manager: RuntimeSessionManager, handles: Map<string, GoalHandles>, agentOf: (id: string) => FakeAgent) {
  const s = manager.createSession({ cwd: workDir, title: '夜间重构' })
  assert.equal(await manager.ensureSessionAgent(s.id), true)
  await manager.setGoal(s.id, {
    goal: '把 utils 全部迁移到新 API', maxIterations: 12, contextWindow: 100_000,
    rollover: { ratio: 0.5, maxSessions: 3, generation: 1 },
  })
  assert.equal(manager.run(s.id, 'kickoff'), true)
  await tick()
  const agent = agentOf(s.id)
  const tracker = handles.get(s.id)!.goalTrackerRef.current!
  return { s, agent, tracker }
}

test('完整接力：交接 run → 新会话带原目标 + 交接文档继续，旧 goal 结束', async () => {
  const { manager, handles, agentOf } = setup()
  const { s, agent, tracker } = await startGoal(manager, handles, agentOf)
  tracker.advanceIteration(); tracker.advanceIteration()
  tracker.pause(GOAL_ROLLOVER_REASON, 'runtime') // 等价于 continuation 判定到阈值
  agent.finish()
  await tick()

  const handoffPath = join(workDir, '.rivet', 'HANDOFF.md')
  assert.equal(agent.prompts.length, 2, '应自动发起交接 run')
  assert.ok(agent.prompts[1]!.includes(handoffPath))
  assert.match(agent.prompts[1]!, /自动接力/)

  mkdirSync(join(workDir, '.rivet'), { recursive: true })
  writeFileSync(handoffPath, '## 任务目标\n迁移 utils\n## 已完成\nstring.ts 已迁移\n')
  agent.finish()
  await tick(120)

  const sessions = manager.listSessions()
  assert.equal(sessions.length, 2, '应开出新会话')
  const next = sessions.find((r) => r.id !== s.id)!
  assert.equal(next.cwd, s.cwd)
  assert.match(next.title ?? '', /夜间重构 · 接力 2\/3/)

  const goal = manager.getGoalState(next.id)!
  assert.equal(goal.goal, '把 utils 全部迁移到新 API', '原目标原话')
  assert.equal(goal.status, 'active')
  assert.equal(goal.maxIterations, 10, '剩余迭代预算 12-2')
  assert.deepEqual(goal.rollover, { ratio: 0.5, maxSessions: 3, generation: 2 })

  const kickoff = agentOf(next.id).prompts[0]!
  assert.match(kickoff, /^\[GOAL MODE\] 把 utils 全部迁移到新 API/)
  assert.match(kickoff, /\[GOAL ROLLOVER\] 这是同一目标的第 2\/3 个会话/)
  assert.match(kickoff, /string\.ts 已迁移/)

  assert.equal(manager.getGoalState(s.id), null, '旧会话 goal 已取消并解绑，防止两个会话同时追一个目标')
  const oldEvents = manager.getEvents(s.id)!.events.filter((e) => e.type === 'goal_rollover')
  assert.ok(oldEvents.some((e) => (e.data as { to?: string }).to === next.id))
  assert.ok(manager.getEvents(next.id)!.events.some((e) => e.type === 'goal_rollover'))
})

test('goal run 被中止：不发起交接，goal 保持暂停', async () => {
  const { manager, handles, agentOf } = setup()
  const { s, agent, tracker } = await startGoal(manager, handles, agentOf)
  tracker.pause(GOAL_ROLLOVER_REASON, 'runtime')
  manager.abort(s.id)
  await tick()
  assert.equal(agent.prompts.length, 1, '不得发起交接 run')
  assert.equal(manager.listSessions().length, 1)
  assert.equal(tracker.getStatus(), 'paused')
})

test('交接文档没写出来：仍接力，但绝不注入会话目录里的陈旧自动快照', async () => {
  const { manager, handles, agentOf } = setup()
  const { s, agent, tracker } = await startGoal(manager, handles, agentOf)
  // 会话目录里已有 session-persist 早先轮次写的自动快照（真实模型验证中读到过它）
  mkdirSync(getSessionDir(workDir), { recursive: true })
  writeFileSync(join(getSessionDir(workDir), `${s.id}.handoff.md`), '<session-handoff>STALE-SNAPSHOT</session-handoff>')
  // 项目内也有一份早于本次交接的旧文档
  mkdirSync(join(workDir, '.rivet'), { recursive: true })
  const old = join(workDir, '.rivet', 'HANDOFF.md')
  writeFileSync(old, 'OLD-PROJECT-DOC')
  utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  tracker.pause(GOAL_ROLLOVER_REASON, 'runtime')
  agent.finish()
  await tick()
  agent.finish() // 交接 run 收尾但模型没写文档
  await tick(120)
  const next = manager.listSessions().find((r) => r.id !== s.id)
  assert.ok(next, '无文档也要接力，不让夜间任务停摆')
  const kickoff = agentOf(next!.id).prompts[0]!
  assert.doesNotMatch(kickoff, /STALE-SNAPSHOT|OLD-PROJECT-DOC/)
  assert.match(kickoff, /没有留下交接文档/)
  const texts = manager.getEvents(s.id)!.events.filter((e) => e.type === 'goal_rollover').map((e) => String((e.data as { text: string }).text))
  assert.ok(texts.some((t) => t.includes('没写出交接文档')))
})

test('新会话首条消息不发空的基线 goal_state（不覆盖接力 goal）', async () => {
  const { manager, handles, agentOf } = setup()
  const { s, agent, tracker } = await startGoal(manager, handles, agentOf)
  tracker.pause(GOAL_ROLLOVER_REASON, 'runtime')
  agent.finish(); await tick()
  mkdirSync(join(workDir, '.rivet'), { recursive: true })
  writeFileSync(join(workDir, '.rivet', 'HANDOFF.md'), 'doc')
  agent.finish(); await tick(120)
  const next = manager.listSessions().find((r) => r.id !== s.id)!
  const states = manager.getEvents(next.id)!.events.filter((e) => e.type === 'goal_state').map((e) => (e.data as { goal: string }).goal)
  assert.ok(states.length > 0)
  assert.ok(states.every((g) => g === '把 utils 全部迁移到新 API'), `不应出现空 goal：${JSON.stringify(states)}`)
})

test('POST /sessions/:id/goal：rollover 参数经规范化透传，缺省不启用', async () => {
  const { manager } = setup()
  const router = createRouter(buildSessionRoutes(manager, 'tok'))
  const auth = { authorization: 'Bearer tok' }
  const a = manager.createSession({ cwd: workDir })
  await manager.ensureSessionAgent(a.id)
  const on = await router('POST', `/sessions/${a.id}/goal`, { goal: 'g', contextWindow: 100_000, rollover: { ratio: 0.99, maxSessions: 4 } }, auth)
  assert.equal(on.status, 200)
  assert.deepEqual((on.body as { rollover?: unknown }).rollover, { ratio: 0.9, maxSessions: 4, generation: 1 })
  const b = manager.createSession({ cwd: workDir })
  await manager.ensureSessionAgent(b.id)
  const off = await router('POST', `/sessions/${b.id}/goal`, { goal: 'g', contextWindow: 100_000 }, auth)
  assert.equal((off.body as { rollover?: unknown }).rollover, undefined)
})

test('普通暂停（非接力原因）不触发任何接力', async () => {
  const { manager, handles, agentOf } = setup()
  const { agent, tracker } = await startGoal(manager, handles, agentOf)
  tracker.pause('user', 'user')
  agent.finish()
  await tick()
  assert.equal(agent.prompts.length, 1)
  assert.equal(manager.listSessions().length, 1)
})
