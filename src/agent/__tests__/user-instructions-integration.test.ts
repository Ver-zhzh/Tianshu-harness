import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { configSchema } from '../../config/schema.js'
import { createUserInstructionsSnapshot, DISABLED_USER_INSTRUCTIONS, UserInstructionsError } from '../../prompt/user-instructions.js'
import { PromptEngine } from '../../prompt/engine.js'
import { proveRewindHistory } from '../../api/continuation-prefix.js'
import { buildModelCards } from '../../model/capability.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'
import { buildWorkerRuntime } from '../worker-runtime.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { runWorkerSession } from '../worker-session.js'
import { runWorkerSessionOop } from '../worker-process/parent.js'
import { createHeadlessCoordinator } from '../headless-coordinator.js'
import { runHeadless } from '../../headless.js'
import { SessionPersist, getSessionDir } from '../session-persist.js'

test('production worker assembly and real child preserve the published snapshot, reject damaged init, and inherit into nested dispatch', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'user-instructions-integration-'))
  const home = join(dir, 'home'); mkdirSync(join(home, 'instructions'), { recursive: true })
  const priorHome = process.env.RIVET_HOME, priorConfig = process.env.RIVET_CONFIG_PATH, priorSessions = process.env.RIVET_SESSION_DIR
  process.env.RIVET_HOME = home; process.env.RIVET_CONFIG_PATH = join(home, 'config.json'); process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  const calls: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    calls.push(body)
    const messagesText = body.messages.map((message: { content: unknown }) => String(message.content)).join('\n')
    const orderId = /工单 ID（WorkOrder ID）：([^\s]+)/.exec(messagesText)?.[1] ?? 'fixture'
    const report = JSON.stringify({ workOrderId: orderId, status: 'passed', summary: 'Completed inspection.', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: report }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    if (priorHome === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = priorHome
    if (priorConfig === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = priorConfig
    if (priorSessions === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = priorSessions
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const cfg = configSchema.parse({
    provider: { default: 'fixture', providers: { fixture: { name: 'fixture', apiKey: 'synthetic', baseUrl: origin + '/v1',
      endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, models: [{ id: 'fixture-model', contextWindow: 100000, maxTokens: 4096 }] } } },
    agent: { userInstructions: { enabled: true, path: join(home, 'instructions', 'rules.md') } },
  })
  writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(cfg))
  writeFileSync(cfg.agent.userInstructions!.path!, 'CHANGED_ON_DISK: this must never replace the published snapshot.')
  const source = createUserInstructionsSnapshot('PINNED_RULE: NEVER delete archives.')
  const main = new PromptEngine({ model: 'fixture-model', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: dir, userInstructions: source } })
  const first = main.buildOaiRequest([{ role: 'user', content: 'inspect', origin: 'human' }])
  await first.onExecutionSnapshot!({ messages: proveRewindHistory(first.messages) } as import('../../api/continuation-prefix.js').ContinuationPrefixProof)
  const provider = cfg.provider.providers.fixture!
  const deps = { config: cfg, cwd: dir, provider, apiKey: 'synthetic', auth: undefined, currentModelId: 'fixture-model', rootSessionId: 'instructions-root',
    listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [],
    getUserInstructions: () => main.getUserInstructionsForDispatch() }
  const runtime = (id: string) => buildWorkerRuntime(deps, createReadOnlyWorkOrder({ id, parentTurnId: id, profile: 'code_scout', kind: 'code_search', objective: `Inspect ${id}`, scope: {} }), buildModelCards(provider)[0]!, new ToolRegistry())
  const inProcess = runtime('rules-in-process')
  const local = await runWorkerSession(inProcess)
  assert.equal(local.result.status, 'passed', local.result.summary)
  const childEntry = { execArgs: ['--import', 'tsx'], script: fileURLToPath(new URL('../worker-process/child.ts', import.meta.url)) }
  const childConfig = runtime('rules-child')
  const child = await runWorkerSessionOop(childConfig, { getMemoryBlock: () => undefined, entryOverride: childEntry })
  assert.equal(child.result.status, 'passed', child.result.summary)
  assert.equal(calls.length, 2)
  for (const request of calls) {
    assert.ok(JSON.stringify(request.messages).includes('PINNED_RULE'))
    assert.ok(!JSON.stringify(request.messages).includes('CHANGED_ON_DISK'))
  }
  const nested = buildWorkerRuntime({ ...deps, getUserInstructions: () => inProcess.promptEngine.getUserInstructionsForDispatch() },
    createReadOnlyWorkOrder({ parentTurnId: 'nested', profile: 'code_scout', kind: 'code_search', objective: 'Inspect nested inheritance', scope: {} }), buildModelCards(provider)[0]!, new ToolRegistry())
  assert.deepEqual(nested.promptEngine.getUserInstructionsSnapshot(), source)
  const replacement = createUserInstructionsSnapshot('REPLACEMENT_RULE: preserve backups too.')
  const resumedConfig = buildWorkerRuntime({ ...deps, getUserInstructions: () => replacement }, childConfig.order, buildModelCards(provider)[0]!, new ToolRegistry())
  resumedConfig.order = { ...resumedConfig.order, objective: 'Inspect a new task boundary after updating user instructions.' }
  Object.assign(resumedConfig, { priorMessages: child.session.getMessages(), priorFrozenSnapshot: child.frozenSnapshot, priorPrefixProof: child.prefixProof })
  const resumed = await runWorkerSessionOop(resumedConfig, { getMemoryBlock: () => undefined, entryOverride: childEntry })
  assert.equal(resumed.result.status, 'passed', resumed.result.summary)
  assert.deepEqual(calls.at(-1)!.messages.slice(0, calls[1]!.messages.length), calls[1]!.messages)
  assert.ok(JSON.stringify(calls.at(-1)!.messages.at(-1)).includes('REPLACEMENT_RULE'))
  assert.equal(resumed.frozenSnapshot?.userInstructions?.state, 'active')
  assert.deepEqual(resumed.frozenSnapshot?.userInstructions, replacement.state === 'active' ? { version: 1, state: 'active', digest: replacement.digest } : undefined)
  const beforeInvalid = calls.length
  for (const damage of ['missing', 'digest', 'text', 'version'] as const) {
    const invalid = await runWorkerSessionOop(runtime(`rules-broken-init-${damage}`), {
      getMemoryBlock: () => undefined, entryOverride: childEntry,
      spawnOverride: (execArgs, script) => {
        const process = spawn(globalThis.process.execPath, [...execArgs, script, '--worker-child'], { stdio: ['pipe', 'pipe', 'pipe'], detached: globalThis.process.platform !== 'win32' })
        const stdin = process.stdin!, write = stdin.write
        stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          const message = JSON.parse(String(chunk))
          if (message.t === 'init') {
            if (damage === 'missing') delete message.payload.userInstructions
            else if (damage === 'version') message.payload.userInstructions.version = 2
            else if (damage === 'digest') message.payload.userInstructions.digest = '0'.repeat(64)
            else message.payload.userInstructions.text = 'CORRUPTED_TEXT'
          }
          return Reflect.apply(write, stdin, [JSON.stringify(message) + '\n', ...args])
        }) as typeof stdin.write
        return process
      },
    })
    assert.notEqual(invalid.result.status, 'passed')
    assert.ok(JSON.stringify(invalid).includes('user_instructions_payload_invalid'))
    assert.equal(calls.length, beforeInvalid, 'invalid init sends no model requests')
  }
  const coordinator = createHeadlessCoordinator({ toolRegistry: createDefaultToolRegistry([]), provider, providerName: 'fixture', currentModelId: 'fixture-model',
    config: cfg, apiKey: 'synthetic', cwd: dir, sessionId: 'rules-headless', getUserInstructions: () => main.getUserInstructionsForDispatch() })
  try {
    const run = await coordinator.delegate({ parentTurnId: 'rules-headless', profile: 'code_scout', kind: 'code_search', objective: 'Inspect headless user instructions inheritance in actual worker requests', scope: {} })
    assert.equal(run.results[0]?.status, 'passed', JSON.stringify(run))
    assert.ok(JSON.stringify(calls.at(-1)).includes('PINNED_RULE'))
  } finally { coordinator.shutdown() }
})

test('headless configuration failure uses the JSON error envelope and makes no run', async () => {
  const result = await runHeadless({ prompt: 'inspect', json: true, streamJson: false, createAgent: () => {
    throw new UserInstructionsError('user_instructions_source_invalid', 'synthetic invalid source')
  } })
  assert.equal(result.exitCode, 1)
  assert.equal(result.json?.success, false)
  assert.match(result.json?.error ?? '', /user_instructions_source_invalid/)
  assert.ok(!result.stdout.includes('stack'))
})

test('a missing production snapshot cannot silently disable user instructions', () => {
  assert.throws(() => buildWorkerRuntime({ getUserInstructions: () => undefined } as unknown as Parameters<typeof buildWorkerRuntime>[0],
    {} as Parameters<typeof buildWorkerRuntime>[1], {} as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry()), /payload_invalid/)
  assert.equal(DISABLED_USER_INSTRUCTIONS.state, 'disabled')
})

test('real headless CLI resumes frozen rules and publishes revocation at the next input', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'user-instructions-cli-'))
  const home = join(root, 'home'), project = join(root, 'project'), sessions = join(root, 'sessions')
  mkdirSync(join(home, 'instructions'), { recursive: true }); mkdirSync(project)
  const file = join(home, 'instructions', 'rules.md'), config = join(home, 'config.json')
  writeFileSync(file, 'HEADLESS_PINNED: preserve archives.')
  const calls: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (body.messages?.[0]?.role === 'system') calls.push(body)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    rmSync(root, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const cfg = { provider: { default: 'fixture', providers: { fixture: { name: 'fixture', apiKey: 'synthetic', baseUrl: origin + '/v1',
    endpointNetworkPolicy: { origin, allowPrivateNetwork: true }, models: [{ id: 'fixture-model', contextWindow: 100000, maxTokens: 4096 }] } } },
    agent: { userInstructions: { enabled: true, path: file }, hearthObserveEnabled: false, crossSessionEnabled: false } }
  const run = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(new URL('../../main.ts', import.meta.url)), '-p', 'Say ok.', '--json', ...args], {
      cwd: project, env: { ...process.env, RIVET_HOME: home, RIVET_CONFIG_PATH: config, RIVET_SESSION_DIR: sessions, RIVET_RESUME: '', RIVET_RESUME_ID: '', RIVET_HEADLESS_MAX_TURNS: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  })
  writeFileSync(config, JSON.stringify(cfg))
  const first = await run()
  assert.equal(first.code, 0, first.stderr)
  assert.equal(calls.length, 1)
  assert.ok(JSON.stringify(calls[0]).includes('HEADLESS_PINNED'))
  const frozenFile = readdirSync(sessions, { recursive: true }).map(String).find(path => path.endsWith('.frozen.json'))!
  assert.ok(frozenFile)
  const frozen = JSON.parse(readFileSync(join(sessions, frozenFile), 'utf8'))
  assert.equal(frozen.userInstructions.state, 'active')
  const sessionId = frozenFile.split(/[\\/]/).at(-1)!.replace('.frozen.json', '')
  cfg.agent.userInstructions.enabled = false
  writeFileSync(config, JSON.stringify(cfg))
  const restored = await run(['--resume', sessionId], { RIVET_ALLOW_COLD_START: '1' })
  assert.equal(restored.code, 0, restored.stderr)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.messages.slice(0, calls[0]!.messages.length), calls[0]!.messages)
  assert.ok(JSON.stringify(calls[1]!.messages.at(-1)).includes('此前同名用户长期指令已停用'))
  assert.equal(JSON.parse(readFileSync(join(sessions, frozenFile), 'utf8')).userInstructions.state, 'revoked')
})

test('headless snapshot detection fails closed on damaged published metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'user-instructions-corrupt-'))
  const before = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = root
  t.after(() => { if (before === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = before; rmSync(root, { recursive: true, force: true }) })
  const persist = new SessionPersist('broken-rules', root)
  assert.equal(persist.hasUserInstructionsSnapshot(), false)
  writeFileSync(join(getSessionDir(root), 'broken-rules.frozen.json'), '{"userInstructions":')
  assert.throws(() => persist.hasUserInstructionsSnapshot(), /payload_invalid/)
  writeFileSync(join(getSessionDir(root), 'broken-rules.frozen.json'), JSON.stringify({ userInstructions: { version: 2, state: 'revoked' } }))
  assert.throws(() => persist.hasUserInstructionsSnapshot(), /payload_invalid/)
  writeFileSync(join(getSessionDir(root), 'broken-rules.frozen.json'), '{}')
  assert.equal(persist.hasUserInstructionsSnapshot(), false)
})
