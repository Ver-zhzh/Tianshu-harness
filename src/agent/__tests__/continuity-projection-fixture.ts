import { type TestContext } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import { PromptEngine } from '../../prompt/engine.js'
import { currentExecutionScope } from '../../api/execution-continuity.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { providerSchema } from '../../config/schema.js'
import { ToolRegistry } from '../../tools/registry.js'
import { WRITE_FILE_TOOL } from '../../tools/write-file.js'

export function continuityFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-projection-'))
  const previous = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
  process.env.RIVET_HOME = join(root, 'home'); process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  mkdirSync(process.env.RIVET_HOME); writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  const target = join(root, 'result.txt')
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  let toolResults = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const main = !!currentExecutionScope()?.beforeSend
    if (main) bodies.push(JSON.parse(String(init.body)))
    const first = main && bodies.length === 1
    const frame = { choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'call-1', type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: target, content: 'saved once' }) } }] }
      : { content: 'done' }, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  })
  const provider = providerSchema.parse({ name: 'fixture', protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', maxRetries: 0,
    models: [{ id: 'fixture', maxTokens: 4096, contextWindow: 1_000_000 }] })
  const registry = new ToolRegistry(); registry.register(WRITE_FILE_TOOL)
  const config = { model: 'fixture', maxTokens: 4096, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd: root, gitStatus: '' } }
  const engine = new PromptEngine(config)
  const client = createProviderClient(provider, resolveCapabilities('fixture'), { apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
  const persist = new SessionPersist('fixture', root)
  const agent = new AgentLoop({ client, promptEngine: engine, providerName: 'fixture', toolRegistry: registry, sessionPersist: persist,
    sessionId: 'fixture', headless: true, maxTurns: 3, contextWindow: 1_000_000, compact: { enabled: false, model: 'fixture' },
    fsWatcherEnabled: false, intentRetrievalRouter: { enabled: false }, agentReconnect: { enabled: false, maxAttempts: 0 } }, new SessionContext(), root)
  engine.setOnFrozenSnapshotChanged(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
  engine.setExecutionSnapshotCommit(snapshot => persist.commitFrozenSnapshot(snapshot))
  const errors: Error[] = []
  const callbacks = { onStopReason() {}, onContentBlock() {}, onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() { toolResults++; agent.updateSessionMemory('NEW_MEMORY_AFTER_WRITE') },
    onTurnComplete() {}, onError(e: Error) { errors.push(e) }, onAbort() {}, async onApprovalRequired() { return true } }
  t.after(async () => {
    await agent.cancelIdleCompaction(); await agent.drainPostSession(); await agent.drainPersistWrites(); await persist.drainFrozenSnapshots()
    await agent.telemetryWriter.flush(); await agent.frameRecorder.flush(); agent.stopFsWatcher(); agent.stopConfigWatcher()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  })
  return { provider, root, engine, client, agent, persist, config, target, callbacks, bodies, errors, toolResults: () => toolResults }
}
