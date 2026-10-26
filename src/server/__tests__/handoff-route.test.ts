import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import { readFactHandoff } from '../../agent/fact-handoff.js'

test('real HTTP handoff defaults to facts without constructing/running an agent; narrative is isolated', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-route-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  const auth = { authorization: 'Bearer fixture' }
  let constructions = 0, runs = 0, lastPrompt = '', finish: (() => void) | undefined
  const agent: ManagedAgent = {
    run: (prompt: string, _cb: AgentCallbacks) => { runs++; lastPrompt = prompt; return new Promise<void>(resolve => { finish = resolve }) },
    abort() { finish?.() }, setActivePlan() {}, listArtifacts: () => [], readArtifact: async () => null,
    getMessages: () => [], replaceMessages() {}, rewindToMessages() {},
  }
  const manager = new RuntimeSessionManager({ createAgent: () => { constructions++; return agent }, defaultCwd: cwd })
  const router = createRouter(buildSessionRoutes(manager, 'fixture'))
  try {
    assert.equal((await router('POST', '/sessions/missing/handoff', {}, auth)).status, 404)
    const session = (await router('POST', '/sessions', { cwd }, auth)).body as { id: string }
    const baseline = constructions
    const result = await router('POST', `/sessions/${session.id}/handoff`, { note: 'Keep scope' }, auth)
    assert.equal(result.status, 200)
    const archived = (result.body as { handoff?: { snapshotId?: string; narrative?: string } }).handoff
    assert.match(archived?.snapshotId ?? '', /^[a-f0-9]{64}$/, 'default handoff reports the archived snapshot id')
    assert.equal(archived?.narrative, 'none', 'no narrative requested reports none instead of implying a run')
    assert.equal(constructions, baseline); assert.equal(runs, 0)
    const snapshot = readFactHandoff(cwd, session.id)
    assert.match(snapshot.sections.notes!.join(), /Keep scope/)
    assert.equal(existsSync(join(cwd, '.rivet/HANDOFF.md')), false)
    const narrated = await router('POST', `/sessions/${session.id}/handoff`, { narrative: true }, auth)
    assert.equal(narrated.status, 200)
    assert.equal((narrated.body as { handoff?: { narrative?: string } }).handoff?.narrative, 'started')
    for (let i = 0; i < 10 && !lastPrompt; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(runs, 1)
    const source = lastPrompt.split('\n').map(line => line.trim()).find(line => line.startsWith(cwd) && line.endsWith('.md'))!
    assert.ok(source.includes(`HANDOFF-${session.id}-`), lastPrompt)
    assert.equal((await router('POST', `/sessions/${session.id}/handoff`, {}, auth)).status, 409)
    mkdirSync(join(cwd, '.rivet'), { recursive: true }); writeFileSync(source, 'Model narrative')
    finish?.(); await new Promise(resolve => setTimeout(resolve, 30))
    assert.match(readFactHandoff(cwd, session.id).sections.narrative!.join(), /未独立核验.*\nModel narrative/)
    assert.ok(manager.getEvents(session.id)!.events.some(e => e.type === 'handoff_archived' && String(e.data.text).includes('归档')))
    const target = (await router('POST', '/sessions', { cwd }, auth)).body as { id: string }
    const before = constructions
    assert.equal((await router('GET', `/sessions/${target.id}/handoffs`, {}, {})).status, 401)
    assert.equal((await router('GET', `/sessions/${target.id}/handoffs`, {}, auth)).status, 200)
    const preview = await router('GET', `/sessions/${target.id}/handoffs/${session.id}`, {}, auth)
    assert.equal(preview.status, 200)
    assert.equal(constructions, before, 'preview must not construct an agent')
    const pinned = (preview.body as { snapshotId: string }).snapshotId
    const selected = await router('POST', `/sessions/${target.id}/prompt`, { prompt: `/handoff read ${session.id} --snapshot ${pinned}` }, auth)
    assert.equal(selected.status, 200)
    for (let i = 0; i < 10 && !lastPrompt.includes(pinned); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(lastPrompt, new RegExp(pinned))
    assert.match(lastPrompt, /不启动测试、审查或写入/)
    assert.ok(!lastPrompt.includes('Model narrative'), 'brief does not silently expand narrative')
    finish?.(); await new Promise(resolve => setTimeout(resolve, 30))

  } finally { finish?.(); if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(cwd, { recursive: true, force: true }) }
})

test('a refused or failed narrative launch preserves archive success and discloses the skipped result through HTTP and slash events', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-skipped-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  const manager = new RuntimeSessionManager({ defaultCwd: cwd, createAgent: () => { throw Error('no model may be constructed') } })
  const router = createRouter(buildSessionRoutes(manager, 'fixture')), auth = { authorization: 'Bearer fixture' }
  let attempts = 0
  try {
    const session = manager.createSession({ cwd })
    manager.run = () => { attempts++; return false }
    const reply = await router('POST', `/sessions/${session.id}/handoff`, { narrative: true }, auth)
    assert.equal(reply.status, 200)
    const result = (reply.body as { handoff: { archived: boolean; snapshotId: string; narrative: string; reason: string } }).handoff
    assert.equal(result.archived, true); assert.equal(result.narrative, 'skipped')
    assert.equal(readFactHandoff(cwd, session.id, result.snapshotId).snapshotId, result.snapshotId)
    assert.ok(result.reason)
    const slash = await router('POST', `/sessions/${session.id}/prompt`, { prompt: '/handoff --narrative' }, auth)
    assert.equal(slash.status, 200)
    assert.equal((slash.body as { handoff: { narrative: string } }).handoff.narrative, 'skipped')
    manager.run = () => { attempts++; throw Error('launch exception fixture') }
    const thrown = await router('POST', `/sessions/${session.id}/handoff`, { narrative: true }, auth)
    assert.equal(thrown.status, 200)
    assert.match((thrown.body as { handoff: { reason: string } }).handoff.reason, /launch exception fixture/)
    const notices = manager.getEvents(session.id)!.events.filter(e => e.type === 'intent_note' && String(e.data.text).includes('模型叙述未启动'))
    assert.equal(notices.length, 3)
    assert.ok(notices.every(e => String(e.data.text).includes('未自动重试')))
    assert.equal(attempts, 3, 'exactly one launch attempt per explicit request')
  } finally {
    await manager.shutdownAll()
    if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior
    rmSync(cwd, { recursive: true, force: true })
  }
})
