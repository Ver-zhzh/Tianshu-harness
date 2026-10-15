import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { LocalWorkerPolicyError } from '../../api/continuation-prefix.js'
import { PromptEngine } from '../../prompt/engine.js'
import { buildReplacementAgent } from '../../agent/runtime-rebuild.js'

test('model switch reports a blocked history restore without an opaque 500 or a success event', async () => {
  for (const failure of [new LocalWorkerPolicyError('synthetic incomplete snapshot'), new Error('private diagnostic')]) {
    const manager = new RuntimeSessionManager({
      createAgent: async () => { throw failure }, defaultCwd: '/controlled-fixture',
    })
    const record = manager.createSession({ model: 'fixture:old' })
    const router = createRouter(buildSessionRoutes(manager, 'fixture-auth'))
    const result = await router('POST', `/sessions/${record.id}/model`, { modelId: 'fixture:new' },
      { authorization: 'Bearer fixture-auth' })
    assert.equal(result.status, 409)
    assert.equal((result.body as { code: string }).code,
      failure instanceof LocalWorkerPolicyError ? 'history_recovery_required' : 'model_initialization_failed')
    assert.ok(!JSON.stringify(result.body).includes(failure.message), 'internal diagnostics stay private')
    assert.equal(manager.getSession(record.id)?.model, 'fixture:old')
    assert.ok(!manager.getEvents(record.id, 0)?.events.some(event => event.type === 'model_switched'))
  }
  const agent: ManagedAgent = {
    run: async () => {}, abort() {}, listArtifacts: () => [], readArtifact: async () => null,
    getMessages: () => [], replaceMessages() {}, rewindToMessages() {},
    switchModel() { throw new Error('synthetic replacement failure') },
  }
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: '/controlled-fixture',
    listModels: () => [{ id: 'new', alias: 'new', provider: 'fixture' }], resumeFallbackModel: 'fixture:new' })
  const record = manager.createSession({ model: 'fixture:old' })
  assert.equal(await manager.ensureSessionAgent(record.id), true)
  const resumed = await manager.resumeRun(record.id)
  assert.equal(resumed.ok, false, 'resume must keep its structured failure contract')
  assert.equal(manager.getSession(record.id)?.model, 'fixture:old')
})

// Exercise the actual managed facade and rebuild body, replacing only the heavy runtime constructor.
function switchFixture() {
  const source = readFileSync(new URL('../serve-agent.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve-agent.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'buildManagedAgent')
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const returned = declaration.body.statements.find(statement => ts.isReturnStatement(statement))
  assert.ok(returned && ts.isReturnStatement(returned) && returned.expression)
  const rebuild = declaration.body.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(variable => variable.name.getText(parsed) === 'rebuildOnSpec'))
  assert.ok(rebuild)
  const code = ts.transpileModule(`${rebuild.getText(parsed)}; return {facade: ${returned.expression.getText(parsed)}, readSpec: () => spec}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const engine = new PromptEngine({ model: 'old', maxTokens: 4096, staticCtx: { tools: [] },
    volatileCtx: { cwd: '/controlled-fixture' } })
  const proof = { marker: 'original-execution-proof' }
  Reflect.set(engine, 'executionSnapshot', proof)
  const state = { fail: true, canceled: 0, oldShutdown: 0, candidateShutdown: 0, model: 'old', reloadSeen: false }
  const oldCoordinator = { shutdown() { state.oldShutdown++ } }
  const refs = { coordinator: oldCoordinator, promptEngine: engine, claimTrackerRef: { current: 'old-claims' } }
  const reload = () => ({ fixture: true })
  const agent = { config: { promptEngine: engine, approvalMode: 'normal' },
    cancelIdleCompaction() { state.canceled++; return Promise.resolve() },
    getSessionDomain() { return state.model },
  }
  const { facade, readSpec } = new Function('agent', 'spec', 'stores', 'ctx', 'reload', 'shared', 'sessionId',
    'resolveModelSpecWithReload', 'assembleAgentLoop', 'cwd', 'registry', 'allowedTools', 'buildReplacementAgent', code)(
    agent, { provider: { name: 'fixture' }, model: { id: 'old' } },
    { refs, persist: { updateMetadata() {}, appendModelSwitch() {} } }, {}, reload, undefined, 'fixture-id',
    (_ctx: unknown, model: string, actualReload: unknown) => {
      state.reloadSeen = actualReload === reload
      return { provider: { name: 'fixture' }, model: { id: model } }
    },
    (_ctx: unknown, _cwd: string, _id: string, _stores: unknown, spec: { model: { id: string } }) => {
      refs.coordinator = { shutdown() { state.candidateShutdown++ } }
      refs.claimTrackerRef.current = 'candidate-claims'
      if (state.fail) throw new Error('synthetic constructor failure')
      state.model = spec.model.id
      return { ...agent, config: { ...agent.config, client: { authorizeCacheGeneration() {} } } }
    }, '/controlled-fixture', undefined, undefined, buildReplacementAgent) as { facade: ManagedAgent; readSpec(): { model: { id: string } } }
  return { facade, readSpec, engine, proof, state, refs, oldCoordinator }
}

test('failed model rebuild preserves the old execution proof, coordinator and idle runtime; retry succeeds', () => {
  const fixture = switchFixture()
  assert.throws(() => fixture.facade.switchModel!('new'), /synthetic constructor failure/)
  assert.equal(fixture.engine.getExecutionSnapshot(), fixture.proof)
  assert.equal(fixture.refs.coordinator, fixture.oldCoordinator)
  assert.equal(fixture.refs.claimTrackerRef.current, 'old-claims')
  assert.equal(fixture.readSpec().model.id, 'old')
  assert.equal(fixture.state.canceled, 0)
  assert.equal(fixture.state.oldShutdown, 0)
  assert.equal(fixture.state.candidateShutdown, 1)
  fixture.state.fail = false
  assert.equal(fixture.facade.switchModel!('new'), 'fixture:new')
  assert.equal(fixture.state.oldShutdown, 1)
  assert.equal(fixture.state.canceled, 1)
})

test('managed model switch resolves against the injected live configuration', () => {
  const fixture = switchFixture()
  fixture.state.fail = false
  fixture.facade.switchModel!('new')
  assert.equal(fixture.state.reloadSeen, true)
})
