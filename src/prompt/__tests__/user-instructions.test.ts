import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { buildStableVolatileBlock } from '../volatile.js'
import { parseFrozenSnapshotData } from '../frozen-snapshot.js'
import { proveRewindHistory } from '../../api/continuation-prefix.js'
import { classifyApiError } from '../../api/error-classifier.js'
import { describeFailure } from '../../api/failure-scope.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { DISABLED_USER_INSTRUCTIONS, USER_INSTRUCTIONS_MAX_RENDERED_CHARS, USER_INSTRUCTIONS_REVOKED_BLOCK,
  UserInstructionsError, createUserInstructionsSnapshot, parseUserInstructionsSnapshot, renderUserInstructions, type UserInstructionsSnapshot } from '../user-instructions.js'

const a = createUserInstructionsSnapshot('RULE_A: NEVER delete archives.')
const b = createUserInstructionsSnapshot('RULE_B: use Chinese.')
const input = (content: string, origin: import('../../agent/input-origin.js').InputOrigin = 'human'): OaiMessage => ({ role: 'user', content, origin })
function engine(source: UserInstructionsSnapshot = a, inherit?: ReturnType<PromptEngine['exportFrozenSnapshot']>) {
  return new PromptEngine({ model: 'fixture', maxTokens: 1024, staticCtx: { tools: [] }, habituationThreshold: 0,
    volatileCtx: { cwd: '/synthetic-user-instructions', rivetMd: '## Safety\nNEVER overwrite protected paths.', userInstructions: source }, inheritFrozenFrom: inherit })
}
async function publish(e: PromptEngine, messages: OaiMessage[]) {
  const request = e.buildOaiRequest(messages)
  await request.onExecutionSnapshot!({ messages: proveRewindHistory(request.messages) } as import('../../api/continuation-prefix.js').ContinuationPrefixProof)
  return request
}

test('independent complete budget never changes the project selection or its gates', () => {
  const md = '# Project\n' + 'p'.repeat(7400) + '\n\n## Safety\nNEVER overwrite protected paths.'
  const ctx = { cwd: '/synthetic-user-instructions', rivetMd: md }
  const baseline = buildStableVolatileBlock(ctx)
  const maxText = 'x'.repeat(1024 - renderUserInstructions(createUserInstructionsSnapshot('x'))!.length - 1)
  const snapshot = createUserInstructionsSnapshot(maxText)
  const combined = buildStableVolatileBlock({ ...ctx, userInstructions: snapshot })
  const project = (s: string) => s.match(/<project-instructions>[\s\S]*?<\/project-instructions>/)?.[0]
  assert.equal(project(combined), project(baseline))
  assert.ok(project(combined)?.includes('NEVER overwrite protected paths.'))
  assert.equal(renderUserInstructions(snapshot)!.length + 2, USER_INSTRUCTIONS_MAX_RENDERED_CHARS)
  assert.throws(() => createUserInstructionsSnapshot(maxText + 'x'), /over_budget/)
  assert.throws(() => createUserInstructionsSnapshot('&'.repeat(250) + 'NEVER delete archives.'), /over_budget/)
})

test('never-enabled and explicitly disabled requests remain byte-identical', () => {
  const config = { model: 'fixture', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd: '/synthetic-user-instructions', rivetMd: 'project' } }
  const old = new PromptEngine(config).buildOaiRequest([input('hello')])
  const disabled = new PromptEngine({ ...config, volatileCtx: { ...config.volatileCtx, userInstructions: DISABLED_USER_INSTRUCTIONS } }).buildOaiRequest([input('hello')])
  assert.deepEqual(disabled.messages, old.messages)
  assert.ok(!JSON.stringify(disabled.messages).includes('<user-instructions'))
})

test('payload validator rejects missing, unknown, altered and unnormalized snapshots', () => {
  for (const raw of [undefined, {}, { ...a, version: 2 }, { ...a, digest: '0'.repeat(64) }, { ...a, text: 'changed' }, { ...a, text: ' trailing\r\n' }, { ...DISABLED_USER_INSTRUCTIONS, text: 'hidden' }]) {
    assert.throws(() => parseUserInstructionsSnapshot(raw), /payload_invalid/)
  }
  assert.deepEqual(parseUserInstructionsSnapshot(JSON.parse(JSON.stringify(a))), a)
})

test('build, cancellation and side paths cannot publish rules; cached draft publication can', async () => {
  const e = engine(), messages = [input('task')]
  e.buildOaiRequest(messages)
  assert.equal(e.exportFrozenSnapshot().userInstructions, undefined)
  assert.throws(() => e.getUserInstructionsForDispatch(), /boundary_required/)
  e.buildOaiRequest([input('summary')], undefined, undefined, { sidePath: true })
  assert.equal(e.exportFrozenSnapshot().userInstructions, undefined)
  await publish(e, messages)
  assert.deepEqual(e.getUserInstructionsForDispatch(), a)
  assert.equal(e.exportFrozenSnapshot().userInstructions?.state, 'active')
  assert.ok(e.getPrefixBudgetInputs().some(part => part.name === 'user-instructions (published)' && part.content?.includes('RULE_A')))
})

test('durable failure leaves publication and dispatch blocked; retry commits matching rules', async () => {
  const e = engine()
  e.setExecutionSnapshotCommit(async () => { throw new Error('disk unavailable') })
  await assert.rejects(publish(e, [input('task')]), /disk unavailable/)
  assert.equal(e.exportFrozenSnapshot().userInstructions, undefined)
  assert.throws(() => e.getUserInstructionsForDispatch(), /boundary_required/)
  e.setExecutionSnapshotCommit(async () => {})
  await publish(e, [input('task')])
  assert.deepEqual(e.getUserInstructionsForDispatch(), a)
})

test('resume applies replacements and revocations only at a new authorized input boundary', async () => {
  const first = engine(), history = [input('task')]
  const oldRequest = await publish(first, history)
  const frozen = JSON.parse(JSON.stringify(first.exportFrozenSnapshot()))
  const same = engine(a, frozen)
  assert.deepEqual(same.buildOaiRequest(history).messages, oldRequest.messages)
  for (const desired of [b, DISABLED_USER_INSTRUCTIONS]) {
    const restored = engine(desired, frozen)
    assert.equal(restored.requiresUserInstructionsBoundary(), true)
    assert.throws(() => restored.buildOaiRequest(history), /boundary_required/)
    assert.throws(() => restored.buildOaiRequest([...history, input('auto', 'runtime_command')]), /boundary_required/)
    assert.throws(() => restored.getUserInstructionsForDispatch(), /boundary_required/)
    const messages = [...history, { role: 'assistant' as const, content: 'done' }, input('continue')]
    const request = await publish(restored, messages)
    assert.deepEqual(request.messages[1], oldRequest.messages[1])
    const tail = JSON.stringify(request.messages.at(-1))
    assert.ok(tail.includes(desired.state === 'active' ? 'RULE_B' : '此前同名用户长期指令已停用'))
    assert.equal(restored.requiresUserInstructionsBoundary(), false)
    assert.deepEqual(restored.getUserInstructionsForDispatch(), desired)
    assert.equal(restored.exportFrozenSnapshot().userInstructions?.state, desired.state === 'active' ? 'active' : 'revoked')
    assert.deepEqual(restored.buildOaiRequest(messages).messages, request.messages, 'tool rounds keep all bytes stable')
  }
})

test('revocation survives repeated restore and re-enabling, with no global static changes', async () => {
  const first = engine(); await publish(first, [input('a')])
  const off = engine(DISABLED_USER_INSTRUCTIONS, first.exportFrozenSnapshot())
  const history = [input('a'), input('disable')]
  await publish(off, history)
  const restored = engine(DISABLED_USER_INSTRUCTIONS, off.exportFrozenSnapshot())
  const next = await publish(restored, [...history, input('next')])
  assert.ok(JSON.stringify(next.messages.at(-1)).includes(USER_INSTRUCTIONS_REVOKED_BLOCK.replace(/"/g, '\\"')))
  const on = engine(b, restored.exportFrozenSnapshot())
  await publish(on, [...history, input('next'), input('enable')])
  assert.equal(on.exportFrozenSnapshot().userInstructions?.state, 'active')
  assert.equal(first.getSystemPrompt(), on.getSystemPrompt())
})

test('invalid applied metadata cannot pass frozen-snapshot parsing', () => {
  const frozen = engine().exportFrozenSnapshot()
  for (const value of [{ version: 2, state: 'active' }, { version: 1, state: 'active', digest: 'bad' }, { version: 1, state: 'revoked', text: 'hidden' }]) {
    assert.equal(parseFrozenSnapshotData({ ...frozen, userInstructions: value }), undefined)
  }
  assert.ok(parseFrozenSnapshotData(frozen))
})

test('local rule errors cannot trigger provider retries or reconnect', () => {
  const error = new UserInstructionsError('user_instructions_boundary_required', 'new human input required')
  assert.equal(classifyApiError(error).retryable, false)
  assert.equal(classifyApiError(error).shouldReconnect, false)
  assert.equal(classifyApiError(error).maxRetries, 0)
  assert.equal(describeFailure(error).scope, 'local')
})

test('a real input authorization survives a generation reset and is withdrawn when the run ends', async () => {
  const first = engine(); await publish(first, [input('old')])
  const restored = engine(b, first.exportFrozenSnapshot())
  restored.authorizeCacheGeneration()
  assert.throws(() => restored.buildOaiRequest([input('new')]), /boundary_required/)
  const end = restored.beginUserInstructionsInput('human')
  restored.buildOaiRequest([input('new')])
  end()
  assert.throws(() => restored.buildOaiRequest([input('new')]), /boundary_required/)
  const finish = restored.beginUserInstructionsInput('human')
  await publish(restored, [input('new')]); finish()
  assert.deepEqual(restored.getUserInstructionsForDispatch(), b)
})

test('budget reports count every published boundary copy and expose pending state without rule text', async () => {
  const e = engine(), first = [input('first')]
  await publish(e, first)
  const chars = renderUserInstructions(a)!.length + 2
  assert.equal(e.getPrefixBudgetInputs().find(part => part.name === 'user-instructions (published)')?.content?.length, chars)
  await publish(e, [...first, input('second')])
  assert.equal(e.getPrefixBudgetInputs().find(part => part.name === 'user-instructions (published)')?.content?.length, chars * 2)
  const restored = engine(b, e.exportFrozenSnapshot())
  assert.equal(restored.getUserInstructionsStatus().pending, true)
  assert.equal(restored.getUserInstructionsStatus().appliedDigest, a.state === 'active' ? a.digest : undefined)
  assert.ok(!JSON.stringify(restored.getUserInstructionsStatus()).includes('RULE_A'))
  assert.ok(!JSON.stringify(restored.getUserInstructionsStatus()).includes('RULE_B'))
  assert.equal(restored.getPrefixBudgetInputs().find(part => part.name === 'user-instructions (pending)')?.content?.length, renderUserInstructions(b)!.length + 2)
})
