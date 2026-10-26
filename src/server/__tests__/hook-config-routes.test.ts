import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionRoutes } from '../session-routes.js'
import type { RuntimeSessionManager } from '../session-manager.js'
import { loadHooksConfig } from '../../hooks/user-hooks-runner.js'

test('hook config routes reject invalid budgets, preserve saved bytes and publish partial configuration atomically', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-hook-config-'))
  const previous = process.env.RIVET_TRUST_PROJECT
  process.env.RIVET_TRUST_PROJECT = '1'
  try {
    const routes = buildSessionRoutes({ getSession: () => ({ id: 'fixture', cwd }) } as unknown as RuntimeSessionManager, 'fixture')
    const put = routes['PUT /sessions/:id/hooks']!, get = routes['GET /sessions/:id/hooks']!
    const params = { id: 'fixture' }, headers = { authorization: 'Bearer fixture' }
    const hook = { event: 'preTurn', script: 'script with spaces.sh', timeoutMs: 250 }
    assert.equal((await put({ hooks: [hook] }, params, headers)).status, 200)
    const saved = await readFile(join(cwd, '.rivet/hooks.json'), 'utf8')
    for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, '5', null, true]) {
      assert.equal((await put({ hooks: [{ ...hook, timeoutMs }] }, params, headers)).status, 400)
      assert.equal(await readFile(join(cwd, '.rivet/hooks.json'), 'utf8'), saved)
    }
    assert.equal((await put({ hooks: [hook] }, params, {})).status, 401)
    assert.deepEqual((await get({}, params, headers)).body, { hooks: [hook] })
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [hook, { ...hook, timeoutMs: 0 }] }))
    const config = await loadHooksConfig(cwd)
    assert.deepEqual(config.hooks, [hook]); assert.equal(config.diagnostics?.length, 1)
    await writeFile(join(cwd, '.rivet/hooks.json'), ' '.repeat(262_145))
    assert.equal((await loadHooksConfig(cwd)).hooks.length, 0)
    assert.match((await loadHooksConfig(cwd)).diagnostics?.[0] ?? '', /256KiB/)
    await mkdir(join(cwd, '.rivet', 'unused'), { recursive: true })
  } finally {
    if (previous === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = previous
    await rm(cwd, { recursive: true, force: true })
  }
})
