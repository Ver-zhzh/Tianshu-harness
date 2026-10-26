/**
 * /new 命令（new-session.ts）——handler 层的确定性断言。
 *
 * 覆盖三条分支：busy 守卫拒绝 / 创建失败透传 / 成功的顺序契约（flush → 切会话
 * → 清队列 → 清屏 → 回音）。新会话创建本身由 fresh-session.test.ts 覆盖；
 * 这里注入 fake startFresh，避开 AgentLoop 整体重建这条重路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerNewSessionCommand } from '../new-session.js'
import type { TuiApp } from '../engine/app.js'
import type { BootstrapContext } from '../../bootstrap.js'
import type { SlashCommand, SlashCommandContext } from '../slash-command-registry.js'
import type { StartFreshSessionResult } from '../../agent/fresh-session.js'

function makeHarness(opts: {
  busy?: boolean
  startFresh?: () => StartFreshSessionResult
} = {}) {
  const lines: string[] = []
  const registered: SlashCommand[] = []
  let clears = 0
  let highWater = 0
  let flushed = 0

  const app = {
    busy: opts.busy ?? false,
    queueLane: ['攒着的旧会话消息'] as string[],
    commitStatic: (text: string) => { lines.push(text) },
    clearScreen: () => { clears++ },
    setStreamingState: () => {},
    resetLiveHighWater: () => { highWater++ },
    setSidePanelOpen: () => {},
    registerSlashCommand: (cmd: SlashCommand) => { registered.push(cmd) },
  } as unknown as TuiApp

  const ctx = {
    cwd: '/proj',
    sessionId: 'old-session',
    persist: { flushSessionBuffer: async () => { flushed++ }, loadMetadata: () => undefined },
    config: { agent: {} },
    agent: { setGoalTracker: () => {} },
    refs: { goalTrackerRef: { current: null } },
  } as unknown as BootstrapContext

  registerNewSessionCommand(app, ctx, {
    startFresh: opts.startFresh ?? (() => ({
      ok: true,
      sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
      previousSessionId: '99999999-1111-2222-3333-444444444444',
    })),
  })

  const cmd = registered.find(c => c.name === '/new')
  assert.ok(cmd, '/new 必须注册到 app')

  return {
    app,
    lines,
    run: () => cmd.handler({ app, input: '/new', trimmed: '/new' } as SlashCommandContext),
    get clears() { return clears },
    get highWater() { return highWater },
    get flushed() { return flushed },
  }
}

test('/new：busy 时拒绝，且不触碰旧会话写缓冲与屏幕', async () => {
  const h = makeHarness({ busy: true })
  assert.equal(await h.run(), true, '命令必须被消费——不得穿透成普通消息发给模型')

  const out = h.lines.join('\n')
  assert.match(out, /开新会话失败/)
  assert.match(out, /agent 正在运行/)
  assert.equal(h.flushed, 0, 'busy 拒绝发生在 flush 之前：不该动旧会话的写缓冲')
  assert.equal(h.clears, 0, '拒绝时不清屏')
  assert.equal(h.app.queueLane.length, 1, '拒绝时不动队列 lane')
})

test('/new：成功路径的顺序契约 —— flush → 切会话 → 清队列 → 清屏 → 回音', async () => {
  const h = makeHarness()
  assert.equal(await h.run(), true)

  assert.equal(h.flushed, 1, '切换前必须 flush：切换整体替换 persist 实例，仍排队的末几条消息会随之丢失')
  assert.equal(h.highWater, 1, '会话边界要重置定高视口高水位——旧会话的峰值空白不带进新会话')
  assert.equal(h.clears, 1, '清屏是「上下文已重置」的视觉断点')
  assert.equal(h.app.queueLane.length, 0, '队列 lane 属于旧上下文，不该被带进新会话')

  const out = h.lines.join('\n')
  assert.ok(out.includes('abcdef12'), `应回音新会话短码: ${out}`)
  assert.ok(out.includes('/resume 99999999'), `应指引回访旧会话: ${out}`)
  assert.ok(out.includes('上下文已重置'), `应说明重置语义: ${out}`)
})

test('/new：创建失败如实回音，不动屏幕与队列', async () => {
  const h = makeHarness({
    startFresh: () => ({ ok: false, error: '切换新会话失败（旧会话文件未受影响）：boom' }),
  })
  assert.equal(await h.run(), true)

  const out = h.lines.join('\n')
  assert.match(out, /开新会话失败/)
  assert.match(out, /boom/, '失败原因必须透传，不吞异常')
  assert.equal(h.clears, 0, '失败时不清屏——屏幕该保留原样让用户看到失败')
  assert.equal(h.app.queueLane.length, 1, '失败时不动旧会话的队列 lane')
})
