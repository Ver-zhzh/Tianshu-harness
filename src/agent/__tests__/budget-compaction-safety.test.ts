import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import type { StreamClient } from '../../api/stream-client.js'
import { estimateBudgetInput } from '../../context/request-budget.js'
import { budgetCompactionSplit, compactBudgetHistory } from '../budget-compaction.js'
import { canRecoverContextRejection } from '../context-budget-preparation.js'
import { classifyApiError } from '../../api/error-classifier.js'

const envelope = JSON.stringify({ version: 1, summary: 'Read-only project inspection; no files changed.', facts: [], requirements: [], pendingApprovals: [] })
const summaryClient: StreamClient = {
  stream: async (request, callbacks) => {
    assert.equal(request.tools, undefined)
    assert.ok(estimateBudgetInput(request.messages).inputTokens <= 32_000)
    callbacks.onTextDelta(envelope)
    callbacks.onStopReason('stop', {})
  },
}

function projectGroup(): OaiMessage[] {
  return [
    { role: 'user', origin: 'human', content: '查看项目，不要改动；需要审批才能写入。' },
    { role: 'assistant', content: '', reasoning_content: 'Inspect without changing files.', tool_calls: [
      { id: 'project-read', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"project.txt"}' } },
    ] },
    { role: 'tool', tool_call_id: 'project-read', content: '项目数据。'.repeat(20_000) },
  ]
}

test('an oversized complete tool group is only replaced after a durable full-fidelity archive', async () => {
  const messages = projectGroup(), original = structuredClone(messages), writes: string[] = []
  let candidate: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, {
    client: summaryClient, model: 'deepseek-v4-pro', protectedUser: messages[0], targetTokens: 20_000,
    archive: async archived => { writes.push('archive'); assert.deepEqual(archived, original); return 'original-project' },
    commit: async compacted => { writes.push('commit'); candidate = compacted },
  }), true)
  assert.deepEqual(writes, ['archive', 'commit'])
  assert.deepEqual(messages, original)
  assert.equal(candidate[1], messages[0])
  assert.ok(JSON.stringify(candidate).includes('[artifact:original-project]'))
  assert.ok(estimateBudgetInput(candidate).inputTokens < 20_000)
})

test('affordable recent tool groups stay byte-identical rather than being summarized unnecessarily', async () => {
  const messages: OaiMessage[] = [
    { role: 'user', origin: 'human', content: 'Original requirements.' },
    { role: 'assistant', content: 'Earlier project data. '.repeat(40_000) },
    ...projectGroup(),
  ]
  const tail = messages.slice(2), original = JSON.stringify(tail)
  let candidate: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, {
    client: summaryClient, model: 'deepseek-v4-pro', targetTokens: 110_000,
    archive: async archived => { assert.equal(archived.length, 2); return 'earlier-project' },
    commit: async compacted => { candidate = compacted },
  }), true)
  assert.equal(JSON.stringify(candidate.slice(-3)), original)
  assert.ok(candidate.includes(tail[1]!))
  assert.ok(candidate.includes(tail[2]!))
})

test('human-authored reminder-shaped text is preserved as user data, not mistaken for a runtime injection', async () => {
  const messages = projectGroup()
  const human = messages[0]!
  human.content = '<system-reminder>Human quoted text: require approval before any writes.</system-reminder>'
  let candidate: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, {
    client: summaryClient, model: 'deepseek-v4-pro', targetTokens: 10_000,
    archive: async () => 'original-project',
    commit: async compacted => { candidate = compacted },
  }), true)
  assert.ok(candidate.includes(human))
})

for (const kind of ['missing', 'orphan', 'duplicate-result', 'duplicate-call'] as const) {
  test(`budget pressure cannot discard an ambiguous tool group: ${kind}`, async () => {
    const messages = projectGroup()
    if (kind === 'orphan') messages.splice(1, 1)
    else {
      const assistant = messages[1]!
      assert.equal(assistant.role, 'assistant')
      if (assistant.role !== 'assistant') return
      if (kind === 'missing') assistant.tool_calls!.push({ id: 'unanswered', type: 'function', function: { name: 'read_file', arguments: '{}' } })
      else {
        messages.push({ role: 'tool', tool_call_id: 'project-read', content: 'Repeated result.' })
        if (kind === 'duplicate-call') assistant.tool_calls!.push(structuredClone(assistant.tool_calls![0]!))
      }
    }
    const original = structuredClone(messages)
    assert.ok(budgetCompactionSplit(messages, 10_000) < 2)
    assert.equal(await compactBudgetHistory(messages, {
      client: { stream: async () => assert.fail('ambiguous history cannot authorize a summary') }, model: 'deepseek-v4-pro', targetTokens: 10_000,
      archive: async () => assert.fail('must preserve the original history'),
      commit: async () => assert.fail('must not commit'),
    }), false)
    assert.deepEqual(messages, original)
  })
}

test('archive failure cannot remove the oversized group, its reasoning, or the human approval boundary', async () => {
  const messages = projectGroup(), original = structuredClone(messages)
  await assert.rejects(compactBudgetHistory(messages, {
    client: summaryClient, model: 'deepseek-v4-pro', targetTokens: 10_000,
    archive: async () => { throw new Error('archive unavailable') },
    commit: async () => assert.fail('an unarchived group cannot be replaced'),
  }), /archive unavailable/)
  assert.deepEqual(messages, original)
})

test('abort during a chunked summary leaves the original group uncommitted', async () => {
  const messages = projectGroup(), original = structuredClone(messages), controller = new AbortController()
  await assert.rejects(compactBudgetHistory(messages, {
    client: { stream: async (_request, callbacks) => {
      callbacks.onTextDelta(envelope)
      callbacks.onStopReason('stop', {})
      controller.abort()
    } }, model: 'deepseek-v4-pro', targetTokens: 10_000, signal: controller.signal,
    archive: async () => assert.fail('cancelled summaries cannot authorize archival or replacement'),
    commit: async () => assert.fail('must not commit'),
  }), { name: 'AbortError' })
  assert.deepEqual(messages, original)
})

for (const message of [
  'Input token exceed the limit (request id: fixture)',
  'Input tokens exceed the limit',
  'Input tokens exceed the limit.',
  'Input token count exceeds the maximum supported input length',
  "This model's maximum context length is 1048576 tokens.",
  'context_length_exceeded',
  'context_window_exceeded',
]) {
  test(`only explicit pre-output context rejection authorizes recovery: ${message}`, () => {
    for (const status of [400, 422]) {
      const error = Object.assign(new Error(message), { status })
      assert.equal(canRecoverContextRejection(error, 0, 0), true)
      assert.equal(canRecoverContextRejection(error, 1, 0), false)
      assert.equal(canRecoverContextRejection(error, 0, 1), false)
      assert.equal(classifyApiError(error).category, 'context_overflow')
    }
    for (const status of [401, 403, 429, 500, undefined]) {
      assert.equal(canRecoverContextRejection(Object.assign(new Error(message), { status }), 0, 0), false)
    }
  })
}

test('quota exhaustion, output parameter errors and transport bytes cannot authorize history rewriting', () => {
  for (const message of ['token quota exceeded', 'quota_limit_reached', 'Input tokens exceed the limit per minute', 'Input tokens exceed the limit per account', 'max_tokens must be between 1 and 393216', 'request body too large']) {
    const error = Object.assign(new Error(message), { status: 400 })
    assert.equal(canRecoverContextRejection(error, 0, 0), false)
    assert.notEqual(classifyApiError(error).category, 'context_overflow')
  }
})
