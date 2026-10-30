import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { archiveHistoryRescue, buildHistoryRescue } from '../../agent/history-rescue.js'
import { buildHistoryRescueRoutes } from '../history-rescue-routes.js'
import { appendChecksum } from '../../agent/checksum.js'
import { serializeOaiSessionMessage } from '../../agent/session-message-serialization.js'
import { MAX_SESSION_MESSAGE_JSON_CHARS } from '../../compact/constants.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { proveRewindHistory } from '../../api/continuation-prefix.js'

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'history-rescue-'))
  const previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  const manager = new RuntimeSessionManager({ defaultCwd: root, createAgent: () => { throw new Error('Broken agents must never be built by rescue') },
    persistence: { saveRecord() {}, appendEvent() {}, loadAll: () => [], flushThrough: async (_id, seq) => seq, flushAllAsync: async () => {} } })
  const source = manager.createSession({ id: 'broken-history', cwd: root, allowedTools: ['read_file'], approvalMode: 'manual' })
  const persist = new SessionPersist(source.id, root)
  t.after(async () => {
    await manager.shutdownAll()
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  return { root, manager, source, persist }
}

test('cold legacy truncation exports exact evidence and creates an independent idle handoff without tool replay', async t => {
  const { root, manager, source, persist } = fixture(t)
  const messages: OaiMessage[] = [
    { role: 'user', origin: 'human', content: 'Inspect the project.' },
    { role: 'assistant', content: 'Complete', reasoning_content: 'original reasoning '.repeat(30_000), tool_calls: [{ id: 'done', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"result.txt","content":"done"}' } }] },
    { role: 'tool', tool_call_id: 'done', content: 'File saved.' },
    { role: 'user', origin: 'human', content: 'Continue.' },
  ]
  const legacy = messages.map(message => JSON.parse(serializeOaiSessionMessage(message, MAX_SESSION_MESSAGE_JSON_CHARS)) as OaiMessage)
  await persist.compactOaiAsync(legacy, true)
  persist.writeFrozenSnapshot({ v: 1, publishedHistory: proveRewindHistory(messages), publishedUserCount: 2,
    firstUserKey: null, frozenUserMerged: [], frozenPendingMerged: [], collapseWatermark: 0, collapseTokenStep: 0 })
  const path = persist.getFilePath(), frozenPath = path.replace(/\.jsonl$/, '.frozen.json')
  const before = readFileSync(path), frozenBefore = readFileSync(frozenPath)
  const snapshot = await manager.historyRescue(source.id)
  assert.ok(snapshot && 'sourceHash' in snapshot)
  assert.equal(snapshot.diagnostic.reason, 'published_source')
  assert.equal(snapshot.diagnostic.firstMismatch, 1)
  assert.equal(snapshot.diagnostic.publishedCount, 4)
  assert.equal(snapshot.diagnostic.legacyTruncation, true)
  assert.deepEqual(Buffer.from(snapshot.transcriptBase64, 'base64'), before)
  assert.deepEqual(Buffer.from(snapshot.frozenBase64, 'base64'), frozenBefore)
  const result = await manager.historyRescue(source.id, snapshot.sourceHash)
  assert.ok(result && 'session' in result)
  assert.notEqual(result.session.id, source.id)
  assert.notEqual(result.session.status, 'running')
  assert.deepEqual(result.session.allowedTools, ['read_file'])
  assert.equal(result.session.approvalMode, 'manual')
  const child = new SessionPersist(result.session.id, root)
  assert.equal(child.readFrozenSnapshot(), undefined, 'old continuity evidence must not be inherited')
  assert.equal(child.hasColdStartConsent(), true)
  const reference = child.loadOai()
  assert.equal(reference.length, 1)
  assert.equal(reference[0]!.role, 'user')
  assert.match(String(reference[0]!.content), /File saved/)
  assert.match(String(reference[0]!.content), /可能存在截断|可能有缺失/)
  assert.ok(reference.every(message => message.role !== 'assistant' && message.role !== 'tool'), 'completed calls must never become executable history')
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readFileSync(frozenPath), frozenBefore)
  assert.equal((await manager.historyRescue(source.id, snapshot.sourceHash) as typeof result).session.id, result.session.id)
  const restarted = new RuntimeSessionManager({ defaultCwd: root, createAgent: () => ({} as ManagedAgent) })
  try {
    restarted.createSession({ id: source.id, cwd: root })
    restarted.createSession({ id: result.session.id, cwd: root })
    const retried = await restarted.historyRescue(source.id, snapshot.sourceHash)
    assert.ok(retried && 'session' in retried)
    assert.equal(retried.session.id, result.session.id, 'restart must not duplicate a confirmed rescue')
  } finally { await restarted.shutdownAll() }
})

test('preview races, running sources, and update preparation never authorize rescue', async t => {
  const { manager, source, persist } = fixture(t)
  await persist.appendOaiWithChecksum({ role: 'user', content: 'original' }, { flush: true })
  const snapshot = await manager.historyRescue(source.id)
  assert.ok(snapshot && 'sourceHash' in snapshot)
  await persist.appendOaiWithChecksum({ role: 'user', content: 'new user input' }, { flush: true })
  await assert.rejects(manager.historyRescue(source.id, snapshot.sourceHash), /预览后发生变化/)
  const internal = (manager as unknown as { sessions: Map<string, { running: boolean }> }).sessions.get(source.id)!
  internal.running = true
  await assert.rejects(manager.historyRescue(source.id), /等待/)
  internal.running = false
  await manager.prepareUpdateRestart(false, AbortSignal.timeout(1000), { allowUnsaved: true })
  await assert.rejects(manager.historyRescue(source.id), /等待/)
  manager.cancelUpdateRestart()
})

test('damaged checksums are disclosed and preserved verbatim; large handoffs remain bounded', async t => {
  const { persist } = fixture(t)
  const valid = appendChecksum(JSON.stringify({ role: 'user', content: 'useful reference '.repeat(1000) }))
  const text = Array.from({ length: 50 }, () => valid).join('\n') + '\n{"role":"assistant","content":"secret content must not enter diagnostics"}|0000000000000000\n'
  writeFileSync(persist.getFilePath(), text)
  const rescue = buildHistoryRescue(persist)
  assert.equal(rescue.diagnostic.reason, 'checksum')
  assert.equal(Buffer.from(rescue.transcriptBase64, 'base64').toString(), text)
  assert.ok(rescue.handoff.length < 62_000)
  assert.ok(rescue.coverage.omittedMessages > 0)
  assert.match(rescue.handoff, /truncated for handoff/)
  assert.doesNotMatch(JSON.stringify(rescue.diagnostic), /secret content/)
})

test('an unreadable zstd transcript can still be exported exactly, with no invented history', t => {
  const { persist } = fixture(t)
  const damaged = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01])
  writeFileSync(persist.getFilePath(), damaged)
  const rescue = buildHistoryRescue(persist)
  assert.deepEqual(Buffer.from(rescue.transcriptBase64, 'base64'), damaged)
  assert.equal(rescue.messages.length, 0)
  assert.equal(rescue.coverage.includedMessages, 0)
  assert.ok(['unreadable', 'incomplete_frame'].includes(rescue.diagnostic.reason))
  const archive = archiveHistoryRescue(persist, rescue)
  assert.equal(archiveHistoryRescue(persist, rescue), archive)
  writeFileSync(archive, 'unrelated backup')
  assert.throws(() => archiveHistoryRescue(persist, rescue), /不一致/)
  assert.equal(readFileSync(archive, 'utf8'), 'unrelated backup')
})

test('rescue reads one captured transcript and never manufactures a missing tool result', async t => {
  const { persist } = fixture(t)
  await persist.compactOaiAsync([
    { role: 'user', content: 'Inspect only' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'interrupted', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
  ], true)
  t.mock.method(persist, 'loadOai', () => { throw new Error('A second disk read could observe a different transcript') })
  const rescue = buildHistoryRescue(persist)
  assert.equal(rescue.messages.length, 2)
  assert.ok(rescue.messages.every(message => message.role !== 'tool'), 'unknown tool outcome must remain unknown')
  assert.equal(rescue.diagnostic.reason, 'none')
})

test('rescue routes require authentication and a preview fingerprint, even when the agent is unbuildable', async t => {
  const { manager, source, persist } = fixture(t)
  await persist.appendOaiWithChecksum({ role: 'user', content: 'Continue from here' }, { flush: true })
  const routes = buildHistoryRescueRoutes(manager, 'fixture')
  const params = { id: source.id }, headers = { authorization: 'Bearer fixture' }
  assert.equal((await routes['GET /sessions/:id/history-rescue']({}, params, {})).status, 401)
  assert.equal((await routes['POST /sessions/:id/history-rescue']({}, params, headers)).status, 400)
  const response = await routes['GET /sessions/:id/history-rescue']({}, params, headers)
  assert.equal(response.status, 200)
  const sourceHash = (response.body as { sourceHash: string }).sourceHash
  const confirmed = await routes['POST /sessions/:id/history-rescue']({ sourceHash }, params, headers)
  assert.equal(confirmed.status, 200)
})
