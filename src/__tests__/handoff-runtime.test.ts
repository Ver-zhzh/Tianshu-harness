import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { publishFactHandoff } from '../agent/fact-handoff.js'
import { selectHandoff } from '../agent/handoff-selection.js'
import { READ_FILE_TOOL } from '../tools/read-file.js'
import { DEFAULT_CONFIG } from '../config/default.js'
import { providerSchema } from '../config/schema.js'
import { buildManagedAgent } from '../server/serve-agent.js'
import { __resetToolPresetForTest } from '../tools/tool-preset.js'
import { handleSlashCommand, type SlashHandlerContext } from '../tui/slash-commands.js'

test('real read_file enforces selection and the production agent consumes the selected historical snapshot', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-wire-'))
  const keys = ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_CONFIG_PATH', 'RIVET_TOOL_PRESET', 'HANDOFF_FIXTURE_KEY']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.RIVET_HOME = cwd; process.env.RIVET_SESSION_DIR = join(cwd, 'sessions'); process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json'); process.env.RIVET_TOOL_PRESET = 'minimal'; __resetToolPresetForTest()
  const snapshot = publishFactHandoff(cwd, 'source', { goal: 'UNIQUE_SOURCE_GOAL', turnCount: 3 })
  const uri = `handoff://source/${snapshot.snapshotId}/goal`
  const params = { cwd, sessionId: 'target', toolUseId: 'read', input: { file_path: uri }, currentVerificationFingerprint: () => { throw Error('query cannot capture fingerprint') } }
  assert.ok((await READ_FILE_TOOL.execute(params)).isError)
  selectHandoff(cwd, 'target', 'source')
  assert.match((await READ_FILE_TOOL.execute(params)).content, /UNIQUE_SOURCE_GOAL/)
  assert.ok((await READ_FILE_TOOL.execute({ ...params, sessionId: 'other' })).isError)
  assert.ok((await READ_FILE_TOOL.execute({ ...params, cwd: join(cwd, 'other') })).isError)
  let toolResult = '', requests = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests++
    const result = body.messages.find((message: any) => message.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (result) toolResult = result.content
    const delta = result ? { content: 'Historical source read.' } : { tool_calls: [{ index: 0, id: 'selected-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: uri, offset: 1, limit: 20 }) } }] }
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = providerSchema.parse({ name: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, protocol: 'openai', thinking: 'disabled', apiKeyEnv: 'HANDOFF_FIXTURE_KEY', models: [{ id: 'fixture', contextWindow: 200000, maxTokens: 512 }, { id: 'next', contextWindow: 200000, maxTokens: 512 }] })
  const config = structuredClone(DEFAULT_CONFIG); config.agent.verificationSnapshot = 'off'; config.agent.maxTurns = 3
  config.provider = { default: 'fixture', providers: { fixture: provider } }; process.env.HANDOFF_FIXTURE_KEY = 'fixture'
  let agent: ReturnType<typeof buildManagedAgent> | undefined
  try {
    agent = buildManagedAgent({ config, provider, model: provider.models[0]!, apiKey: 'fixture', configured: true }, cwd, 'target', undefined, 'manual')
    await agent.run('读取已显式选择的交接目标，只作历史观察。', { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {}, onError(e: Error) { throw e }, onApprovalRequired: async () => false })
    assert.match(toolResult, /UNIQUE_SOURCE_GOAL/)
    assert.match(toolResult, /当前版本有效性未知/)
    assert.equal(requests, 2)
    assert.ok(agent.switchModel!('fixture:next'))
    assert.match((await READ_FILE_TOOL.execute({ ...params, input: { file_path: uri, limit: 22 } })).content, /UNIQUE_SOURCE_GOAL/)
  } finally { await agent?.shutdown?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; __resetToolPresetForTest(); rmSync(cwd, { recursive: true, force: true }) }
})

test('actual CLI creates and queries fact handoffs with no configured provider; TUI default never submits a model prompt', async () => {
  const root = resolve('.'), cwd = mkdtempSync(join(tmpdir(), 'handoff-cli-'))
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, RIVET_HOME: cwd, RIVET_SESSION_DIR: join(cwd, 'sessions'), RIVET_CONFIG_PATH: join(cwd, 'missing.json') }
  async function run(command: string) {
    const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, join(root, 'src/main.ts'), '-p', command, '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer)
    assert.equal(code, 0, stderr); return JSON.parse(stdout)
  }
  const prior = process.env.RIVET_SESSION_DIR
  try {
    const generated = await run('/handoff')
    assert.equal(generated.usage.input_tokens, 0)
    const read = await run(`/handoff read ${generated.sessionId}`)
    assert.match(read.text, new RegExp(generated.sessionId))
    assert.equal(read.usage.output_tokens, 0)
    process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
    let submitted = 0; const logs: string[] = []
    const context = { parts: ['/handoff'], currentSessionId: 'tui', agent: { cwd, isRunning: () => false, getTaskContract: () => ({ objective: 'TUI goal', scope: { mentionedFiles: [] }, constraints: [] }), session: { getTurnCount: () => 2 }, config: { getTodos: () => [] } }, pushStatic: (entry: any) => logs.push(entry.content), setIsStreaming() {}, submitToAgent: () => { submitted++ } } as unknown as SlashHandlerContext
    assert.equal(await handleSlashCommand(context), true)
    assert.equal(submitted, 0)
    assert.match(logs.join(), /零模型调用/)
    await handleSlashCommand({ ...context, parts: ['/handoff', 'read', generated.sessionId] })
    assert.equal(submitted, 1)
    await handleSlashCommand({ ...context, parts: ['/handoff', 'list'], agent: { ...context.agent, isRunning: () => true } as any, setIsStreaming: () => { throw Error('a read-only list must not alter an active run') } })
  } finally { if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(cwd, { recursive: true, force: true }) }
})
