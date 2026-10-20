import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { ContentBlock } from '../../api/types.js'

// Establish isolation before importing anything that can persist sessions.
const home = mkdtempSync(join(tmpdir(), 'rivet-domain-boundary-'))
const saved = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
process.env.RIVET_HOME = home
process.env.RIVET_SESSION_DIR = join(home, 'sessions')
writeFileSync(join(home, 'config.json'), '{}')
const cwd = join(home, 'consumer-project')
mkdirSync(cwd)
const { AgentLoop } = await import('../loop.js')
const { SessionContext } = await import('../context.js')
const { PromptEngine } = await import('../../prompt/engine.js')
const { ToolRegistry } = await import('../../tools/registry.js')
const { EDIT_FILE_TOOL } = await import('../../tools/edit.js')
const { READ_FILE_TOOL } = await import('../../tools/read-file.js')
const { runWorkerSession } = await import('../worker-session.js')
const { createReadOnlyWorkOrder, createWriteWorkOrder } = await import('../work-order.js')
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

function scriptedClient(turns: ContentBlock[][], requests: OaiChatRequest[]): StreamClient {
  let index = 0
  return { stream: async (request: OaiChatRequest, cb: StreamCallbacks) => {
    requests.push(request)
    const blocks = turns[Math.min(index++, turns.length - 1)]!
    for (const block of blocks) {
      if (block.type === 'text') cb.onTextDelta(block.text)
      cb.onContentBlock(block)
    }
    cb.onStopReason(blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', { input_tokens: 100, output_tokens: 20 })
  } } as StreamClient
}

function engine(registry: InstanceType<typeof ToolRegistry>, subagent = false) {
  return new PromptEngine({ model: 'test-model', maxTokens: 4096,
    staticCtx: { tools: registry.getDefinitions(), audience: subagent ? 'subagent' : undefined }, volatileCtx: { cwd } })
}

it('main with real write tool rejects an edit in Ask mode and delivers domain rules to the client', async () => {
  const file = join(cwd, 'source.rs')
  writeFileSync(file, 'before\n')
  const registry = new ToolRegistry()
  registry.register(EDIT_FILE_TOOL)
  registry.register(READ_FILE_TOOL)
  const requests: OaiChatRequest[] = []
  const results: Array<{ name: string; content: string; error: boolean }> = []
  const client = scriptedClient([
    [{ type: 'tool_use', id: 'read-first', name: 'read_file', input: { file_path: 'source.rs' } }],
    [{ type: 'tool_use', id: 'denied-edit', name: 'edit_file', input: { file_path: 'source.rs', old_string: 'before', new_string: 'after' } }],
    [{ type: 'text', text: 'Review only; the edit was denied.' }],
  ], requests)
  const agent = new AgentLoop({ client, promptEngine: engine(registry), toolRegistry: registry,
    maxTurns: 4, contextWindow: 1_000_000, compact: { enabled: false, model: 'test-model' },
    defaultDomain: 'qisha', approvalMode: 'dangerously-skip-permissions',
    sessionId: 'domain-ask-boundary',
  }, new SessionContext(), cwd)
  agent.enterAskMode()
  await agent.run('Review source.rs. Do not edit files.', {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onTurnComplete() {}, onAbort() {},
    onError(error: Error) { throw error }, onApprovalRequired: async () => true,
    onToolResult(_id, name, content, error) { results.push({ name, content, error: error ?? false }) },
  })
  assert.ok(requests.length >= 3, 'the real loop must read, receive and reject the write attempt')
  assert.ok(JSON.stringify(requests[0]!.messages).includes('<domain-task-boundary>'))
  assert.ok(requests[0]!.tools?.some(t => t.function.name === 'edit_file'), 'write tool remains available to exercise the actual gate')
  assert.ok(results.some(r => r.name === 'edit_file' && r.error && r.content.includes('Ask Mode is active')), JSON.stringify(results))
  assert.equal(readFileSync(file, 'utf8'), 'before\n')
})

for (const writable of [false, true]) it(`actual ${writable ? 'patcher' : 'reviewer'} worker consumes shared rules and its own contract`, async () => {
  const input = { id: `boundary-${writable ? 'patch' : 'review'}`, parentTurnId: 'parent',
    objective: writable ? 'Implement the CSV parser fix.' : 'Review the SQL migration without editing.',
    scope: { files: [writable ? 'parser.py' : 'migration.sql'] },
    constraints: ['Keep the public interface unchanged.'], authority: 'qisha',
  }
  const order = writable
    ? createWriteWorkOrder({ ...input, kind: 'patch_proposal', profile: 'patcher' })
    : createReadOnlyWorkOrder({ ...input, kind: 'review', profile: 'reviewer' })
  const requests: OaiChatRequest[] = []
  const registry = new ToolRegistry()
  const report = JSON.stringify({ workOrderId: order.id, status: 'blocked',
    summary: 'The fixture deliberately provides no execution tools. No changes or verification were performed.',
    findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped' })
  await runWorkerSession({ order, client: scriptedClient([[{ type: 'text', text: report }]], requests),
    promptEngine: engine(registry, true), toolRegistry: registry, cwd, maxTurns: 2,
    contextWindow: 1_000_000, compact: { enabled: false, model: 'test-model' }, finalizeReport: false })
  const wire = JSON.stringify(requests[0]?.messages)
  assert.ok(wire.includes('<domain-task-boundary>'), 'actual worker must receive the shared rule via volatile, not display-only suffix')
  assert.ok(wire.includes('以下提名与报告的交付标准仅适用于减法审查'))
  assert.ok(wire.includes(order.objective), 'domain must not substitute its default objective')
  assert.ok(wire.includes('Keep the public interface unchanged.'), 'work-order constraints must survive domain binding')
  assert.ok(wire.includes(writable ? '可写 Rivet worker' : '只读 Rivet worker'))
})
