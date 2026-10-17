/**
 * 任务 4/7：打断留痕（interrupt-marker）。
 *
 * 反证表（能打红错误实现的是哪条）：
 *  #A2「开关关 / watchdog 未走旧行为」→ A3/A4 断言撤回仍在
 *  #A5「partial 里的工具意图进了历史」→ 断言 tool_calls undefined（400 防护）
 *  #C1「接线后仍走旧 removeLastMessage」→ 断言历史 = [user, assistant partial, SR 标记]
 *      （未接线时 user 被撤回，msgs 为空数组 → 红）
 *  #C2「已持久化文本被重复追加」→ partial 计数必须恰为 1（turnTextPersisted 守卫）
 *  #C3「探针对标记尾误报 history-invariant」→ 第二轮 run 的 debug 输出不含该警告
 *
 * 时序纪律（继承 abort-settles-before-post-session.test.ts 的坑）：
 *  - C1 用「流挂住直到 abort」的 client —— abort 确定落在流阶段（catch AbortError 出口）。
 *  - C2 显式用 gate 等 onApprovalRequired 被调用，确保 abort 落在工具阶段；
 *    该路径有 TOOL_ABORT_DRAIN_MS=6000 的批量 drain 窗口，本用例不断言时长。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionContext } from '../context.js'
import { INTERRUPT_MARKER_TEXT, endsWithInterruptMarker, recordInterruption } from '../interrupt-marker.js'
import { isInterruptMarkerEnabled } from '../../config/interrupt-marker-config.js'
import { stripInjectedSuffix } from '../../server/rewind-anchors.js'
import { AgentLoop } from '../loop.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import { OpenAIClient } from '../../api/openai-client.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { Tool, ToolResult } from '../../tools/types.js'

/** 把 SessionContext 适配成 InterruptionDeps（与 loop-factory 的 deps 同形，opts 必须透传）。 */
const ctxDeps = (ctx: SessionContext) => ({
  removeLastMessage: () => ctx.removeLastMessage(),
  addAssistantBlocks: (b: Parameters<SessionContext['addAssistantBlocks']>[0]) => ctx.addAssistantBlocks(b),
  appendSystemReminder: (t: string, c?: 'user' | 'functional' | 'discipline', opts?: { mergeTail?: boolean }) => ctx.appendSystemReminder(t, c, opts),
})
const base = { assistantResponded: false, userMessageConsumed: false, markerEnabled: true }

test('A1 用户打断 + 有 partial：保留 user、追加 assistant partial、再追加 SR 标记；返回 true', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('改 A')
  const responded = recordInterruption(ctxDeps(ctx), { ...base, partialText: '好的，我先看 A 文件…' })
  const msgs = ctx.getMessages()
  assert.equal(responded, true)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(msgs[0]!.content, '改 A')
  assert.equal(msgs[1]!.content, '好的，我先看 A 文件…')
  assert.match(String(msgs[2]!.content), /<system-reminder>[\s\S]*\[interrupted\]/)
})

test('A2 用户打断 + 无 partial：不撤回或改写 user；标记独立追加', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('改 A')
  const responded = recordInterruption(ctxDeps(ctx), { ...base, partialText: '' })
  const msgs = ctx.getMessages()
  assert.equal(responded, false)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.content, '改 A')
  assert.equal(stripInjectedSuffix(msgs[0]!.content as string), '改 A')
  assert.equal(endsWithInterruptMarker(msgs[1]!.content as string), true)
})

test('A3 watchdog 中止：旧行为——无回复撤回 user，不加标记', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('改 A')
  recordInterruption(ctxDeps(ctx), { ...base, partialText: '半句', abortTag: 'watchdog' })
  assert.equal(ctx.getMessages().length, 0)
})

test('A4 开关关：旧行为；已有回复时不撤回', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('改 A'); ctx.addAssistantBlocks([{ type: 'text', text: '已答' }])
  recordInterruption(ctxDeps(ctx), { ...base, partialText: '半句', assistantResponded: true, markerEnabled: false })
  assert.deepEqual(ctx.getMessages().map((m) => m.role), ['user', 'assistant'], '有回复 → 不撤回、不留痕')
})

test('A5 只追加 text，绝不追加 tool_use（partial 里的工具意图不得进历史）', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('改 A')
  recordInterruption(ctxDeps(ctx), { ...base, partialText: '我来调用工具' })
  const assistant = ctx.getMessages()[1] as { tool_calls?: unknown }
  assert.equal(assistant.tool_calls, undefined)
})

test('A6 打断不依赖压缩状态：标记独立成条，引擎下一轮前缀逐字节稳定', () => {
  const ctx = new SessionContext(); ctx.addUserMessage('这是k')
  const engine = new PromptEngine({
    model: 'deepseek-v4-flash', maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: TEST_CWD, gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts', rivetMd: '# Test Project' },
  })
  // 打断前：尾消息带着 appendix 上过 wire（2026-10-16 现场：revit-4213e2/2026101609914b2d8192，
  // 标记合并改写已发送消息 → 锚点失配 → fallback 丢 appendix → 守卫拒发 → 会话砖死）
  const sentBytes = JSON.stringify(engine.buildOaiRequest(ctx.getMessages()).messages.find(m => m.role === 'user'))
  recordInterruption(ctxDeps(ctx), { ...base, partialText: '' })
  const msgs = ctx.getMessages()
  assert.equal(msgs.length, 2, '标记必须独立成条（纯追加），不得合并进已发送消息')
  assert.equal(msgs[0]!.content, '这是k')
  assert.match(String(msgs[1]!.content), /<system-reminder>[\s\S]*\[interrupted\]/)
  // 打断后再发一条：历史消息的 wire 渲染字节必须与打断前逐字节一致（前缀零破损）
  ctx.addUserMessage('这是kimi的问题吗')
  const rendered = engine.buildOaiRequest(ctx.getMessages()).messages.filter(m => m.role === 'user')
  assert.equal(JSON.stringify(rendered[0]), sentBytes)
})

test('B isInterruptMarkerEnabled：config false 优先；env 0/false/off/no 关；缺省开', () => {
  const saved = process.env.RIVET_INTERRUPT_MARKER
  try {
    delete process.env.RIVET_INTERRUPT_MARKER
    assert.equal(isInterruptMarkerEnabled(), true)
    assert.equal(isInterruptMarkerEnabled(false), false)
    for (const v of ['0', 'false', 'off', 'no']) { process.env.RIVET_INTERRUPT_MARKER = v; assert.equal(isInterruptMarkerEnabled(), false) }
    process.env.RIVET_INTERRUPT_MARKER = '1'; assert.equal(isInterruptMarkerEnabled(), true)
  } finally {
    if (saved === undefined) delete process.env.RIVET_INTERRUPT_MARKER; else process.env.RIVET_INTERRUPT_MARKER = saved
  }
})

// ── C. AgentLoop 端到端 ──────────────────────────────────────────────
// 骨架照 src/agent/__tests__/abort-settles-before-post-session.test.ts（makeAgent/cbs）。

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-interrupt-marker-'))

const APPROVAL_TOOL: Tool = {
  definition: {
    name: 'needs_approval',
    description: 'requires approval',
    input_schema: { type: 'object', properties: {} },
  },
  execute: async (): Promise<ToolResult> => ({ content: 'done' }),
  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(APPROVAL_TOOL)
  return new AgentLoop({
    client,
    promptEngine: new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [APPROVAL_TOOL.definition] },
      volatileCtx: { cwd: TEST_CWD },
    }),
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, session, TEST_CWD)
}

type Cbs = Parameters<AgentLoop['run']>[1]
const cbs = (over: Partial<Cbs> = {}): Cbs => ({
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onTurnComplete: () => {},
  onError: () => {},
  onAbort: () => {},
  onApprovalRequired: async () => true,
  ...over,
}) as Cbs

/** 流挂住直到 abort —— 配 `await streamGate` 使用，abort 确定落在流阶段（catch AbortError 出口）。
 *  不用 gate 的话 sleep(80) 可能不够走完初始化，abort 会落在 turn 首出口（留痕生效但 partialText=''，
 *  C1 断言的角色序列就变成 ['user']）——这是实测过的 flaky 来源。 */
function streamThenHangUntilAbort(onStreamStart: () => void): StreamClient {
  return {
    stream: (_r: unknown, cb: StreamCallbacks, signal?: AbortSignal) => new Promise<void>((_, reject) => {
      onStreamStart()
      cb.onTextDelta('partial…')
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  } as unknown as StreamClient
}

/** 先发文本 delta + tool_use 再挂在审批上：abort 落在工具阶段（文本已随 blocks 入历史）。 */
function hangingApprovalClient(): StreamClient {
  return {
    stream: async (_r: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('partial…')
      cb.onContentBlock({ type: 'tool_use', id: 't1', name: 'needs_approval', input: {} } as never)
      cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
    },
  } as unknown as StreamClient
}

test('C1 流中 abort：历史 = [user 原文, assistant partial, user SR 标记]', async () => {
  let streamHit: (() => void) | null = null
  const streamGate = new Promise<void>((r) => { streamHit = r })
  const agent = makeAgent(streamThenHangUntilAbort(() => streamHit?.()))
  const p = agent.run('改 A', cbs())
  await streamGate   // 确定性等到流阶段（abort 不落在 turn 首出口）
  agent.abort()
  await p
  const msgs = agent.session.getMessages()
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(msgs[1]!.content, 'partial…')
  assert.equal(String(msgs[2]!.content).includes(INTERRUPT_MARKER_TEXT), true)
})

test('C4 HTTP 已发送但无文字时打断：原消息不变，下一请求保持原 wire 前缀和代次', { timeout: 20_000 }, async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<{ messages: unknown[] }> = []
  let signalSent!: () => void
  const sent = new Promise<void>(resolve => { signalSent = resolve })
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) {
      signalSent()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  const agent = makeAgent(new OpenAIClient({
    providerName: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture',
    model: 'deepseek-v4-pro', maxTokens: 1024, maxRetries: 0,
  }))
  try {
    const running = agent.run('first synthetic request', cbs())
    await sent
    const published = structuredClone(agent.session.getMessages())
    const generation = agent.config.client.getMainPrefixProof!()!.cacheGenerationId
    agent.abort()
    await running
    const after = agent.session.getMessages()
    assert.deepEqual(after.slice(0, published.length), published, '实际发送状态不能用压缩消费标志代替')
    assert.equal(after.length, published.length + 1)
    const errors: Error[] = []
    await agent.run('second synthetic request', cbs({ onError: error => { errors.push(error) } }))
    assert.deepEqual(errors, [])
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1]!.messages.slice(0, bodies[0]!.messages.length), bodies[0]!.messages)
    assert.equal(agent.config.client.getMainPrefixProof!()!.cacheGenerationId, generation)
  } finally {
    agent.abort()
    globalThis.fetch = originalFetch
  }
})

test('C2 工具阶段 abort（文本已随 tool_use 入历史）：不重复追加 partial，只补标记', async () => {
  const agent = makeAgent(hangingApprovalClient())
  let approvalHit: (() => void) | null = null
  const gate = new Promise<void>((r) => { approvalHit = r })
  const p = agent.run('改 A', cbs({ onApprovalRequired: () => { approvalHit?.(); return new Promise<boolean>(() => {}) } }))
  await gate   // 确定性到达工具阶段（abort 落在工具批，不在流阶段）
  agent.abort()
  await p
  const msgs = agent.session.getMessages()
  const partials = msgs.filter((m) => m.role === 'assistant' && m.content === 'partial…')
  assert.equal(partials.length, 1, 'turnTextPersisted 守卫：已持久化的文本不能再作为 partial 追加')
  assert.equal(String(msgs[msgs.length - 1]!.content).includes(INTERRUPT_MARKER_TEXT), true, '尾部是标记')
})

test('C3 打断后再 run 一轮：不撤回上一条、history-invariant 探针不对标记尾误报', async () => {
  let phase: 'hang' | 'normal' = 'hang'
  let streamHit: (() => void) | null = null
  const streamGate = new Promise<void>((r) => { streamHit = r })
  const client = {
    stream: (_r: unknown, cb: StreamCallbacks, signal?: AbortSignal) => {
      if (phase === 'hang') {
        streamHit?.()
        return new Promise<void>((_, reject) => {
          cb.onTextDelta('partial…')
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      }
      cb.onContentBlock({ type: 'text', text: 'ok' } as never)
      cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
      return Promise.resolve()
    },
  } as unknown as StreamClient
  const agent = makeAgent(client)
  const p1 = agent.run('改 A', cbs())
  await streamGate
  agent.abort()
  await p1

  phase = 'normal'
  const savedDebug = process.env.RIVET_DEBUG
  const origWrite = console.warn                       // debugLog 走 console.warn（utils/debug.ts:21）
  let captured = ''
  process.env.RIVET_DEBUG = '1'
  console.warn = (...args: unknown[]) => { captured += args.map(String).join(' ') + '\n' }
  try {
    await agent.run('不对，改 B', cbs())
  } finally {
    console.warn = origWrite
    if (savedDebug === undefined) delete process.env.RIVET_DEBUG; else process.env.RIVET_DEBUG = savedDebug
  }
  const msgs = agent.session.getMessages()
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'assistant'])
  assert.equal(msgs[0]!.content, '改 A', '被打断的用户消息不再被撤回')
  assert.equal(msgs[3]!.content, '不对，改 B')
  assert.equal(captured.includes('[history-invariant]'), false, '标记尾不是「未答的 user 消息」')
})
