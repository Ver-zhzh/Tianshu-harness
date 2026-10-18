import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { previewContinuityRecovery, applyContinuityRecovery } from '../../agent/continuity-recovery.js'
import { continuityFixture } from '../../agent/__tests__/continuity-projection-fixture.js'

test('HTTP -> manager -> production facade -> durable recovery is authenticated and never runs tools', async t => {
  const fixture = continuityFixture(t)
  await fixture.agent.run('Please write result.txt.', fixture.callbacks)
  const source = ts.createSourceFile('serve-agent.ts', readFileSync(new URL('../serve-agent.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildManagedAgent')
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const returned = declaration.body.statements.find(statement => ts.isReturnStatement(statement))
  assert.ok(returned && ts.isReturnStatement(returned) && returned.expression && ts.isObjectLiteralExpression(returned.expression))
  const methods = returned.expression.properties.filter(property => property.name && ['previewContinuityRecovery', 'applyContinuityRecovery'].includes(property.name.getText(source)))
  assert.equal(methods.length, 2, 'both recovery methods must reach the real agent')
  const code = ts.transpileModule(`return {${methods.map(method => method.getText(source)).join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const forwarding = new Function('agent', 'previewContinuityRecovery', 'applyContinuityRecovery', code)(fixture.agent, previewContinuityRecovery, applyContinuityRecovery)
  const facade: ManagedAgent = { run: async () => assert.fail('recovery must not run'), abort() {}, getMessages: () => fixture.agent.session.getMessages(),
    replaceMessages() {}, rewindToMessages() {}, listArtifacts: () => [], readArtifact: async () => null, ...forwarding }
  const manager = new RuntimeSessionManager({ createAgent: () => facade, defaultCwd: fixture.root })
  const record = manager.createSession({ cwd: fixture.root })
  const router = createRouter(buildSessionRoutes(manager, 'fixture-auth'))
  const path = `/sessions/${record.id}/continuity-recovery`
  const auth = { authorization: 'Bearer fixture-auth' }
  const sends = fixture.bodies.length
  assert.equal((await router('GET', path, {}, {})).status, 401)
  assert.equal((await router('POST', path, {}, auth)).status, 400)
  const preview = await router('GET', path, {}, auth)
  assert.equal(preview.status, 200)
  const plan = preview.body as Awaited<ReturnType<typeof previewContinuityRecovery>>
  assert.equal(plan.status, 'ready', plan.reason)
  const applied = await router('POST', path, { recoveryId: plan.recoveryId }, auth)
  assert.equal(applied.status, 200)
  assert.equal((applied.body as typeof plan).status, 'applied')
  assert.equal(fixture.persist.readFrozenSnapshot()!.rewindAuthorization?.reason, 'explicit_projection_recovery')
  assert.equal(fixture.bodies.length, sends)
  assert.equal(fixture.toolResults(), 1)
  assert.equal((await router('GET', '/sessions/missing/continuity-recovery', {}, auth)).status, 404)
})
