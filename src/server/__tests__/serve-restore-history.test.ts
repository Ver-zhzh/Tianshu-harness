/**
 * Regression: sidecar restart loses LLM context.
 *
 * Root cause: when the Rust shell spawns a fresh `rivet serve` sidecar, the
 * RuntimeSessionManager rehydrates session *records* + *event logs* from disk,
 * but the agent's LLM message stack (SessionContext.oaiMessages) is NOT
 * restored. The TUI bootstrap path does `persist.loadOai()` + `replaceMessages()`;
 * the desktop sidecar path (`buildSessionStores`) was missing the equivalent
 * call, so a user opening a prior session after restart sees the full UI
 * history (from the event log) but the model receives an empty context.
 *
 * This test verifies the exported helper that buildSessionStores calls to
 * restore prior OAI messages into a fresh SessionContext — the exact gap.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionPersist } from '../../agent/session-persist.js'
import { SessionContext } from '../../agent/context.js'
import { describeRestore, restoreHistoryMessages } from '../serve.js'
import { prepareRecoveredMessagesAsync, resolveHistoryRestore } from '../serve-agent.js'
import { appendChecksum } from '../../agent/checksum.js'
import { isAssistantWithTools, type OaiMessage } from '../../api/oai-types.js'
import { formatDiskReconciliationNote } from '../../context/write-evidence-probe.js'

let tmpDir: string
const ORIG_SESSION_DIR = process.env.RIVET_SESSION_DIR

before(() => {
  tmpDir = join(process.cwd(), '.tmp', `rivet-restore-test-${process.pid}`)
  mkdirSync(tmpDir, { recursive: true })
  process.env.RIVET_SESSION_DIR = tmpDir
})

after(() => {
  if (ORIG_SESSION_DIR !== undefined) process.env.RIVET_SESSION_DIR = ORIG_SESSION_DIR
  else delete process.env.RIVET_SESSION_DIR
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

/** Write OAI messages to a session .jsonl file (checksummed, matching SessionPersist format). */
function seedSession(sessionId: string, messages: OaiMessage[]): void {
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const lines = messages.map(m => appendChecksum(JSON.stringify(m)) + '\n').join('')
  writeFileSync(persist.getFilePath(), lines, 'utf8')
}

test('restoreHistoryMessages: loads prior OAI messages into a fresh SessionContext', () => {
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const seed: OaiMessage[] = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
  ]
  seedSession(sessionId, seed)

  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  assert.equal(session.getMessages().length, 0, 'fresh context starts empty')

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 2, 'returns the number of restored messages')
  assert.equal(info.error, undefined)
  const msgs = session.getMessages()
  assert.equal(msgs.length, 2, 'context now holds the prior conversation')
  assert.equal(msgs[0]!.role, 'user')
  assert.equal(msgs[0]!.content, 'What is 2+2?')
  assert.equal(msgs[1]!.role, 'assistant')
  assert.equal(msgs[1]!.content, '4')
})

test('restoreHistoryMessages: no-op for a brand-new session with no prior file', () => {
  const sessionId = 'new-session-no-file'
  // Deliberately do NOT seed any file — this is the brand-new session path.
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 0, 'no messages to restore')
  assert.equal(session.getMessages().length, 0, 'context stays empty for new sessions')
})

test('restoreHistoryMessages: no-op when session file is empty', () => {
  const sessionId = 'empty-session'
  // Create the file but with no valid messages.
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  writeFileSync(persist.getFilePath(), '', 'utf8')

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session)
  assert.equal(info.restored, 0)
  assert.equal(session.getMessages().length, 0)
})

test('restoreHistoryMessages: hard IO failure degrades to empty context with error surfaced', () => {
  const sessionId = 'io-broken-session'
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  // A DIRECTORY at the session file path makes readFileSync throw EISDIR —
  // the "file exists but unreadable" class of failure.
  mkdirSync(persist.getFilePath(), { recursive: true })

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 0, 'nothing restored')
  assert.ok(info.error, 'error is surfaced instead of thrown')
  assert.equal(session.getMessages().length, 0, 'context left empty, session still buildable')
})

test('restoreHistoryMessages: appends disk reconciliation note after a crash', () => {
  const sessionId = 'disk-reconcile-session'
  const cwd = join(tmpDir, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'fresh-product.ts'), 'export const done = true\n', 'utf-8')

  const persist = new SessionPersist(sessionId, cwd)
  persist.initMetadata({ cleanExit: false, updatedAt: Date.now() - 1_000 })
  const seed: OaiMessage[] = [
    { role: 'user', content: 'do work' },
    { role: 'assistant', content: 'doing work' },
  ]
  writeFileSync(persist.getFilePath(), seed.map(m => appendChecksum(JSON.stringify(m)) + '\n').join(''), 'utf8')

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session, cwd)

  assert.equal(info.restored, 3, 'two history messages + one reconciliation note')
  const msgs = session.getMessages()
  const last = msgs.at(-1)!
  assert.equal(last.role, 'user')
  assert.match(String(last.content), /fresh-product\.ts/)
  assert.match(String(last.content), /read_file/)
})

test('restoreHistoryMessages: a second crash recovery appends without changing the persisted reconciliation note', async () => {
  const sessionId = 'disk-reconcile-repeat'
  const cwd = join(tmpDir, 'work-repeat')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'first-product.ts'), 'first\n')
  const persist = new SessionPersist(sessionId, cwd)
  persist.initMetadata({ cleanExit: false, updatedAt: Date.now() - 1_000 })
  writeFileSync(persist.getFilePath(), [
    { role: 'user', content: 'do work' },
    { role: 'assistant', content: 'doing work' },
  ].map(m => appendChecksum(JSON.stringify(m)) + '\n').join(''), 'utf8')

  const first = new SessionContext()
  restoreHistoryMessages(persist, first, cwd)
  await persist.compactOaiAsync(first.getMessages(), true)
  writeFileSync(join(cwd, 'second-product.ts'), 'second\n')

  const second = new SessionContext()
  restoreHistoryMessages(persist, second, cwd)
  const notes = second.getMessages().filter((message): message is Extract<OaiMessage, { role: 'user' }> => message.role === 'user'
    && typeof message.content === 'string' && message.content.startsWith('<system-reminder>\n【磁盘对账】以下文件在会话记录之外被近期修改'))
  assert.equal(notes.length, 2)
  assert.deepEqual(second.getMessages().slice(0, first.getMessages().length), first.getMessages())
  assert.match(String(notes[1]!.content), /first-product\.ts/)
  assert.match(String(notes[1]!.content), /second-product\.ts/)
  assert.equal(notes[1]!.origin, 'hook')
})

test('restoreHistoryMessages: preserves stale reconciliation notes and normal user messages', () => {
  const sessionId = 'disk-reconcile-stale'
  const cwd = join(tmpDir, 'work-stale')
  mkdirSync(cwd, { recursive: true })
  const oldNote = formatDiskReconciliationNote([{ path: 'gone.ts', bytes: 4, mtimeMs: Date.now() - 60_000 }])!
  const ordinary: OaiMessage[] = [
    { role: 'user', content: 'Keep this ordinary mention of 【磁盘对账】.' },
    { role: 'user', content: '<system-reminder>\n【磁盘对账】user-authored text</system-reminder>' },
    { role: 'assistant', content: 'preserve this answer' },
  ]
  const persist = new SessionPersist(sessionId, cwd)
  persist.initMetadata({ cleanExit: false, updatedAt: Date.now() - 1_000 })
  writeFileSync(persist.getFilePath(), [ordinary[0]!, { role: 'user', content: oldNote }, ...ordinary.slice(1)]
    .map(m => appendChecksum(JSON.stringify(m)) + '\n').join(''), 'utf8')

  const session = new SessionContext()
  restoreHistoryMessages(persist, session, cwd)
  assert.deepEqual(session.getMessages(), [ordinary[0]!, { role: 'user', content: oldNote }, ...ordinary.slice(1)])
})

test('prepareRecoveredMessagesAsync: repeated recovery appends the current note and incomplete warning', async () => {
  const sessionId = 'async-disk-reconcile-repeat'
  const cwd = join(tmpDir, 'work-async-repeat')
  mkdirSync(cwd, { recursive: true })
  for (let index = 0; index < 9; index++) writeFileSync(join(cwd, `product-${index}.ts`), `${index}\n`)
  const warning = 'Disk reconciliation is incomplete; verify existing work before repeating any external operation.'
  const oldNote = formatDiskReconciliationNote([{ path: 'old-product.ts', bytes: 4, mtimeMs: Date.now() - 60_000 }])!
  const persist = new SessionPersist(sessionId, cwd)
  persist.initMetadata({ cleanExit: false, updatedAt: Date.now() - 1_000 })
  writeFileSync(persist.getFilePath(), [
    { role: 'user', content: 'keep this human message' },
    { role: 'user', content: oldNote },
    { role: 'assistant', content: 'preserve this answer' },
    { role: 'system', content: warning },
  ].map(m => appendChecksum(JSON.stringify(m)) + '\n').join(''), 'utf8')

  const messages = await prepareRecoveredMessagesAsync(persist, cwd)
  const notes = messages.filter(message => message.role === 'user' && typeof message.content === 'string'
    && message.content.startsWith('<system-reminder>\n【磁盘对账】以下文件在会话记录之外被近期修改'))
  assert.equal(notes.length, 2)
  assert.equal(notes[0]!.content, oldNote)
  assert.match(String(notes[1]!.content), /product-7\.ts/)
  assert.doesNotMatch(String(notes[1]!.content), /old-product\.ts/)
  assert.equal(messages.filter(message => message.role === 'system' && message.content === warning).length, 2)
  assert.ok(messages.some(message => message.role === 'user' && message.content === 'keep this human message'))
  assert.ok(messages.some(message => message.role === 'assistant' && message.content === 'preserve this answer'))
})

test('restoreHistoryMessages: handles tool_call/tool_result pairs correctly', () => {
  const sessionId = 'tool-session'
  const seed: OaiMessage[] = [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/tmp/a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
    { role: 'assistant', content: 'The file contains...' },
  ]
  seedSession(sessionId, seed)

  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 4, 'all 4 messages restored including tool exchange')
  const msgs = session.getMessages()
  const assistant = msgs[1]!
  assert.ok(isAssistantWithTools(assistant), 'second message restored as assistant with tool_calls')
  assert.equal(assistant.tool_calls.length, 1)
  assert.equal(msgs[2]!.role, 'tool')
  assert.equal(msgs[2]!.tool_call_id, 'call_1')
})

test('restoreHistoryMessages: records transcript watermark alignment (observation only)', () => {
  const sessionId = '11111111-2222-3333-4444-555555555555'
  seedSession(sessionId, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ])
  const persist = new SessionPersist(sessionId, '/fake-cwd')

  // 对齐：检查点水位 ≤ 实际条数
  const ok = restoreHistoryMessages(persist, new SessionContext(), undefined, 2)
  assert.equal(ok.transcriptAligned, true)
  assert.equal(ok.expectedTranscriptWatermark, 2)
  assert.equal(ok.restored, 2, '观测不影响恢复结果')

  // 不对齐：检查点引用了转录里没有的历史 → 只标记，消息照常恢复
  const bad = restoreHistoryMessages(persist, new SessionContext(), undefined, 9)
  assert.equal(bad.transcriptAligned, false)
  assert.equal(bad.expectedTranscriptWatermark, 9)
  assert.equal(bad.restored, 2, '不对齐也不改恢复结果（第 2 步只观测）')

  // 不传期望 → 无从比较
  const none = restoreHistoryMessages(persist, new SessionContext())
  assert.equal(none.transcriptAligned, undefined)
})

test('restoreHistoryMessages: structured mode surfaces uncertain tools (UI 待确认)', () => {
  const sessionId = '99999999-8888-7777-6666-555555555555'
  seedSession(sessionId, [
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
    },
  ])
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  process.env.RIVET_RECOVERY_STRUCTURED_TOOLS = '1'
  try {
    const info = restoreHistoryMessages(persist, new SessionContext())
    assert.deepEqual(info.uncertainTools, [{ id: 'c1', name: 'write_file' }], '注入的工具要回传给 UI')
    // user + assistant(tool_call) + 注入的 tool 消息 = 3
    assert.equal(info.restored, 3)
  } finally {
    delete process.env.RIVET_RECOVERY_STRUCTURED_TOOLS
  }
  // 默认模式不影响：不再回传 uncertainTools
  const plain = restoreHistoryMessages(persist, new SessionContext())
  assert.equal(plain.uncertainTools, undefined)
})

test('describeRestore：待确认工具与水位观测都在收口处', async () => {
  const sessionId = 'describe-restore-uncertain'
  const persist = new SessionPersist(sessionId, '/fake-cwd', { recoveryStructuredTools: true })
  await persist.appendOaiWithChecksum(
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
    { flush: true },
  )
  persist.loadOai() // 真实路径一致：解析时做结构化注入，才有 uncertain 可回传
  assert.equal(persist.getLastInjectedUncertain().length, 1, '前置：结构化注入应已发生')

  const misaligned = describeRestore(persist, 3, 5)
  assert.deepEqual(misaligned.uncertainTools?.map((x) => x.id), ['c1'], '待确认工具必须回传')
  assert.equal(misaligned.transcriptAligned, false, '检查点水位 5 > 实际 3 → 必须跑对齐检查')
  assert.equal(misaligned.expectedTranscriptWatermark, 5)

  const aligned = describeRestore(persist, 5, 5)
  assert.equal(aligned.transcriptAligned, true)
  assert.deepEqual(aligned.uncertainTools?.map((x) => x.id), ['c1'], '水位对齐时也要带待确认工具')

  const noExpectation = describeRestore(persist, 2)
  assert.equal(noExpectation.transcriptAligned, undefined, '未传期望水位就不做对齐判定')
  assert.deepEqual(noExpectation.uncertainTools?.map((x) => x.id), ['c1'])
})

test('resolveHistoryRestore：桌面异步预取路径（prepared）同样收口待确认与水位', async () => {
  // P2 的回归钉：这条分支决策此前写成 `prepared ? { restored } : restoreHistoryMessages(...)`，
  // 于是桌面真实路径丢了两样东西。把 prepared 分支改回裸 { restored }，本用例即红。
  const sessionId = 'prepared-path-restore'
  const persist = new SessionPersist(sessionId, '/fake-cwd', { recoveryStructuredTools: true })
  await persist.appendOaiWithChecksum(
    { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { flush: true },
  )
  await persist.loadOaiAsync() // 模拟 buildManagedAgentAsync 的预取

  const session = new SessionContext()
  const info = resolveHistoryRestore(persist, session, { messages: persist.loadOai() }, '/fake-cwd', 7)

  assert.deepEqual(info.uncertainTools?.map((x) => x.id), ['c9'], 'prepared 路径必须回传待确认工具')
  assert.equal(info.transcriptAligned, false, 'prepared 路径必须跑转录水位对齐检查')
  assert.equal(info.expectedTranscriptWatermark, 7)
  assert.ok(session.getMessages().length > 0, 'prepared 的消息仍须装进上下文')

  // 反面对照：非 prepared 走同步恢复路径，同样收口。
  const session2 = new SessionContext()
  const sync = resolveHistoryRestore(persist, session2, undefined, '/fake-cwd', 7)
  assert.deepEqual(sync.uncertainTools?.map((x) => x.id), ['c9'])
  assert.equal(sync.transcriptAligned, false)
})
