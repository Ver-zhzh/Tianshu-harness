import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager, type ManagedAgent, type AgentFactory } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { SessionRecord } from '../protocol.js'

test('creation is idle until send, targets lock at first send, and persisted restrictions survive restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'creator-session-')), cwd = join(root, 'project'); mkdirSync(cwd)
  process.env.RIVET_HOME = join(root, 'home'); process.env.RIVET_SESSION_DIR = join(root, 'cli-sessions')
  process.env.RIVET_TRUST_PROJECT = '1'
  let finish: (() => void) | undefined
  let calls = 0, tools: string[] | undefined, callbacks: AgentCallbacks | undefined
  const createAgent: AgentFactory = (_cwd, _id, _approval, _model, allowed) => {
    tools = allowed
    return { run: (_p: string, cb: AgentCallbacks) => { calls++; callbacks = cb; return new Promise<void>(resolve => { finish = resolve }) }, abort() {} } as ManagedAgent
  }
  const persistence = new FileSessionPersistence(join(root, 'server'))
  const manager = new RuntimeSessionManager({ createAgent, defaultCwd: cwd, persistence })
  const router = createRouter(buildSessionRoutes(manager, 'fixture')), auth = { authorization: 'Bearer fixture' }
  const input = { scope: 'project', cwd, initialInput: '/skill skill-creator Help me create a skill.' }
  const response = await router('POST', '/sessions', { skillCreation: input }, auth)
  assert.equal(response.status, 201)
  const session = response.body as SessionRecord
  assert.equal(calls, 0); assert.equal(session.status, 'idle')
  assert.deepEqual(session.allowedTools, ['skill', 'ask_user_question', 'read_file', 'glob', 'grep'])
  assert.equal((await router('POST', '/sessions', { skillCreation: input, prompt: 'start now' }, auth)).status, 400)
  assert.equal((await router('PUT', `/sessions/${session.id}/skill-creation`, { ...input, scope: 'personal' }, auth)).status, 200)
  assert.equal(manager.getSession(session.id)!.workspaceSource, 'scratch')
  assert.notEqual(manager.getSession(session.id)!.cwd, cwd)
  assert.equal((await router('POST', `/sessions/${session.id}/prompt`, { prompt: '/skill skill-creator Create a weekly report skill.' }, auth)).status, 200)
  for (let n = 0; n < 50 && calls === 0; n++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 1); assert.deepEqual(tools, session.allowedTools)
  assert.equal((await router('PUT', `/sessions/${session.id}/skill-creation`, input, auth)).status, 409)
  const ref = { name: 'weekly', scope: 'personal' as const, version: 'a'.repeat(64) }
  callbacks!.onToolResult('save', 'skill', 'draft saved', false, undefined, undefined, { skillDraft: ref })
  assert.deepEqual(manager.getEvents(session.id, 0)!.events.find(e => e.type === 'tool_result')?.data.skillDraft, ref)
  const restored = manager.getSession(session.id)!
  assert.equal(restored.skillCreation?.started, true)
  finish?.(); await new Promise(resolve => setTimeout(resolve, 20))
  persistence.saveRecord(restored); await persistence.flushAllAsync()
  const reloaded = new RuntimeSessionManager({ createAgent, defaultCwd: cwd, persistence })
  assert.deepEqual(reloaded.getSession(session.id)?.allowedTools, session.allowedTools)
  assert.equal(reloaded.getSession(session.id)?.skillCreation?.started, true)
})
